// Callback calls: "call me back when you're done". The call hangs up, the server keeps watching the thread, and
// when the agent's run ends (or it needs an approval/answer) it rings the phone through UnifiedPush: a raw JSON
// body POSTed to every registered endpoint (ntfy is the distributor on the phone). The app shows a real incoming
// call; answering opens the thread and starts a call with `callback: callId`, which reads out the result.
//
// State (devices, pending callbacks) lives in YAP_STATE_DIR so a restart or deploy doesn't lose a callback.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "./t3client.ts";
import type { T3Adapter, ThreadEvent } from "./t3adapter.ts";

export type RingReason = "done" | "approval" | "question" | "failed";

/**
 * Why a callback exists: the user asked for it ("requested", rings any time), or an agent wants them because it needs
 * help ("assistance") or has something important ("info"); those two only ring within call hours.
 */
export type CallbackKind = "requested" | "assistance" | "info";

export interface Device {
  endpoint: string;
  device: string;
  registeredAt: number;
}

export interface Callback {
  id: string;
  threadId: string;
  title: string;
  requestedAt: number;
  /** Set once the thread was seen working after the request; a run ending only counts after that. */
  sawRun: boolean;
  kind?: CallbackKind;
  state: "waiting" | "held" | "ringing" | "answered" | "expired";
  /** Outside call hours: the ring waits until then (epoch ms). */
  heldUntil?: number;
  reason?: RingReason;
  rangAt?: number;
}

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);
// A callback whose thread never starts working (or never finishes) is dropped after this long.
const MAX_WAIT_MS = 6 * 3600_000;
// Without a run starting within this time after the request, ring anyway: the work may have finished already.
const NO_RUN_GRACE_MS = 3 * 60_000;
const RING_TTL_MS = 10 * 60_000;
// The phone rings for 45 s; after that the log shows it as missed (a late answer still flips it to answered).
const MISSED_AFTER_MS = 50_000;

/** YAP_CALL_HOURS="7-22": agent-initiated calls (not ones the user asked for) ring only in this local-time window. */
function callHours(): [number, number] {
  const m = (process.env.YAP_CALL_HOURS ?? "7-22").match(/^(\d{1,2})-(\d{1,2})$/);
  return m ? [Number(m[1]), Number(m[2])] : [7, 22];
}

/** Null if now is within call hours, else when they start next. */
export function nextCallWindow(now = new Date()): Date | null {
  const [from, to] = callHours();
  const h = now.getHours() + now.getMinutes() / 60;
  const inside = from <= to ? h >= from && h < to : h >= from || h < to;
  if (inside) return null;
  const next = new Date(now);
  next.setHours(from, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

type Log = (msg: string) => void;

export class Callbacks {
  private readonly file: string;
  private devices: Device[] = [];
  private pending = new Map<string, Callback>();
  private watchers = new Map<string, { stop(): void }>();
  private timers = new Map<string, NodeJS.Timeout>();

  private readonly t3: T3Adapter;
  private readonly log: Log;
  /** Call log hooks (set by main.ts): a ring went out, was picked up, or nobody answered within MISSED_AFTER_MS. */
  onRing?: (cb: Callback) => void;
  onAnswered?: (cb: Callback) => void;
  onMissed?: (cb: Callback) => void;

  constructor(
    t3: T3Adapter,
    log: Log,
    dir = process.env.YAP_STATE_DIR ? resolve(process.env.YAP_STATE_DIR) : fileURLToPath(new URL("../state", import.meta.url)),
  ) {
    this.t3 = t3;
    this.log = log;
    mkdirSync(dir, { recursive: true });
    this.file = `${dir}/callbacks.json`;
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        this.devices = saved.devices ?? [];
        for (const cb of saved.callbacks ?? []) this.pending.set(cb.id, cb);
      } catch (e) {
        log(`callbacks: state unreadable, starting empty (${(e as Error).message})`);
      }
    }
  }

  /** Resume watching callbacks that were waiting before a restart. */
  async resume(): Promise<void> {
    for (const cb of this.pending.values()) {
      if (cb.state === "waiting") await this.watch(cb).catch((e) => this.log(`callback ${cb.id}: ${(e as Error).message}`));
      else if (cb.state === "held") this.hold(cb, cb.reason ?? "done", cb.heldUntil ?? Date.now());
      else if (cb.state !== "ringing" || Date.now() - (cb.rangAt ?? 0) > RING_TTL_MS) this.pending.delete(cb.id);
    }
    this.save();
  }

  // Threads with a call open right now: a run ending there has just been heard, so it doesn't ring.
  private live = new Map<string, number>();

  setLive(threadId: string, on: boolean): void {
    const n = (this.live.get(threadId) ?? 0) + (on ? 1 : -1);
    if (n > 0) this.live.set(threadId, n);
    else this.live.delete(threadId);
  }

  get canRing(): boolean {
    return this.devices.length > 0;
  }

  register(endpoint: string, device: string): void {
    const url = new URL(endpoint);
    const devLoopback = process.env.YAP_DEV === "1" && url.protocol === "http:" && url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !devLoopback) throw Object.assign(new Error("endpoint must be https"), { status: 400 });
    this.devices = [...this.devices.filter((d) => d.endpoint !== endpoint && d.device !== device), { endpoint, device, registeredAt: Date.now() }];
    this.save();
    this.log(`push: registered ${device} (${url.host})`);
  }

  async request(threadId: string, title: string, kind: CallbackKind = "requested"): Promise<Callback> {
    // One callback per thread is enough; a new request replaces the old one.
    for (const cb of this.pending.values()) if (cb.threadId === threadId) this.drop(cb.id);
    const cb: Callback = { id: newId(), threadId, title, kind, requestedAt: Date.now(), sawRun: false, state: "waiting" };
    this.pending.set(cb.id, cb);
    this.save();
    await this.watch(cb);
    this.log(`callback ${cb.id} (${kind}) requested for ${title || threadId}`);
    return cb;
  }

  get(id: string): Callback | undefined {
    return this.pending.get(id);
  }

  /** The phone picked up: no more ringing for this one. */
  answered(id: string): Callback | undefined {
    const cb = this.pending.get(id);
    if (!cb) return undefined;
    cb.state = "answered";
    this.onAnswered?.(cb);
    this.drop(id);
    // Every phone rang; the others stop now (the app ignores a cancel for the call it answered itself).
    if (this.devices.length > 1) this.pushAll({ type: "cancel", callId: id });
    return cb;
  }

  private async watch(cb: Callback): Promise<void> {
    const deadline = setTimeout(() => {
      this.log(`callback ${cb.id}: gave up after ${MAX_WAIT_MS / 3600_000} h`);
      this.drop(cb.id);
    }, Math.max(0, cb.requestedAt + MAX_WAIT_MS - Date.now()));
    const grace = setTimeout(() => !cb.sawRun && this.ring(cb, "done"), Math.max(0, cb.requestedAt + NO_RUN_GRACE_MS - Date.now()));
    this.timers.set(cb.id, deadline);
    this.timers.set(`${cb.id}:grace`, grace);
    const watcher = await this.t3.watch(cb.threadId, (ev) => this.onEvent(cb, ev));
    this.watchers.set(cb.id, watcher);
  }

  private onEvent(cb: Callback, ev: ThreadEvent): void {
    if (cb.state !== "waiting") return;
    if (ev.type === "ready") {
      if (ev.activeRunId) cb.sawRun = true;
      if (ev.title) cb.title = ev.title;
    } else if (ev.type === "run") {
      if (ACTIVE.has(ev.status)) cb.sawRun = true;
      else if (cb.sawRun) this.ring(cb, ev.status === "failed" ? "failed" : "done");
    } else if ((ev.type === "approval" || ev.type === "question") && (ev.status === "waiting" || ev.status === "pending")) {
      this.ring(cb, ev.type);
    }
  }

  /** Outside call hours: keep it and ring when they start, unless the user has been in the thread since. */
  private hold(cb: Callback, reason: RingReason, until: number): void {
    cb.state = "held";
    cb.reason = reason;
    cb.heldUntil = until;
    this.stopWatching(cb.id);
    this.save();
    this.log(`callback ${cb.id}: outside call hours, holding until ${new Date(until).toLocaleString()}`);
    this.timers.set(
      cb.id,
      setTimeout(() => this.releaseHeld(cb).catch((e) => this.log(`callback ${cb.id}: ${(e as Error).message}`)), Math.max(0, until - Date.now())),
    );
  }

  private async releaseHeld(cb: Callback): Promise<void> {
    const since = new Date(cb.rangAt ?? cb.requestedAt).toISOString();
    const lastUser = (await this.t3.history(cb.threadId, 10)).filter((m) => m.role === "user").at(-1);
    if (lastUser && lastUser.createdAt > since) {
      this.log(`callback ${cb.id}: the user has been in the thread since, not ringing`);
      return this.drop(cb.id);
    }
    cb.state = "waiting";
    this.ring(cb, cb.reason ?? "done", true);
  }

  private ring(cb: Callback, reason: RingReason, released = false): void {
    if (cb.state !== "waiting") return;
    if (this.live.has(cb.threadId)) {
      this.log(`callback ${cb.id}: ${reason} while still on the call, not ringing`);
      return this.drop(cb.id);
    }
    const wait = !released && cb.kind && cb.kind !== "requested" ? nextCallWindow() : null;
    if (wait) {
      cb.rangAt = Date.now();
      return this.hold(cb, reason, wait.getTime());
    }
    cb.state = "ringing";
    cb.reason = reason;
    cb.rangAt = Date.now();
    this.stopWatching(cb.id);
    this.save();
    this.log(`callback ${cb.id}: ringing (${reason}) on ${this.devices.length} device(s)`);
    // The app knows done/approval/question/failed; "needs your help" reads best as "hat eine Frage".
    const shown = cb.kind === "assistance" && reason === "done" ? "question" : reason;
    this.pushAll({ type: "ring", callId: cb.id, threadId: cb.threadId, title: cb.title, reason: shown, at: cb.rangAt });
    this.onRing?.(cb);
    // An unanswered ring is kept a while so a late "answer" still finds it, then forgotten.
    this.timers.set(cb.id, setTimeout(() => this.drop(cb.id), RING_TTL_MS));
    this.timers.set(`${cb.id}:missed`, setTimeout(() => cb.state === "ringing" && this.onMissed?.(cb), MISSED_AFTER_MS));
  }

  /** Raw JSON body to every registered UnifiedPush endpoint; endpoints that are gone get dropped. */
  private pushAll(message: object): void {
    const body = JSON.stringify(message);
    for (const d of this.devices)
      fetch(d.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) })
        .then((r) => {
          if (r.status === 404 || r.status === 410) this.unregister(d.endpoint);
          else if (!r.ok) this.log(`push to ${d.device}: HTTP ${r.status}`);
        })
        .catch((e) => this.log(`push to ${d.device}: ${(e as Error).message}`));
  }

  private unregister(endpoint: string): void {
    this.devices = this.devices.filter((d) => d.endpoint !== endpoint);
    this.save();
    this.log(`push: dropped gone endpoint ${new URL(endpoint).host}`);
  }

  private stopWatching(id: string): void {
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    for (const key of [id, `${id}:grace`, `${id}:missed`]) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
  }

  private drop(id: string): void {
    this.stopWatching(id);
    this.pending.delete(id);
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices: this.devices, callbacks: [...this.pending.values()] }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
