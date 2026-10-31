// Runs the browser's WebRTC code (web/src/rtc.ts) in Node through werift's DOM polyfill, against a
// running server: offer/answer, ICE, remote track, rtc_playing, and the fallback paths. No mic audio.
//
//   node scripts/rtc-client-smoke.ts <threadId>       # expect "connect true" and a playing toggle
//   (server with YAP_RTC=0, or YAP_RTC_IPS=192.0.2.1) # expect "connect false" (no answer / ICE timeout)
import { installPolyfill, createDummyRegister } from "werift/polyfill";
import { WebSocket } from "ws";
installPolyfill({ mediaRegister: [createDummyRegister()], peerConnectionConfig: { iceServers: [{ urls: "stun:127.0.0.1:9" }], iceStunGatherTimeout: 0.3 } as any });
const g = globalThis as any;
g.window = globalThis;
g.localStorage = { getItem: () => null };
g.Audio = class { autoplay = false; srcObject: unknown = null; play() { return Promise.resolve(); } };
const { RtcAudio, rtcWanted } = await import("../web/src/rtc.ts");
console.log("rtcWanted", rtcWanted());
const mic = await g.navigator.mediaDevices.getUserMedia({ audio: true });
const ws = new WebSocket(`ws://127.0.0.1:${process.env.YAP_PORT ?? 8792}/call`);
await new Promise((r) => ws.once("open", r));
const rtc = new RtcAudio((m: object) => ws.send(JSON.stringify(m)), mic);
let plays = 0;
rtc.onChange = () => { if (rtc.playing) plays++; console.log("change: playing", rtc.playing, "remote", !!rtc.remote); };
ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (String(m.type).startsWith("rtc_")) rtc.signal(m); else if (m.type === "say") console.log("say", m.text); });
const t = performance.now();
const ok = await rtc.connect(Number(process.env.TIMEOUT ?? 4000));
console.log("connect", ok, `${(performance.now() - t).toFixed(0)} ms`);
if (ok) {
  ws.send(JSON.stringify({ type: "start", threadId: process.argv[2], settings: { lang: "de" } }));
  await new Promise((r) => setTimeout(r, 6000));
  console.log("playing toggles:", plays);
}
rtc.close();
ws.close();
setTimeout(() => process.exit(0), 300);
