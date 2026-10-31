// Call log: every call, in or out, with what was said back where it matters. Callback rings keep the agent's
// result as audio (the same voice as on the call), so a missed callback can be listened to later or called back.
// Lives in YAP_STATE_DIR (calls.json + audio/<id>.wav); entries and audio older than CALL_LOG_DAYS are dropped.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "./t3client.ts";

export type CallDirection = "outgoing" | "incoming";
export type CallStatus = "active" | "completed" | "ringing" | "answered" | "missed";

export interface CallEntry {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  threadId: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  /** Incoming (callback) only. */
  callbackId?: string;
  reason?: string;
  kind?: string;
  requestedAt?: number;
  /** What the agent had to say: the reply read out on the call / waiting for a missed callback. */
  summary?: string;
  audio?: boolean;
}

const MAX_ENTRIES = 300;
const KEEP_DAYS = Number(process.env.CALL_LOG_DAYS ?? 30);

export class CallLog {
  private readonly file: string;
  private readonly audioDir: string;
  private entries: CallEntry[] = [];

  constructor(dir = process.env.YAP_STATE_DIR ? resolve(process.env.YAP_STATE_DIR) : fileURLToPath(new URL("../state", import.meta.url))) {
    this.file = `${dir}/calls.json`;
    this.audioDir = `${dir}/audio/`;
    mkdirSync(this.audioDir, { recursive: true });
    if (existsSync(this.file)) {
      try {
        this.entries = JSON.parse(readFileSync(this.file, "utf8"));
      } catch {
        this.entries = [];
      }
    }
    // Calls that were "active" or "ringing" when the server stopped are over by now.
    for (const e of this.entries) {
      if (e.status === "active") Object.assign(e, { status: "completed", endedAt: e.endedAt ?? e.startedAt });
      if (e.status === "ringing") e.status = "missed";
    }
    this.prune();
  }

  list(): CallEntry[] {
    return this.entries;
  }

  get(id: string): CallEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  byCallback(callbackId: string): CallEntry | undefined {
    return this.entries.find((e) => e.callbackId === callbackId);
  }

  add(entry: Omit<CallEntry, "id">): CallEntry {
    const e = { id: newId(), ...entry };
    this.entries.unshift(e);
    this.save();
    return e;
  }

  update(id: string, patch: Partial<CallEntry>): void {
    const e = this.get(id);
    if (!e) return;
    Object.assign(e, patch);
    this.save();
  }

  audioPath(id: string): string | null {
    const path = `${this.audioDir}${id}.wav`;
    return /^[\w-]+$/.test(id) && existsSync(path) ? path : null;
  }

  saveAudio(id: string, samples: Float32Array, sampleRate: number): void {
    writeFileSync(`${this.audioDir}${id}.wav`, wav(samples, sampleRate));
    this.update(id, { audio: true });
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    this.entries = this.entries.filter((e) => e.startedAt >= cutoff).slice(0, MAX_ENTRIES);
    const keep = new Set(this.entries.map((e) => `${e.id}.wav`));
    for (const f of readdirSync(this.audioDir)) if (!keep.has(f) || statSync(this.audioDir + f).mtimeMs < cutoff) unlinkSync(this.audioDir + f);
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** 16-bit mono PCM WAV. */
export function wav(samples: Float32Array, sampleRate: number): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
