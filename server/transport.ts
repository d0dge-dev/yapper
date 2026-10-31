// Which way a call's audio travels, so CallSession doesn't have to care.
//
// The control protocol (JSON) always runs over the /call WebSocket. Audio starts there too
// (binary Int16 frames), and moves to WebRTC (Opus over SRTP/UDP, straight to this host)
// once the client has negotiated a peer connection over the same WebSocket:
//
//   client → {type:"rtc_offer", sdp}     server → {type:"rtc_answer", sdp} | {type:"rtc_error", message}
//   client → {type:"rtc_close"}          (gave up on ICE or lost it: back to WebSocket audio)
//   server → {type:"rtc_playing", on}    (the RTP stream carries speech right now; drives the "speaking" UI)

import type { WebSocket } from "ws";
import { WsAudio } from "./transport-ws.ts";
import { RtcAudio, type RtcConfig } from "./transport-rtc.ts";

/** Mic audio, 16 kHz mono. */
export type AudioSink = (samples: Float32Array) => void;

export interface AudioTransport {
  readonly kind: "ws" | "rtc";
  /** Queues TTS audio for playback, in real time. */
  play(samples: Float32Array, sampleRate: number): void;
  /** Drops whatever is queued (barge-in, hush). */
  stop(): void;
  close(): void;
}

type Log = (msg: string) => void;

/** The call's audio: WebSocket by default, WebRTC once connected. */
export class AudioLink {
  /** Set by the call session. */
  onAudio: AudioSink = () => {};
  private readonly ws: WebSocket;
  private readonly rtcConfig: RtcConfig | null;
  private readonly log: Log;
  private readonly wsAudio: WsAudio;
  private rtc: RtcAudio | null = null;
  private closed = false;

  constructor(ws: WebSocket, rtcConfig: RtcConfig | null, log: Log) {
    this.ws = ws;
    this.rtcConfig = rtcConfig;
    this.log = log;
    this.wsAudio = new WsAudio(ws, (s) => this.onAudio(s));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string; sdp?: string };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "rtc_offer") this.offer(String(msg.sdp ?? "")).catch((e) => this.fail(e));
      else if (msg.type === "rtc_close") this.dropRtc("client closed webrtc");
    });
    ws.on("close", () => this.close());
  }

  get kind(): "ws" | "rtc" {
    return this.rtc?.connected ? "rtc" : "ws";
  }

  play(samples: Float32Array, sampleRate: number): void {
    (this.rtc?.connected ? this.rtc : this.wsAudio).play(samples, sampleRate);
  }

  stop(): void {
    this.wsAudio.stop();
    this.rtc?.stop();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dropRtc();
    this.wsAudio.close();
  }

  private send(msg: object): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async offer(sdp: string): Promise<void> {
    if (!this.rtcConfig) return this.send({ type: "rtc_error", message: "webrtc disabled on this server" });
    this.dropRtc();
    const rtc = new RtcAudio(this.rtcConfig, (s) => this.onAudio(s), this.log);
    this.rtc = rtc;
    rtc.onPlaying = (on) => this.send({ type: "rtc_playing", on });
    rtc.onConnected = (pair) => this.log(`audio via webrtc (${pair})`);
    rtc.onLost = () => {
      if (this.rtc !== rtc) return;
      this.dropRtc("ice lost");
    };
    const answer = await rtc.answer(sdp);
    if (this.rtc === rtc && !this.closed) this.send({ type: "rtc_answer", sdp: answer });
  }

  private dropRtc(why?: string): void {
    if (!this.rtc) return;
    const wasConnected = this.rtc.connected;
    this.rtc.close();
    this.rtc = null;
    if (why && wasConnected) this.log(`audio via websocket (${why})`);
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log(`webrtc: ${message}`);
    this.dropRtc();
    this.send({ type: "rtc_error", message });
  }
}
