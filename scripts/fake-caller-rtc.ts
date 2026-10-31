// End-to-end test of the call audio paths without a phone, with latency numbers.
// Speaks synthesized German into a call like a microphone would (real time), either as Opus
// over WebRTC (werift as the client, like the phone's Chrome) or as Int16 over the WebSocket.
//
//   YAP_DEV=1 npm start                                   # in one shell
//   node scripts/fake-caller-rtc.ts <threadId> [--ws]     # existing test thread
//   node scripts/fake-caller-rtc.ts --project <id> [--ws] # new thread in that project
//   … --local-only                                        # only local commands, nothing sent to the agent
//
// Measures, per local status question: end of speech → `say` message → first
// audible reply sample at the client; and for barge-in: `stop_audio` → last audible sample.
import { WebSocket } from "ws";
import { createRequire } from "node:module";
import { RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, type RTCRtpTransceiver } from "werift";
import { loadSpeech } from "../server/speech.ts";
import { int16ToFloat32, resampleSinc } from "../server/audio.ts";

const require = createRequire(import.meta.url);
const OpusScript = require("opusscript");

const args = process.argv.slice(2);
const useWs = args.includes("--ws");
const localOnly = args.includes("--local-only"); // skip the message to the agent
const projectId = args.includes("--project") ? args[args.indexOf("--project") + 1] : null;
const threadArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--project") ?? null;
if (!threadArg && !projectId) throw new Error("usage: fake-caller-rtc.ts <threadId> | --project <id>  [--ws]");
const PORT = process.env.YAP_PORT ?? 8790;

const speech = await loadSpeech();
const t0 = performance.now();
const ts = () => `${((performance.now() - t0) / 1000).toFixed(2).padStart(6)}s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- receive side bookkeeping

let agentState = "idle";
let threadId = threadArg;
let says = 0;
let lastSayAt = 0;
let lastSayText = "";
let hearingOffAt = 0; // server VAD: speech ended
let hearingOnAt = 0; // server VAD: speech started (first after a reset)
let firstVoicedSentAt = 0;
let lastStopAt = 0;
let firstAudibleAfterSay = 0; // first audible sample after the latest `say`
let lastAudibleAt = 0;
let receivedSec = 0;
let rtcPlaying = false;
const AUDIBLE = 0.01; // RMS

let wsPlayhead = 0;
let audibleSec = 0;
let agentMsgs = 0;

/** Tracks when audio becomes audible *to a listener*: RTP plays as it arrives; a WebSocket burst is
 *  scheduled back to back like the web client's Player does (30 ms lead). */
function onIncoming(samples: Float32Array, rate: number, burst: boolean) {
  receivedSec += samples.length / rate;
  const now = performance.now();
  let start = now;
  if (burst) {
    start = Math.max(now + 30, wsPlayhead);
    wsPlayhead = start + (samples.length / rate) * 1000;
  }
  const win = Math.round(rate / 100); // 10 ms windows
  for (let o = 0; o < samples.length; o += win) {
    let sum = 0;
    const end = Math.min(samples.length, o + win);
    for (let i = o; i < end; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / (end - o)) > AUDIBLE) {
      const at = start + (o / rate) * 1000;
      audibleSec += (end - o) / rate;
      lastAudibleAt = Math.max(lastAudibleAt, at);
      if (lastSayAt && !firstAudibleAfterSay) firstAudibleAfterSay = at;
    }
  }
}
/** Nothing audible for `ms` (including audio still scheduled). */
const quiet = (ms: number) => performance.now() - lastAudibleAt > ms && !rtcPlaying;

const waiters: { pred: () => boolean; resolve: () => void }[] = [];
const check = () => waiters.splice(0).forEach((w) => (w.pred() ? w.resolve() : waiters.push(w)));
setInterval(check, 20);
const until = (pred: () => boolean, timeoutMs = 120_000, what = "condition") =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
    waiters.push({ pred, resolve: () => (clearTimeout(timer), resolve()) });
    check();
  });

// ---------------------------------------------------------------- websocket (control, and audio with --ws)

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/call`);
let wsRate = 22050;
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    onIncoming(int16ToFloat32(data as Buffer), wsRate, true);
    return;
  }
  const msg = JSON.parse(String(data));
  switch (msg.type) {
    case "state":
      agentState = msg.agent;
      if (msg.threadId) threadId = msg.threadId;
      console.log(ts(), "state", msg.agent, msg.utterance ? `utterance="${msg.utterance}"` : "");
      break;
    case "say":
      says++;
      wsRate = msg.sampleRate;
      lastSayAt = performance.now();
      lastSayText = msg.text;
      firstAudibleAfterSay = 0;
      console.log(ts(), "SAY", msg.text);
      break;
    case "stop_audio":
      if (lastStopAt) break; // only the first one after a reset counts (a hush command sends another)
      lastStopAt = performance.now();
      // The web client stops its scheduled buffers right away.
      if (useWs) {
        wsPlayhead = 0;
        lastAudibleAt = Math.min(lastAudibleAt, lastStopAt);
      }
      console.log(ts(), "stop_audio");
      break;
    case "rtc_answer":
      onAnswer?.(msg.sdp);
      break;
    case "rtc_error":
      throw new Error(`rtc_error: ${msg.message}`);
    case "rtc_playing":
      rtcPlaying = msg.on;
      break;
    case "timeline":
      if (msg.role === "agent") agentMsgs++;
      console.log(ts(), "timeline", msg.role, String(msg.text).slice(0, 120));
      break;
    case "hearing":
      if (!msg.on) hearingOffAt = performance.now();
      else if (!hearingOnAt) hearingOnAt = performance.now();
      break;
    case "sending_in":
      break;
    default:
      console.log(ts(), msg.type, JSON.stringify(msg).slice(0, 200));
  }
  check();
});
await new Promise((r) => ws.once("open", r));

// ---------------------------------------------------------------- mic: 20 ms frames, silence unless talking

const FRAME48 = 960;
let talking: Float32Array | null = null; // 48 kHz
let talkPos = 0;
let lastVoicedSentAt = 0;

/** Next 20 ms of mic at 48 kHz. A real mic is never exactly silent, and Silero clips short words
 *  ("Status") that follow seconds of digital zeros, so there's a -54 dBFS noise floor. */
function micFrame(): Float32Array {
  const f = new Float32Array(FRAME48);
  for (let i = 0; i < FRAME48; i++) f[i] = (Math.random() * 2 - 1) * 0.002;
  if (talking && talkPos < talking.length) {
    const chunk = talking.subarray(talkPos, talkPos + FRAME48);
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      f[i] += chunk[i];
      peak = Math.max(peak, Math.abs(chunk[i]));
    }
    talkPos += FRAME48;
    if (peak > 0.01) {
      lastVoicedSentAt = performance.now();
      if (!firstVoicedSentAt) firstVoicedSentAt = lastVoicedSentAt;
    }
  }
  return f;
}

const toInt16 = (f: Float32Array) => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, f[i])) * 32767);
  return out;
};

let onAnswer: ((sdp: string) => void) | null = null;
let negotiationMs = 0;
let pair = "";
const t3Start = performance.now();

if (useWs) {
  // Same as the browser's worklet: 16 kHz Int16, 100 ms chunks.
  let pending: Float32Array[] = [];
  let next = performance.now();
  const loop = () => {
    while (next <= performance.now()) {
      pending.push(micFrame());
      next += 20;
      if (pending.length === 5) {
        const joined = new Float32Array(5 * FRAME48);
        pending.forEach((p, i) => joined.set(p, i * FRAME48));
        pending = [];
        const pcm16 = toInt16(resampleSinc(joined, 48000, 16000));
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(pcm16.buffer));
      }
    }
    setTimeout(loop, Math.max(1, next - performance.now()));
  };
  loop();
} else {
  const pc = new RTCPeerConnection({
    // No public STUN: an unreachable local one with a short timeout keeps werift from asking Google.
    iceServers: [{ urls: "stun:127.0.0.1:9" }],
    iceStunGatherTimeout: 0.3,
    iceUseIpv6: false,
    iceUseTcp: false,
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111, parameters: "minptime=10;useinbandfec=1" })] },
    headerExtensions: { audio: [] },
  });
  const transceiver: RTCRtpTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
  const dec = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  pc.onTrack.subscribe((track) =>
    track.onReceiveRtp.subscribe((rtp) => {
      const pcm = dec.decode(rtp.payload) as Buffer;
      onIncoming(int16ToFloat32(pcm), 48000, false);
    }),
  );
  const connected = new Promise<void>((resolve, reject) => {
    pc.connectionStateChange.subscribe((s) => {
      if (s === "connected") resolve();
      if (s === "failed") reject(new Error("ice failed"));
    });
  });
  const tOffer = performance.now();
  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== "complete") await new Promise<void>((r) => pc.iceGatheringStateChange.subscribe((s) => s === "complete" && r()));
  const answer = new Promise<string>((r) => (onAnswer = r));
  ws.send(JSON.stringify({ type: "rtc_offer", sdp: pc.localDescription!.sdp }));
  await pc.setRemoteDescription({ type: "answer", sdp: await answer });
  await Promise.race([connected, sleep(5000).then(() => Promise.reject(new Error("ice did not connect in 5 s")))]);
  negotiationMs = performance.now() - tOffer;
  const sel = pc.iceTransports[0]?.getSelectedCandidatePair();
  pair = sel ? `${sel.local.candidate.split(" ").slice(4, 6).join(":")} ⇄ ${sel.remote.candidate.split(" ").slice(4, 6).join(":")}` : "?";
  console.log(ts(), `webrtc connected in ${negotiationMs.toFixed(0)} ms (${pair})`);

  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  let seq = 1;
  let rtpTs = 1000;
  let next = performance.now();
  const loop = () => {
    while (next <= performance.now()) {
      const pcm = toInt16(micFrame());
      const payload = enc.encode(Buffer.from(pcm.buffer), FRAME48);
      transceiver.sender.sendRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq, timestamp: rtpTs }), payload)).catch(() => {});
      seq = (seq + 1) & 0xffff;
      rtpTs = (rtpTs + FRAME48) >>> 0;
      next += 20;
    }
    setTimeout(loop, Math.max(1, next - performance.now()));
  };
  loop();
}

async function talk(text: string) {
  const audio = await speech.synthesize(text, "de");
  talking = resampleSinc(audio.samples, audio.sampleRate, 48000);
  talkPos = 0;
  console.log(ts(), "YOU SAY", text);
  await until(() => talkPos >= (talking?.length ?? 0), 60_000, "talk");
  talking = null;
}

// ---------------------------------------------------------------- the call

ws.send(JSON.stringify(threadArg ? { type: "start", threadId: threadArg, settings: { lang: "de", progressAfterMs: 60_000, speakThoughts: false } } : { type: "start", projectId, projectTitle: "Yapper test", settings: { lang: "de", progressAfterMs: 60_000, speakThoughts: false } }));
await until(() => says >= 1 && firstAudibleAfterSay > 0, 30_000, "greeting");
await until(() => quiet(1500), 30_000, "greeting to finish");

type Round = { cmd: string; onset: number; vad: number; say: number; audible: number };
const rounds: Round[] = [];
async function localCommand(cmd: string) {
  await until(() => quiet(1500), 60_000, "quiet before command");
  const before = says;
  hearingOnAt = firstVoicedSentAt = 0;
  await talk(cmd);
  const end = lastVoicedSentAt;
  const onset = hearingOnAt - firstVoicedSentAt;
  await until(() => says > before && firstAudibleAfterSay > 0, 20_000, `reply to "${cmd}"`);
  const r = { cmd, onset, vad: hearingOffAt - end, say: lastSayAt - end, audible: firstAudibleAfterSay - end };
  // Only rounds answered locally count; a misheard command goes to the agent and measures the LLM instead.
  const local = /nicht beschäftigt|Arbeitet noch|isn't working|Still working/.test(lastSayText);
  if (local) rounds.push(r);
  console.log(ts(), `  ⏱ ${cmd}: onset → heard ${r.onset.toFixed(0)} ms; end of speech → VAD end ${r.vad.toFixed(0)} ms → say ${r.say.toFixed(0)} ms → first audible ${r.audible.toFixed(0)} ms${local ? "" : " (misheard, not counted)"}`);
  await until(() => quiet(1500), 60_000, "reply to finish");
}

// 1. A real message: the transcript must reach the thread, the reply must come back as audio.
const sentence = "Das ist ein Test der neuen Sprachverbindung. Antworte bitte mit drei kurzen Sätzen über das Wetter im Herbst, ohne Werkzeuge.";
let reached: boolean | undefined;
let replySec: number | undefined;
if (!localOnly) {
const tSent = performance.now();
await talk(sentence);
await until(() => agentState === "working", 30_000, "agent to start");
await until(() => agentMsgs > 0, 180_000, "agent reply");
const saysAtReply = says;
const audioBefore = audibleSec;
await until(() => says > saysAtReply && firstAudibleAfterSay > 0, 30_000, "spoken reply");
await until(() => agentState === "idle" && quiet(2000), 120_000, "reply to finish");
replySec = audibleSec - audioBefore;
const history = (await (await fetch(`http://127.0.0.1:${PORT}/api/threads/${encodeURIComponent(threadId!)}/history`)).json()) as { role: string; text: string }[];
const mine = history.filter((m) => m.role === "user").at(-1)?.text ?? "";
reached = /Sprachverbindung|Wetter/.test(mine);
console.log(ts(), `thread ${threadId}: last user message ${reached ? "OK" : "MISSING"}: ${mine.split("\n")[0].slice(0, 140)}`);
console.log(ts(), `agent turn took ${((performance.now() - tSent) / 1000).toFixed(1)} s`);
}

// 2. Barge-in: let the reply repeat, talk over it, measure how fast the audio stops.
let bargeCut = NaN;
{
  const before = says;
  await talk("Jetzt bitte mal wiederholen.");
  await until(() => says > before && firstAudibleAfterSay > 0, 20_000, "repeat");
  await sleep(800);
  lastStopAt = 0;
  const p = talk("Sei bitte still."); // a hush command, so nothing goes to the thread
  await until(() => lastStopAt > 0, 15_000, "barge-in stop_audio");
  await sleep(1500);
  bargeCut = lastAudibleAt - lastStopAt; // audio heard after stop_audio (negative: stopped before the message arrived)
  console.log(ts(), `  ⏱ barge-in: last audible sample ${bargeCut.toFixed(0)} ms after stop_audio`);
  await p;
  await sleep(2000);
}

// 3. Local commands: deterministic round trips through VAD → ASR → TTS → transport.
// The VAD sometimes clips the first ~200 ms of an utterance (on either transport), so the commands lead
// with words that parseIntent strips anyway ("jetzt bitte mal").
for (let i = 0; i < Number(process.env.ROUNDS ?? 5); i++) await localCommand("Jetzt bitte mal Status.");

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
console.log(
  "\nRESULT",
  JSON.stringify({
    transport: useWs ? "websocket" : "webrtc",
    pair: pair || undefined,
    negotiationMs: useWs ? undefined : Math.round(negotiationMs),
    transcriptReachedThread: reached,
    replyAudioSec: replySec === undefined ? undefined : Number(replySec.toFixed(1)),
    rounds: rounds.length,
    onsetToHeardMs: Math.round(median(rounds.map((r) => r.onset))),
    endOfSpeechToVadEndMs: Math.round(median(rounds.map((r) => r.vad))),
    endOfSpeechToSayMs: Math.round(median(rounds.map((r) => r.say))),
    endOfSpeechToAudibleMs: Math.round(median(rounds.map((r) => r.audible))),
    sayToAudibleMs: Math.round(median(rounds.map((r) => r.audible - r.say))),
    bargeInAudibleAfterStopMs: Math.round(bargeCut),
    setupMs: Math.round(performance.now() - t3Start),
  }),
);
await sleep(500);
process.exit(0);
