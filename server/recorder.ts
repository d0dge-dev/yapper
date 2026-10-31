// Keeps what you said (16 kHz WAV + transcript) in YAP_RECORD_DIR (default ./recordings) so ASR changes can be
// tested on real speech. On only with YAP_RECORD=1; nothing leaves the box. WAVs older than YAP_RECORD_DAYS are deleted.
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASR_SAMPLE_RATE } from "./speech.ts";
import { float32ToInt16 } from "./audio.ts";

const dir = () => (process.env.YAP_RECORD_DIR ? `${resolve(process.env.YAP_RECORD_DIR)}/` : fileURLToPath(new URL("../recordings/", import.meta.url)));

export function pruneRecordings(days: number, log: (msg: string) => void): void {
  const DIR = dir();
  if (!(days > 0) || !existsSync(DIR)) return;
  const cutoff = Date.now() - days * 86400_000;
  let n = 0;
  for (const f of readdirSync(DIR)) {
    if (f.endsWith(".wav") && statSync(DIR + f).mtimeMs < cutoff) { unlinkSync(DIR + f); n++; }
  }
  if (n) log(`recordings: deleted ${n} older than ${days} days`);
}

export function recordSegment(samples: Float32Array, text: string): void {
  if (process.env.YAP_RECORD !== "1") return;
  const DIR = dir();
  mkdirSync(DIR, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
  const pcm = float32ToInt16(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(ASR_SAMPLE_RATE, 24); header.writeUInt32LE(ASR_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(DIR + name, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
  appendFileSync(DIR + "transcripts.jsonl", JSON.stringify({ file: name, text }) + "\n");
}
