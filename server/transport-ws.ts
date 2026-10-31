// Audio over the /call WebSocket: binary Int16 frames, 16 kHz in, TTS sample rate out
// (announced by the `say` message before each sentence). The fallback when WebRTC doesn't connect.

import type { WebSocket } from "ws";
import type { AudioSink, AudioTransport } from "./transport.ts";
import { float32ToInt16, int16ToFloat32 } from "./audio.ts";

export class WsAudio implements AudioTransport {
  readonly kind = "ws";
  private readonly ws: WebSocket;

  constructor(ws: WebSocket, onAudio: AudioSink) {
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      if (isBinary) onAudio(int16ToFloat32(data as Buffer));
    });
  }

  /** Sent as one burst; the client's player schedules it. */
  play(samples: Float32Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(float32ToInt16(samples));
  }

  /** The client drops its queue on `stop_audio`; nothing is buffered here. */
  stop(): void {}

  close(): void {}
}
