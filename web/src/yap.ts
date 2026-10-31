// yap call engine: the behaviour of the former web/app.js, minus DOM writes.
// UI state lives in a tiny external store that React reads with useSyncExternalStore.
import { useSyncExternalStore } from "react";
import { isNative, nativeCallEnded, nativeCallStarted, onNativeAnswer } from "./native";
import { Meter, RtcAudio, rtcWanted, setMeters } from "./rtc";
export { getLevels } from "./rtc";

export type Settings = {
  lang: "de" | "en";
  whileRunning: "steer" | "queue";
  sendAfterMs: number;
  progressAfterMs: number;
  voiceHint: boolean;
  echoCancellation: boolean;
  speakThoughts: boolean;
};
export type ModelSelection = { instanceId: string; model: string; options?: { id: string; value: string | boolean }[] };
export type ThreadConfig = { modelSelection: ModelSelection; runtimeMode: string; interactionMode: string };
export type ModelOption = { id: string; label: string; type: string; options?: { id: string; label: string; isDefault?: boolean }[]; currentValue?: unknown };
export type ModelCatalog = {
  providers: { instanceId: string; displayName: string; models: { slug: string; name: string; legacy: boolean; options: ModelOption[] }[] }[];
  runtimeModes: string[];
  defaults: ThreadConfig;
};
export type Thread = {
  id: string;
  title: string;
  projectTitle: string;
  pinned?: boolean;
  running?: boolean;
  projectId?: string;
  draft?: boolean;
  config?: ThreadConfig | null;
};
export type Project = { id: string; title: string; lastUsedAt: string };
export type CallEntry = {
  id: string;
  direction: "outgoing" | "incoming";
  status: "active" | "completed" | "ringing" | "answered" | "missed";
  threadId: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  callbackId?: string;
  reason?: string;
  summary?: string;
  audio?: boolean;
};
export type Role = "you" | "agent" | "activity" | "system";
export type TimelineItem = { id: number; role: Role; text: string; old: boolean };
export type OrbState = "off" | "muted" | "connecting" | "listening" | "hearing" | "sending" | "speaking" | "working" | "approval" | "question";

const DEFAULTS: Settings = {
  lang: "de",
  whileRunning: "steer",
  sendAfterMs: 1300,
  progressAfterMs: 20000,
  voiceHint: true,
  echoCancellation: true,
  speakThoughts: true,
};
export const settings: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("yap.settings") ?? "{}") };
const saveSettings = () => localStorage.setItem("yap.settings", JSON.stringify(settings));

export type UiState = {
  /** Start screen: thread list or call log. */
  view: "threads" | "calls";
  calls: CallEntry[];
  /** Missed callbacks since the call log was last opened. */
  missed: number;
  threads: Thread[];
  projects: Project[];
  models: ModelCatalog | null;
  /** Full-screen call view; false = call keeps running while the chat is shown. */
  live: boolean;
  /** Last sentence the call spoke. */
  caption: string;
  /** Mic off: the call keeps talking, nothing you say is heard. */
  muted: boolean;
  /** A phone (the Android app) is registered for callback calls. */
  canRing: boolean;
  current: Thread | null;
  title: string;
  timeline: TimelineItem[];
  orb: OrbState;
  orbLabel: string;
  status: string;
  utterance: string;
  approval: { show: boolean; prompt: string };
  inCall: boolean;
  canSend: boolean;
  canInterrupt: boolean;
};

let ui: UiState = {
  view: "threads",
  calls: [],
  missed: 0,
  threads: [],
  projects: [],
  models: null,
  live: false,
  caption: "",
  muted: false,
  canRing: false,
  current: null,
  title: "Yapper",
  timeline: [],
  orb: "off",
  orbLabel: "Anrufen",
  status: "Bereit",
  utterance: "",
  approval: { show: false, prompt: "" },
  inCall: false,
  canSend: false,
  canInterrupt: false,
};
const listeners = new Set<() => void>();
function patch(p: Partial<UiState>) {
  ui = { ...ui, ...p };
  for (const l of listeners) l();
}
export function useUi(): UiState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => ui,
  );
}

type CallState = {
  connecting: boolean;
  /** Answering a callback: sent with the first start message only, so a reconnect doesn't answer twice. */
  callback?: string;
  server: { agent: string; utterance: string; approvalPrompt?: string; threadTitle?: string };
  hearing: boolean;
  player: Player;
  ws: WebSocket | null;
  wakeLock: WakeLockSentinel | null;
  ending: boolean;
  stream?: MediaStream;
  mic?: AudioContext;
  /** Which way audio goes; null while WebRTC is being tried (nothing is sent then). */
  via: "ws" | "rtc" | null;
  rtc: RtcAudio | null;
};
let call: CallState | null = null;

// ------------------------------------------------------------------ thread picker

/** Behind an SSO proxy an expired login answers with a redirect to the login host; reloading the page shows the login. */
async function loginExpired(): Promise<boolean> {
  try {
    const res = await fetch("api/threads", { redirect: "manual", cache: "no-store" });
    return res.type === "opaqueredirect" || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

export async function loadThreads() {
  const res = await fetch("api/threads", { redirect: "manual" });
  if (res.type === "opaqueredirect") return location.reload();
  if (!res.ok) throw new Error(`threads: HTTP ${res.status}`);
  patch({ threads: await res.json() });
}

const callsSeenAt = () => Number(localStorage.getItem("yap.callsSeenAt") ?? 0);

export async function loadCalls() {
  const res = await fetch("api/calls", { redirect: "manual" });
  if (res.type === "opaqueredirect") return location.reload();
  if (!res.ok) throw new Error(`calls: HTTP ${res.status}`);
  const calls = (await res.json()) as CallEntry[];
  const seen = ui.view === "calls" ? Date.now() : callsSeenAt();
  patch({ calls, missed: calls.filter((c) => c.status === "missed" && c.startedAt > seen).length });
}

export function showCalls(show: boolean) {
  if (show) {
    localStorage.setItem("yap.callsSeenAt", String(Date.now()));
    if (ui.view !== "calls") history.pushState({ calls: true }, "", "#calls");
    patch({ view: "calls", missed: 0 });
    loadCalls().catch(() => {});
  } else if (ui.view === "calls") history.back();
}

/** From the call log: open the thread and call; a callback entry plays back what it rang about. */
export async function callBack(entry: CallEntry) {
  if (call) endCall();
  const t = ui.threads.find((x) => x.id === entry.threadId) ?? { id: entry.threadId, title: entry.title || "Thread", projectTitle: "" };
  await openThread(t);
  await startCall(entry.direction === "incoming" && entry.callbackId ? { callback: entry.callbackId } : {});
}

export async function loadProjects() {
  const res = await fetch("api/projects", { redirect: "manual" });
  if (res.type === "opaqueredirect") return location.reload();
  if (!res.ok) throw new Error(`projects: HTTP ${res.status}`);
  patch({ projects: await res.json() });
}

export async function loadModels() {
  if (ui.models) return;
  const res = await fetch("api/models", { redirect: "manual" });
  if (res.type === "opaqueredirect") return location.reload();
  if (!res.ok) throw new Error(`models: HTTP ${res.status}`);
  patch({ models: await res.json() });
}

/** A thread that doesn't exist yet: the first thing said or typed creates it in `project`. */
export function openDraft(project: Project) {
  patch({
    current: { id: "", title: "Neuer Thread", projectTitle: project.title, projectId: project.id, draft: true, config: null },
    title: `Neuer Thread · ${project.title}`,
    timeline: [],
    caption: "",
  });
  setOrb("off", "Anrufen");
  setStatus("Ruf an oder tippe, um den Thread zu starten");
  history.pushState({ draft: project.id }, "", "#new");
  fetch(`api/projects/${encodeURIComponent(project.id)}/defaults`)
    .then((r) => (r.ok ? r.json() : null))
    .then((config) => config && ui.current?.draft && ui.current.projectId === project.id && !ui.current.config && patch({ current: { ...ui.current, config } }))
    .catch(() => {});
}

/** Model, reasoning and modes: kept on a draft until it launches, otherwise applied to the thread right away. */
export async function setThreadConfig(config: ThreadConfig) {
  const current = ui.current;
  if (!current) return;
  patch({ current: { ...current, config } });
  if (current.draft) return;
  try {
    const res = await fetch(`api/threads/${encodeURIComponent(current.id)}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    patch({ threads: ui.threads.map((t) => (t.id === current.id ? { ...t, config } : t)) });
  } catch (e) {
    patch({ current });
    addTimeline("system", `Einstellungen nicht übernommen: ${(e as Error).message}`);
  }
}

export const setLive = (live: boolean) => patch({ live });

/** The draft now exists in T3: switch the view over to it. */
function draftLaunched(t: Thread) {
  patch({ current: t, title: t.title });
  history.replaceState({ thread: t.id }, "", `#${encodeURIComponent(t.id)}`);
}

export async function openThread(t: Thread) {
  patch({ current: t, title: t.title, timeline: [], caption: "" });
  setOrb("off", "Anrufen");
  setStatus("Bereit");
  history.pushState({ thread: t.id }, "", `#${encodeURIComponent(t.id)}`);
  try {
    const res = await fetch(`api/threads/${encodeURIComponent(t.id)}/history`);
    for (const m of (await res.json()) as { role: string; text: string }[])
      addTimeline(m.role === "user" ? "you" : "agent", stripHint(m.text), true);
  } catch (e) {
    addTimeline("system", `Verlauf nicht geladen: ${(e as Error).message}`);
  }
}

export function closeThread() {
  if (call) endCall();
  patch({ current: null, title: "Yapper" });
  loadThreads().catch(() => {});
  loadCalls().catch(() => {});
}

// ------------------------------------------------------------------ timeline

const stripHint = (text: string) => text.replace(/\n*_\(Sent from a voice call:[\s\S]*?\)_\s*$/, "");

let nextId = 1;
export function addTimeline(role: Role, text: string, old = false) {
  patch({ timeline: [...ui.timeline, { id: nextId++, role, text, old }] });
}

// ------------------------------------------------------------------ status UI

function setOrb(state: OrbState, label?: string) {
  patch(label !== undefined ? { orb: state, orbLabel: label } : { orb: state });
}
const setStatus = (text: string) => patch({ status: text });

function refreshOrb() {
  if (!call) return;
  if (call.connecting) return setOrb("connecting", "…");
  if (ui.muted && call.server.agent !== "approval" && call.server.agent !== "question") {
    const working = call.server.agent === "working";
    return patch({ orb: "muted", orbLabel: "Stumm", status: working ? "Mikrofon aus · Agent arbeitet" : "Mikrofon aus", utterance: "", canSend: false, canInterrupt: call.server.agent !== "idle", approval: { show: false, prompt: "" } });
  }
  const speaking = call.player.busy() || !!call.rtc?.playing;
  const s = call.server;
  let state: OrbState = "listening", label = "Ich höre", status = "Sprich einfach los";
  if (s.agent === "approval") [state, label, status] = ["approval", "Freigabe?", "Ja oder nein"];
  else if (s.agent === "question") [state, label, status] = ["question", "Frage", "Antworte einfach"];
  else if (call.hearing) [state, label, status] = ["hearing", "Ich höre", "…"];
  else if (s.utterance) [state, label, status] = ["sending", "Gleich…", "Pause = senden"];
  else if (speaking) [state, label, status] = ["speaking", "Spricht", "Reinreden unterbricht"];
  else if (s.agent === "working") [state, label, status] = ["working", "Arbeitet", "Du kannst reinreden, um zu lenken"];
  patch({
    orb: state,
    orbLabel: label,
    status,
    utterance: s.utterance ?? "",
    approval: { show: s.agent === "approval", prompt: s.approvalPrompt ?? "" },
    canSend: !!s.utterance,
    canInterrupt: s.agent !== "idle",
  });
}

// ------------------------------------------------------------------ audio out

class Player {
  ctx = new AudioContext();
  /** Speech goes through this (the out level); earcons go straight out. */
  meter = new Meter(this.ctx);
  constructor() {
    this.meter.node.connect(this.ctx.destination);
  }
  sources = new Set<AudioBufferSourceNode>();
  nextTime = 0;
  sampleRate = 22050;
  play(int16: Int16Array) {
    const f = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f.length, this.sampleRate);
    buf.copyToChannel(f, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.meter.node);
    const at = Math.max(this.ctx.currentTime + 0.03, this.nextTime);
    src.start(at);
    this.nextTime = at + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      refreshOrb();
    };
  }
  stop() {
    for (const s of this.sources)
      try {
        s.stop();
      } catch {}
    this.sources.clear();
    this.nextTime = 0;
  }
  busy() {
    return this.sources.size > 0;
  }
  beep(name: string) {
    const tones = ({
      sent: [[660, 0, 0.07], [880, 0.08, 0.09]],
      done: [[784, 0, 0.12], [1047, 0.13, 0.18]],
      start: [[523, 0, 0.1], [784, 0.11, 0.12]],
      end: [[523, 0, 0.12], [392, 0.13, 0.16]],
    } as Record<string, number[][]>)[name];
    if (!tones) return;
    const t0 = this.ctx.currentTime + 0.02;
    for (const [freq, at, dur] of tones) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.02);
    }
  }
  close() {
    this.stop();
    this.ctx.close();
  }
}

// ------------------------------------------------------------------ call

export async function startCall(opts: { callback?: string } = {}) {
  if (!ui.current || call) return;
  const c: CallState = { connecting: true, callback: opts.callback, server: { agent: "idle", utterance: "" }, hearing: false, player: new Player(), ws: null, wakeLock: null, ending: false, via: null, rtc: null };
  fetch("api/push/status")
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => s && patch({ canRing: s.canRing === true }))
    .catch(() => {});
  call = c;
  refreshOrb();
  try {
    c.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: settings.echoCancellation, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    c.mic = new AudioContext({ sampleRate: 16000 });
    await c.mic.audioWorklet.addModule("capture-worklet.js");
    const node = new AudioWorkletNode(c.mic, "capture");
    node.port.onmessage = (e) => call?.via === "ws" && call.ws?.readyState === WebSocket.OPEN && call.ws.send(e.data);
    c.mic.createMediaStreamSource(c.stream).connect(node);
    const micMeter = new Meter(c.player.ctx);
    c.player.ctx.createMediaStreamSource(c.stream).connect(micMeter.node);
    setMeters({ mic: micMeter, out: c.player.meter });
    c.player.beep("start");
    nativeCallStarted(ui.title, endCall);
    await acquireWakeLock();
    connect();
  } catch (e) {
    addTimeline("system", `Mikrofon: ${(e as Error).message}`);
    endCall();
    return;
  }
  patch({ inCall: true, live: true });
}

function connect() {
  if (!call || !ui.current) return;
  const current = ui.current;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${location.pathname.replace(/[^/]*$/, "")}call`);
  ws.binaryType = "arraybuffer";
  call.ws = ws;
  ws.onopen = async () => {
    if (!call || call.ws !== ws) return;
    await openAudio(call, ws);
    if (!call || call.ws !== ws) return;
    call.connecting = false;
    ws.send(
      JSON.stringify(
        current.draft
          ? { type: "start", projectId: current.projectId, projectTitle: current.projectTitle, config: ui.current?.config ?? null, settings }
          : { type: "start", threadId: current.id, settings, ...(call.callback ? { callback: call.callback } : {}) },
      ),
    );
    call.callback = undefined;
    refreshOrb();
  };
  ws.onmessage = (m) => {
    if (!call) return;
    if (m.data instanceof ArrayBuffer) {
      call.player.play(new Int16Array(m.data));
      refreshOrb();
      return;
    }
    const msg = JSON.parse(m.data);
    if (String(msg.type).startsWith("rtc_")) return call.rtc?.signal(msg);
    switch (msg.type) {
      case "state":
        call.server = msg;
        if (msg.threadTitle) patch({ title: msg.threadTitle });
        break;
      case "hangup":
        // The server said goodbye (e.g. "I'll call you back"); its audio has played by now.
        setTimeout(() => call && endCall(), 300);
        break;
      case "thread":
        draftLaunched(msg.thread);
        break;
      case "say":
        patch({ caption: msg.text });
        call.player.sampleRate = msg.sampleRate;
        break;
      case "stop_audio":
        call.player.stop();
        break;
      case "hearing":
        call.hearing = msg.on;
        break;
      case "earcon":
        call.player.beep(msg.name);
        break;
      case "timeline":
        addTimeline(msg.role, msg.role === "you" ? stripHint(msg.text) : msg.text);
        break;
      case "error":
        addTimeline("system", msg.message);
        break;
    }
    refreshOrb();
  };
  ws.onclose = () => {
    if (!call || call.ending) return;
    call.rtc?.close();
    call.rtc = null;
    call.via = null;
    call.connecting = true;
    refreshOrb();
    setTimeout(async () => {
      if (!call || call.ending) return;
      if (await loginExpired()) return location.reload();
      connect();
    }, 1500);
  };
}

/** WebRTC if it connects within a few seconds, else audio over the WebSocket. */
async function openAudio(c: CallState, ws: WebSocket) {
  c.via = null;
  if (c.stream && rtcWanted()) {
    const rtc = new RtcAudio((msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)), c.stream);
    c.rtc = rtc;
    rtc.onChange = refreshOrb;
    rtc.onLost = () => call === c && c.rtc === rtc && useWsAudio(c);
    const ok = await rtc.connect();
    if (call !== c || c.ws !== ws) return rtc.close(); // hung up or reconnected meanwhile
    if (ok) {
      c.via = "rtc";
      c.mic?.suspend().catch(() => {});
      if (rtc.remote) {
        const out = new Meter(c.player.ctx);
        c.player.ctx.createMediaStreamSource(rtc.remote).connect(out.node);
        setMeters({ out });
      }
      return;
    }
  }
  useWsAudio(c);
}

function useWsAudio(c: CallState) {
  c.rtc = null;
  c.via = "ws";
  c.mic?.resume().catch(() => {});
  setMeters({ out: c.player.meter });
  refreshOrb();
}

export function endCall() {
  if (!call) return;
  const c = call;
  c.ending = true;
  c.rtc?.close();
  setMeters({ mic: null, out: null });
  c.player.beep("end");
  c.ws?.close();
  c.stream?.getTracks().forEach((t) => t.stop());
  c.mic?.close();
  setTimeout(() => c.player.close(), 400);
  c.wakeLock?.release().catch(() => {});
  nativeCallEnded();
  call = null;
  patch({ inCall: false, live: false, muted: false, approval: { show: false, prompt: "" }, utterance: "", caption: "" });
  setOrb("off", "Anrufen");
  setStatus("Aufgelegt");
}

export const toggleCall = () => (call ? endCall() : startCall());

async function acquireWakeLock() {
  try {
    // In the Android app the call service keeps the call alive with the screen off; the browser needs the screen on.
    if (call && !isNative && "wakeLock" in navigator) call.wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && call && acquireWakeLock());

export const send = (msg: object) => call?.ws?.readyState === WebSocket.OPEN && call.ws.send(JSON.stringify(msg));

/** Disables the mic track; the worklet then sends silence, so the server simply hears nothing. */
export function toggleMute() {
  if (!call) return;
  const muted = !ui.muted;
  call.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  patch({ muted });
  refreshOrb();
}

/** "Call me back when you're done": the server confirms, says goodbye and sends `hangup`. */
export const requestCallback = () => send({ type: "callback" });

export function hush() {
  call?.player.stop();
  send({ type: "hush" });
}

export async function typeText(text: string) {
  if (call) {
    send({ type: "text", text });
    return;
  }
  const current = ui.current;
  if (!current?.draft) {
    addTimeline("system", "Erst anrufen, dann tippen.");
    return;
  }
  addTimeline("you", text);
  setStatus("Thread wird gestartet…");
  try {
    const res = await fetch("api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: current.projectId, text, config: current.config ?? null }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    draftLaunched(await res.json());
    setStatus("Gestartet. Ruf an, um mitzuhören.");
  } catch (e) {
    addTimeline("system", `Thread nicht gestartet: ${(e as Error).message}`);
    setStatus("Ruf an oder tippe, um den Thread zu starten");
  }
}

export function applySettings(next: Settings) {
  Object.assign(settings, next);
  saveSettings();
  send({ type: "settings", settings });
}

// ------------------------------------------------------------------ boot

window.addEventListener("popstate", () => {
  if (ui.current) closeThread();
  else if (ui.view === "calls") patch({ view: "threads" });
});
setInterval(() => document.visibilityState === "visible" && !ui.current && loadCalls().catch(() => {}), 30_000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && loadCalls().catch(() => {}));

// The phone picked up a callback ring: open that thread and start the call that reads out the result.
onNativeAnswer(async ({ callId, threadId }) => {
  if (call) endCall();
  await loadThreads().catch(() => {});
  const t = ui.threads.find((x) => x.id === threadId) ?? { id: threadId, title: "Rückruf", projectTitle: "" };
  if (ui.current?.id !== t.id) await openThread(t);
  await startCall({ callback: callId });
});

loadCalls().catch(() => {});
loadThreads()
  .then(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    const t = id && ui.threads.find((x) => x.id === id);
    if (t) openThread(t);
  })
  .catch((e) => addTimeline("system", e.message));
