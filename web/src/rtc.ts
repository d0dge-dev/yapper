// WebRTC audio for a call: the mic goes out as Opus over SRTP/UDP straight to the Yapper host (not
// through the reverse proxy), replies come back the same way and play through an <audio> element, which Chrome's
// echo canceller handles better than Web Audio. Signaling runs over the call's WebSocket:
//   → {type:"rtc_offer", sdp}   ← {type:"rtc_answer", sdp} | {type:"rtc_error", message}
//   → {type:"rtc_close"}        ← {type:"rtc_playing", on}
// If ICE doesn't connect within a few seconds the call keeps using WebSocket audio.

/** `localStorage["yap.audio"] = "ws"` forces WebSocket audio (debugging). */
export const rtcWanted = () => typeof RTCPeerConnection !== "undefined" && localStorage.getItem("yap.audio") !== "ws";

export class RtcAudio {
  readonly pc: RTCPeerConnection;
  readonly el: HTMLAudioElement;
  /** The server's RTP stream carries speech right now. */
  playing = false;
  remote: MediaStream | null = null;
  /** Speaking state or remote stream changed. */
  onChange: () => void = () => {};
  /** ICE gave up mid-call: switch back to WebSocket audio. */
  onLost: () => void = () => {};

  private readonly send: (msg: object) => void;
  private answered: ((sdp: string | null) => void) | null = null;
  private closed = false;
  private lostTimer = 0;

  constructor(send: (msg: object) => void, mic: MediaStream) {
    this.send = send;
    this.pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    this.el = new Audio();
    this.el.autoplay = true;
    const [track] = mic.getAudioTracks();
    this.pc.addTransceiver(track, { direction: "sendrecv", streams: [mic] });
    this.pc.ontrack = (e) => {
      this.remote = e.streams[0] ?? new MediaStream([e.track]);
      this.el.srcObject = this.remote;
      this.el.play().catch(() => {});
      this.onChange();
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "connected") clearTimeout(this.lostTimer);
      else if (s === "failed") this.lose();
      else if (s === "disconnected") this.lostTimer = window.setTimeout(() => this.lose(), 4000);
    };
  }

  /** Offer → answer → ICE connected, or false within `timeoutMs` (then this is closed). */
  async connect(timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this.gathered(Math.min(1500, timeoutMs / 2));
      const answer = new Promise<string | null>((r) => (this.answered = r));
      this.send({ type: "rtc_offer", sdp: this.pc.localDescription!.sdp });
      const sdp = await Promise.race([answer, sleep(deadline - Date.now()).then(() => null)]);
      if (!sdp || this.closed) throw new Error("no answer");
      await this.pc.setRemoteDescription({ type: "answer", sdp });
      const ok = await new Promise<boolean>((resolve) => {
        const check = () => {
          const s = this.pc.connectionState;
          if (s === "connected") resolve(true);
          else if (s === "failed" || s === "closed" || this.closed) resolve(false);
        };
        this.pc.addEventListener("connectionstatechange", check);
        check();
        setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
      });
      if (!ok) throw new Error("ice did not connect");
      return true;
    } catch (e) {
      console.info(`webrtc: ${(e as Error).message}, using websocket audio`);
      this.close();
      return false;
    }
  }

  /** Handles rtc_* messages from the call's WebSocket. */
  signal(msg: { type: string; sdp?: string; on?: boolean; message?: string }): void {
    if (msg.type === "rtc_answer") this.answered?.(msg.sdp ?? null);
    else if (msg.type === "rtc_error") this.answered?.(null);
    else if (msg.type === "rtc_playing") {
      this.playing = !!msg.on;
      this.onChange();
    }
  }

  /** Host candidates are enough on the LAN/tailnet; don't wait long for the rest. */
  private gathered(ms: number): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => this.pc.iceGatheringState === "complete" && resolve();
      this.pc.addEventListener("icegatheringstatechange", done);
      setTimeout(resolve, ms);
    });
  }

  private lose(): void {
    if (this.closed) return;
    this.close();
    this.onLost();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lostTimer);
    this.answered?.(null);
    this.send({ type: "rtc_close" });
    this.pc.close();
    this.el.srcObject = null;
    this.playing = false;
  }
}

// ------------------------------------------------------------------ levels (both transports)

/** RMS level 0..1 of whatever is connected to `node`, for animating the UI. */
export class Meter {
  readonly node: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private smooth = 0;
  constructor(ctx: BaseAudioContext) {
    this.node = ctx.createAnalyser();
    this.node.fftSize = 512;
    this.buf = new Float32Array(this.node.fftSize);
  }
  level(): number {
    this.node.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const s of this.buf) sum += s * s;
    // Speech RMS sits around 0.02–0.2; scale so normal speech fills most of 0..1, then smooth the decay.
    const now = Math.min(1, Math.sqrt(sum / this.buf.length) * 5);
    this.smooth = now > this.smooth ? now : this.smooth * 0.85 + now * 0.15;
    return this.smooth;
  }
}

const meters: { mic: Meter | null; out: Meter | null } = { mic: null, out: null };
export function setMeters(m: Partial<typeof meters>) {
  Object.assign(meters, m);
}

/** Mic and call audio levels (0..1), e.g. polled per animation frame for a glow. Zero outside a call. */
export function getLevels(): { mic: number; out: number } {
  return { mic: meters.mic?.level() ?? 0, out: meters.out?.level() ?? 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
