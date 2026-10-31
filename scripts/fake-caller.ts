// End-to-end test without a phone: synthesizes speech, streams it into /call like a
// microphone would (real time, 16 kHz Int16), and prints what the call does.
//
//   YAP_DEV=1 npm start            # in one shell
//   node scripts/fake-caller.ts <threadId>
import { WebSocket } from "ws";
import { loadSpeech, ASR_SAMPLE_RATE } from "../server/speech.ts";
import { resample, float32ToInt16 } from "../server/audio.ts";

const threadId = process.argv[2];
if (!threadId) throw new Error("usage: fake-caller.ts <threadId>");
const speech = await loadSpeech();
const ws = new WebSocket(`ws://127.0.0.1:${process.env.YAP_PORT ?? 8790}/call`);
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;

let audioBytes = 0;
let saidSentences = 0;
let agentState = "idle";
const waiters: { pred: () => boolean; resolve: () => void }[] = [];
const check = () => waiters.splice(0).forEach((w) => (w.pred() ? w.resolve() : waiters.push(w)));
const until = (pred: () => boolean, timeoutMs = 120_000) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting")), timeoutMs);
    waiters.push({ pred, resolve: () => (clearTimeout(timer), resolve()) });
    check();
  });

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    audioBytes += (data as Buffer).length;
    return;
  }
  const msg = JSON.parse(String(data));
  if (msg.type === "state") agentState = msg.agent;
  if (msg.type === "say") saidSentences++;
  if (msg.type === "state") console.log(ts(), "state", msg.agent, msg.utterance ? `utterance="${msg.utterance}"` : "");
  else if (msg.type === "say") console.log(ts(), "SAY", msg.text);
  else if (msg.type !== "hearing" && msg.type !== "sending_in") console.log(ts(), msg.type, JSON.stringify(msg).slice(0, 220));
  check();
});

// Mic: silence unless we're "talking".
let talking: Int16Array | null = null;
let talkPos = 0;
const FRAME = 1600;
const silence = Buffer.alloc(FRAME * 2);
setInterval(() => {
  if (ws.readyState !== ws.OPEN) return;
  if (talking && talkPos < talking.length) {
    const chunk = talking.subarray(talkPos, talkPos + FRAME);
    talkPos += FRAME;
    ws.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  } else ws.send(silence);
}, 100);

async function talk(text: string) {
  const audio = await speech.synthesize(text, "de");
  const pcm = float32ToInt16(resample(audio.samples, audio.sampleRate, ASR_SAMPLE_RATE));
  talking = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  talkPos = 0;
  console.log(ts(), "YOU SAY", text);
  await until(() => talkPos >= (talking?.length ?? 0), 60_000);
  talking = null;
}

await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "start", threadId, settings: { lang: "de", progressAfterMs: 12000 } }));
await until(() => saidSentences >= 1); // greeting

await talk("Wie viele Dateien liegen im Ordner scripts? Zähl sie mit einem Befehl und antworte in einem Satz.");
await until(() => agentState === "working");
await new Promise((r) => setTimeout(r, 1500));
await talk("Und sag mir auch, welche davon die grösste ist.");
await until(() => agentState === "idle", 180_000);
const before = saidSentences;
await until(() => saidSentences > before || Date.now() - t0 > 600_000, 30_000).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));

await talk("Status");
await new Promise((r) => setTimeout(r, 5000));
console.log(ts(), `done: ${saidSentences} sentences, ${(audioBytes / 2 / 22050).toFixed(1)} s of speech received`);
process.exit(0);
