// Audio over WebRTC: Opus over SRTP/UDP, straight between the phone and this host (never
// through the reverse proxy). Signaling runs over the /call WebSocket (see transport.ts).
//
// - werift (pure TypeScript WebRTC stack): no native build, no install scripts. Runs as ICE-lite
//   with host candidates only, so there's no STUN/TURN and no outbound lookups; the phone is the
//   full ICE agent and finds us on the LAN or tailnet address.
// - opusscript (libopus compiled to WASM): decodes the mic straight to 16 kHz for VAD/ASR, encodes
//   TTS at 48 kHz in 20 ms frames.
// - Playback is paced in real time (one RTP packet per 20 ms), so `playingUntil` in the call stays
//   right and stop() cuts playback at once: queued audio is dropped, nothing has been sent ahead.

import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, type RTCRtpTransceiver } from "werift";
import type { AudioSink, AudioTransport } from "./transport.ts";
import { int16ToFloat32, resampleSinc } from "./audio.ts";

const require = createRequire(import.meta.url);
const OpusScript = require("opusscript");

export interface RtcConfig {
  /** Addresses offered as host candidates (LAN, tailnet). */
  ips: string[];
  /** Optional fixed UDP port range for ICE, e.g. for a firewall rule. */
  ports?: [number, number];
}

/**
 * YAP_RTC=0 turns WebRTC off (WebSocket audio only).
 * YAP_RTC_IPS=192.168.1.20,100.64.0.20 (default: every non-loopback IPv4 address of this host).
 * YAP_RTC_PORTS=40000-40100 (default: random ports).
 */
export function rtcConfigFromEnv(env: Record<string, string | undefined>): RtcConfig | null {
  if (env.YAP_RTC === "0") return null;
  let ips = (env.YAP_RTC_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ips.length === 0)
    ips = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal)
      .map((a) => a!.address);
  const m = (env.YAP_RTC_PORTS ?? "").match(/^(\d+)\s*-\s*(\d+)$/);
  return { ips, ports: m ? [Number(m[1]), Number(m[2])] : undefined };
}

const RATE = 48000;
const FRAME = 960; // 20 ms at 48 kHz
const FRAME_MS = 20;
const ASR_RATE = 16000;
const OPUS_PT = 111;
const BITRATE = 32000;
/** "Not playing" once the stream has carried silence this long; bridges the gaps between sentences. */
const PLAYING_HANGOVER_FRAMES = 15;

type Log = (msg: string) => void;

export class RtcAudio implements AudioTransport {
  readonly kind = "rtc";
  connected = false;
  onPlaying: (on: boolean) => void = () => {};
  onConnected: (pair: string) => void = () => {};
  onLost: () => void = () => {};

  private readonly config: RtcConfig;
  private readonly onAudio: AudioSink;
  private readonly log: Log;
  private pc: RTCPeerConnection | null = null;
  private transceiver: RTCRtpTransceiver | null = null;
  private readonly enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  private readonly dec = new OpusScript(ASR_RATE, 1, OpusScript.Application.VOIP);
  private closed = false;
  private lostTimer: NodeJS.Timeout | null = null;

  // Sending: 48 kHz PCM waiting to be paced out.
  private queue: Float32Array[] = [];
  private queueOffset = 0;
  private seq = Math.floor(Math.random() * 0x10000);
  private timestamp = Math.floor(Math.random() * 0x1_0000_0000);
  private timer: NodeJS.Timeout | null = null;
  private nextAt = 0;
  private playing = false;
  private idleFrames = 0;

  // Receiving
  private lastSeq = -1;
  private lastTs = 0;
  private lastFrame48 = FRAME;
  private stats = { rx: 0, lost: 0, late: 0, tx: 0 };
  // Outgoing speech health: gaps = silence inside a talk spurt (audio arrived too late), stalls = the event loop
  // missed the 20 ms tick by > 100 ms and frames were skipped. Both sound like a cut in the voice.
  private out = { gaps: 0, gapMaxMs: 0, gapFrames: 0, stalls: 0, stallMaxMs: 0 };
  // Arrival vs RTP clock, relative to the first packet: grows if the sender or the network falls behind.
  private firstRx: { at: number; ts: number } | null = null;
  private driftMs = 0;

  constructor(config: RtcConfig, onAudio: AudioSink, log: Log) {
    this.config = config;
    this.onAudio = onAudio;
    this.log = log;
    this.enc.setBitrate(BITRATE);
  }

  /** Takes the browser's offer, returns our answer (all candidates included, no trickle). */
  async answer(offer: string): Promise<string> {
    const pc = new RTCPeerConnection({
      iceLite: true,
      iceServers: [],
      iceUseIpv6: false,
      iceUseTcp: false,
      iceAdditionalHostAddresses: this.config.ips,
      icePortRange: this.config.ports,
      codecs: {
        audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: RATE, channels: 2, payloadType: OPUS_PT, parameters: "minptime=10;useinbandfec=1" })],
      },
      headerExtensions: { audio: [] },
    });
    this.pc = pc;
    // Added before the offer is applied, so the offer's audio m-line takes it and the answer is sendrecv.
    this.transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    pc.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => this.receive(rtp)));
    pc.connectionStateChange.subscribe((state) => this.onState(state));

    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(timer), resolve()));
      });
    return tidyAnswer(pc.localDescription!.sdp, this.config.ips);
  }

  private onState(state: string): void {
    if (this.closed) return;
    if (state === "connected") {
      if (this.lostTimer) clearTimeout(this.lostTimer);
      this.lostTimer = null;
      if (this.connected) return;
      this.connected = true;
      const pair = this.pc?.iceTransports[0]?.getSelectedCandidatePair();
      this.onConnected(pair ? `${hostPort(pair.local.candidate)} ⇄ ${hostPort(pair.remote.candidate)}` : "connected");
      this.nextAt = performance.now();
      this.tick();
    } else if (state === "failed" || state === "closed") {
      this.connected = false;
      this.onLost();
    } else if (state === "disconnected" && !this.lostTimer) {
      // Consent checks missed; give it a moment to come back (Wi-Fi roaming) before falling back.
      this.lostTimer = setTimeout(() => {
        this.lostTimer = null;
        if (this.pc?.connectionState !== "connected") {
          this.connected = false;
          this.onLost();
        }
      }, 5000);
    }
  }

  // ---------------------------------------------------------------- mic in

  private receive(rtp: RtpPacket): void {
    if (this.closed || rtp.payload.length === 0) return;
    const { sequenceNumber: seq, timestamp: ts } = rtp.header;
    if (this.lastSeq >= 0) {
      const ahead = (seq - this.lastSeq) & 0xffff;
      if (ahead === 0 || ahead > 0x8000) {
        this.stats.late++;
        return; // duplicate or late; not worth a jitter buffer for ASR
      }
      this.stats.lost += ahead - 1;
      // Lost packets or DTX: fill the gap with silence so the VAD sees the pause.
      const gap48 = ((ts - this.lastTs) >>> 0) - this.lastFrame48;
      if (gap48 > 0 && gap48 < RATE * 2) this.onAudio(new Float32Array(Math.round(gap48 / (RATE / ASR_RATE))));
    }
    let pcm: Buffer;
    try {
      pcm = this.dec.decode(rtp.payload);
    } catch {
      return;
    }
    this.stats.rx++;
    if (!this.firstRx) this.firstRx = { at: performance.now(), ts };
    else this.driftMs = performance.now() - this.firstRx.at - ((ts - this.firstRx.ts) >>> 0) / (RATE / 1000);
    this.lastSeq = seq;
    this.lastTs = ts;
    this.lastFrame48 = (pcm.length / 2) * (RATE / ASR_RATE);
    this.onAudio(int16ToFloat32(pcm));
  }

  // ---------------------------------------------------------------- speech out

  play(samples: Float32Array, sampleRate: number): void {
    if (this.closed) return;
    this.queue.push(resampleSinc(samples, sampleRate, RATE));
  }

  stop(): void {
    this.queue = [];
    this.queueOffset = 0;
    if (this.playing) {
      this.playing = false;
      this.onPlaying(false);
    }
  }

  /** One frame every 20 ms, on the wall clock; after a stall it resumes instead of bursting. */
  private tick(): void {
    if (this.closed) return;
    const now = performance.now();
    if (now - this.nextAt > 100) {
      if (this.playing) {
        this.out.stalls++;
        this.out.stallMaxMs = Math.max(this.out.stallMaxMs, now - this.nextAt);
      }
      this.nextAt = now;
    }
    while (this.nextAt <= now) {
      this.sendFrame();
      this.nextAt += FRAME_MS;
    }
    this.timer = setTimeout(() => this.tick(), Math.max(1, this.nextAt - performance.now()));
  }

  private sendFrame(): void {
    const pcm = new Int16Array(FRAME);
    let filled = 0;
    while (filled < FRAME && this.queue.length > 0) {
      const head = this.queue[0];
      const n = Math.min(FRAME - filled, head.length - this.queueOffset);
      for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, head[this.queueOffset + i]));
        pcm[filled + i] = Math.round(s < 0 ? s * 32768 : s * 32767);
      }
      filled += n;
      this.queueOffset += n;
      if (this.queueOffset >= head.length) {
        this.queue.shift();
        this.queueOffset = 0;
      }
    }
    const startOfTalk = filled > 0 && !this.playing;
    if (filled > 0) {
      if (this.playing && this.out.gapFrames > 0) {
        this.out.gaps++;
        this.out.gapMaxMs = Math.max(this.out.gapMaxMs, this.out.gapFrames * FRAME_MS);
      }
      this.out.gapFrames = 0;
      this.idleFrames = 0;
      if (!this.playing) {
        this.playing = true;
        this.onPlaying(true);
      }
    } else if (this.playing && (this.out.gapFrames++, ++this.idleFrames >= PLAYING_HANGOVER_FRAMES)) {
      this.playing = false;
      this.onPlaying(false);
    }
    // Silence is sent too (a few bytes per frame): keeps the receiver's jitter buffer and the ICE consent steady.
    const payload = this.enc.encode(Buffer.from(pcm.buffer), FRAME);
    const header = new RtpHeader({ payloadType: OPUS_PT, sequenceNumber: this.seq, timestamp: this.timestamp, marker: startOfTalk });
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + FRAME) >>> 0;
    this.stats.tx++;
    this.transceiver?.sender.sendRtp(new RtpPacket(header, payload)).catch(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.stats.rx || this.stats.tx)
      this.log(`webrtc closed: rx ${this.stats.rx} packets (${this.stats.lost} lost, ${this.stats.late} late, arrival drift ${this.driftMs.toFixed(0)} ms), tx ${this.stats.tx}` +
          ` (${this.out.gaps} gaps, max ${this.out.gapMaxMs} ms; ${this.out.stalls} stalls, max ${this.out.stallMaxMs.toFixed(0)} ms)`);
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.lostTimer) clearTimeout(this.lostTimer);
    this.pc?.close().catch(() => undefined);
    this.enc.delete();
    this.dec.delete();
  }
}

/** "candidate:1 1 udp 2130706431 192.168.1.20 40012 typ host" → "192.168.1.20:40012" */
const hostPort = (candidate: string) => candidate.split(" ").slice(4, 6).join(":");

/**
 * Keeps only host candidates on the configured addresses (werift offers every interface it finds), and
 * moves `a=ice-lite` from the media section to the session level, where RFC 8839 and Chrome expect it.
 */
function tidyAnswer(sdp: string, ips: string[]): string {
  const lines = sdp.split("\r\n").filter((line) => {
    const m = line.match(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ /);
    return (!m || ips.includes(m[1])) && line !== "a=ice-lite";
  });
  lines.splice(lines.findIndex((l) => l.startsWith("m=")), 0, "a=ice-lite");
  return lines.join("\r\n");
}
