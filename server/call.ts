// One voice call: browser audio in, T3 thread events in, speech and actions out.
//
// Rules, no extra model in between:
//   - Whatever you say goes to the thread word for word, after a short pause.
//   - While the agent works, it's sent as a steer (or queued, per settings).
//   - Short phrases like "stopp", "ja"/"nein" (when an approval is pending) are commands.
//   - The agent's prose is read out, without code, tables, links or paths.
//   - If the agent goes quiet for a while, the call says what it's doing.

import type { WebSocket } from "ws";
import type { Lang, SpeechEngine, VadStream } from "./speech.ts";
import { ASR_SAMPLE_RATE } from "./speech.ts";
import type { Question, T3Adapter, ThreadConfig, ThreadEvent } from "./t3adapter.ts";
import type { AudioLink } from "./transport.ts";
import { SincStream } from "./audio.ts";
import { recordSegment } from "./recorder.ts";
import { Vocabulary } from "./vocab.ts";
import { detectLang, echoScore, sentences, toSpeakable, words } from "./speakable.ts";
import { CALLBACK_RE, matchAnswer, parseIntent, say, VOICE_HINT, type Intent } from "./phrases.ts";
import type { Callbacks } from "./callbacks.ts";
import type { CallLog } from "./calllog.ts";

export interface CallSettings {
  lang: Lang;
  voiceHint: boolean;
  whileRunning: "steer" | "queue";
  sendAfterMs: number;
  progressAfterMs: number;
  maxSpokenChars: number;
  /** Mention the agent's thoughts ("Thinking: …"), in the language they come in (mostly English). */
  speakThoughts: boolean;
}

export const DEFAULT_SETTINGS: CallSettings = {
  lang: "de",
  voiceHint: true,
  whileRunning: "steer",
  sendAfterMs: 1300,
  progressAfterMs: 20_000,
  maxSpokenChars: 900,
  speakThoughts: true,
};

const ACTIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
const FILLERS = new Set(["äh", "ähm", "hm", "hmm", "mhm", "mh", "uh", "um", "uhm", "eh", "ah", "oh"]);
const BARGE_IN_SAMPLES = 0.45 * ASR_SAMPLE_RATE;

type Log = (msg: string) => void;

/** Speech goes out at the Opus rate, so WebRTC needn't resample again and pieces join without clicks. */
const PLAY_RATE = 48000;

export class CallSession {
  private readonly ws: WebSocket;
  private readonly audio: AudioLink;
  private readonly speech: SpeechEngine;
  private readonly t3: T3Adapter;
  private readonly log: Log;

  private settings: CallSettings = { ...DEFAULT_SETTINGS };
  private threadId: string | null = null;
  private threadTitle = "";
  // A new thread not created yet: the first thing said becomes its first message.
  private draft: { projectId: string; projectTitle: string; config: ThreadConfig | null } | null = null;
  private thoughtsSeen = new Set<string>();
  private launching: Promise<void> | null = null;
  private watcher: { stop(): void } | null = null;
  private vad: VadStream;
  private closed = false;

  // Listening
  private utterance: string[] = [];
  // Audio behind `utterance`; re-transcribed as one piece on send, since short VAD chunks lack context.
  private utteranceAudio: Float32Array[] = [];
  private vocab = new Vocabulary();
  private transcribing = 0;
  private speechSamples = 0;
  private sendTimer: NodeJS.Timeout | null = null;

  // Thread state
  private activeRunId: string | null = null;
  private runStartedAt = 0;
  private announcedReady = false;
  private spokenMessages = new Set<string>();
  private approvals = new Map<string, string>();
  private questions = new Map<string, Question[]>();
  private lastActivity: { kind: string; label: string } | null = null;
  private lastProgressPhrase = "";

  // Speaking
  // aside = a mentioned thought: dropped or cut off as soon as a real reply arrives.
  private queue: { text: string; lang: Lang; aside?: boolean }[] = [];
  private speakingAside = false;
  private speakingLoop = false;
  private generation = 0;
  private playingUntil = 0;
  private lastVoiceAt = 0;
  private recentSpoken: { text: string; until: number }[] = [];
  private lastSpoken = "";
  private ticker: NodeJS.Timeout;

  private readonly callbacks: Callbacks;
  private readonly calls: CallLog;
  private logId: string | null = null;
  // Set when this call is the answered callback: what to tell first.
  private answering: { reason: string; kind?: string; requestedAt: number } | null = null;

  constructor(ws: WebSocket, audio: AudioLink, speech: SpeechEngine, t3: T3Adapter, callbacks: Callbacks, calls: CallLog, log: Log) {
    this.callbacks = callbacks;
    this.calls = calls;
    this.ws = ws;
    this.audio = audio;
    this.speech = speech;
    this.t3 = t3;
    this.log = log;
    this.vad = speech.createVad();
    this.ticker = setInterval(() => this.progressTick(), 2000);
    audio.onAudio = (samples) => this.onAudio(samples);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.onControl(String(data)).catch((e) => this.error(e));
    });
    ws.on("close", () => this.close());
  }

  // ---------------------------------------------------------------- client protocol

  private sendJson(msg: object): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private timeline(role: "agent" | "you" | "activity" | "system", text: string): void {
    this.sendJson({ type: "timeline", role, text, at: Date.now() });
  }

  private state(): void {
    const pendingApproval = [...this.approvals.entries()].at(-1);
    this.sendJson({
      type: "state",
      threadId: this.threadId,
      threadTitle: this.threadTitle,
      agent: this.approvals.size > 0 ? "approval" : this.questions.size > 0 ? "question" : this.activeRunId ? "working" : "idle",
      approvalPrompt: pendingApproval?.[1] ?? null,
      utterance: this.utterance.join(" "),
    });
  }

  private error(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log(`call error: ${message}`);
    this.sendJson({ type: "error", message });
  }

  private async onControl(raw: string): Promise<void> {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case "start":
        this.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
        if (msg.threadId && msg.callback) await this.answerCallback(String(msg.callback), msg.threadId);
        else if (msg.threadId) await this.attach(msg.threadId);
        else if (msg.projectId) await this.startDraft(msg.projectId, String(msg.projectTitle ?? ""), msg.config ?? null);
        break;
      case "settings":
        this.settings = { ...this.settings, ...msg.settings };
        break;
      case "send_now":
        await this.flushUtterance();
        break;
      case "discard":
        this.utterance = [];
        this.utteranceAudio = [];
        this.state();
        break;
      case "text":
        if (String(msg.text ?? "").trim()) await this.dispatch(String(msg.text).trim());
        break;
      case "interrupt":
        await this.execute({ type: "interrupt" });
        break;
      case "callback":
        await this.requestCallback();
        break;
      case "hush":
        this.stopSpeaking();
        break;
      case "approve":
        await this.execute({ type: "approve", accept: msg.accept === true });
        break;
    }
  }

  // ---------------------------------------------------------------- thread

  private async startDraft(projectId: string, projectTitle: string, config: ThreadConfig | null): Promise<void> {
    this.draft = { projectId, projectTitle, config };
    this.vocab = new Vocabulary();
    this.t3
      .projectRoot(projectId)
      .then(async (dir) => {
        if (dir) await this.vocab.addFromRepo(dir);
      })
      .catch((e) => this.log(`vocab: ${e instanceof Error ? e.message : e}`));
    this.log(`call on a new thread in ${projectTitle || projectId}`);
    this.speak(say.newThread(this.settings.lang, projectTitle || "dem Projekt"), this.settings.lang);
    this.state();
  }

  /** Creates the drafted thread with `text` as its first message and follows it from then on. */
  private async launchDraft(text: string): Promise<void> {
    const draft = this.draft!;
    const thread = await this.t3.launch(draft.projectId, text, draft.config);
    this.draft = null;
    this.log(`launched ${thread.id} in ${draft.projectTitle}`);
    this.sendJson({ type: "thread", thread });
    await this.attach(thread.id, false);
  }

  /** This call is the phone picking up a callback: no greeting, say why it rang and what came out. */
  private async answerCallback(callId: string, threadId: string): Promise<void> {
    // A missed callback called back from the log is gone from Callbacks by then; the log still knows it.
    const cb = this.callbacks.answered(callId);
    const entry = this.calls.byCallback(callId);
    this.answering = {
      reason: cb?.reason ?? entry?.reason ?? "done",
      kind: cb?.kind ?? entry?.kind,
      requestedAt: cb?.requestedAt ?? entry?.requestedAt ?? Date.now() - 3600_000,
    };
    if (entry) {
      this.logId = entry.id;
      if (entry.status !== "answered") this.calls.update(entry.id, { status: "answered" });
    }
    this.log(`callback ${callId} answered`);
    await this.attach(threadId, false);
    const lang = this.settings.lang;
    this.speak(say.callbackGreeting(lang, this.answering.reason, this.answering.kind), lang);
    if (this.answering.reason === "approval" || this.answering.reason === "question") return; // the pending request is read out by itself
    const since = new Date(this.answering.requestedAt).toISOString();
    const replies = (await this.t3.history(threadId, 30)).filter((m) => m.role === "assistant" && m.createdAt >= since);
    const last = replies.at(-1);
    if (!last) return;
    this.timeline("agent", last.text);
    const spoken = toSpeakable(last.text, this.settings.maxSpokenChars);
    const msgLang = detectLang(spoken.text, lang);
    this.speak(spoken.truncated ? `${spoken.text} ${say.restInThread(msgLang)}` : spoken.text, msgLang);
  }

  /** "Call me back": register the callback, say goodbye, and hang up once that has been said. */
  private async requestCallback(): Promise<void> {
    const lang = this.settings.lang;
    if (!this.threadId) return this.speak(say.callbackFailed(lang), lang);
    if (!this.callbacks.canRing) return this.speak(say.callbackNoDevice(lang), lang);
    try {
      await this.callbacks.request(this.threadId, this.threadTitle);
    } catch (e) {
      this.speak(say.callbackFailed(lang), lang);
      throw e;
    }
    this.speak(say.callbackSet(lang), lang);
    // Wait for the goodbye to be spoken (and heard), then tell the client to hang up.
    const started = Date.now();
    while (!this.closed && Date.now() - started < 30_000 && (this.speakingLoop || this.queue.length > 0 || Date.now() < this.playingUntil)) await sleep(200);
    await sleep(400);
    this.sendJson({ type: "hangup", reason: "callback" });
  }

  private async attach(threadId: string, greet = true): Promise<void> {
    this.watcher?.stop();
    if (this.threadId) this.callbacks.setLive(this.threadId, false);
    this.callbacks.setLive(threadId, true);
    if (!this.logId)
      this.logId = this.calls.add({ direction: "outgoing", status: "active", threadId, title: this.draft?.projectTitle ? "Neuer Thread" : "", startedAt: Date.now() }).id;
    this.threadId = threadId;
    this.announcedReady = !greet;
    this.approvals.clear();
    this.questions.clear();
    this.spokenMessages.clear();
    this.vocab = new Vocabulary();
    this.loadVocab(threadId).catch((e) => this.log(`vocab: ${e instanceof Error ? e.message : e}`));
    this.watcher = await this.t3.watch(threadId, (ev) => this.onThreadEvent(ev));
    this.log(`call attached to ${threadId}`);
  }

  /** Terms from the thread's repo and recent messages, used to fix misheard names. */
  private async loadVocab(threadId: string): Promise<void> {
    const vocab = this.vocab;
    const [dir, history] = await Promise.all([this.t3.workspace(threadId), this.t3.history(threadId, 50)]);
    for (const m of history) vocab.addFromText(m.text);
    if (dir) await vocab.addFromRepo(dir);
    this.log(`vocab: ${vocab.size} terms`);
  }

  private onThreadEvent(ev: ThreadEvent): void {
    if (this.closed) return;
    if ((ev.type === "assistant" && !ev.streaming) || ev.type === "user") this.vocab.addFromText(ev.text);
    const lang = this.settings.lang;
    switch (ev.type) {
      case "ready":
        this.threadTitle = ev.title;
        if (this.logId && ev.title) this.calls.update(this.logId, { title: ev.title });
        this.activeRunId = ev.activeRunId;
        if (ev.activeRunId) this.runStartedAt = Date.now();
        if (!this.announcedReady) {
          this.announcedReady = true;
          this.speak(say.ready(lang, ev.title || "dem Thread"), lang);
        }
        break;
      case "run":
        if (ACTIVE_RUN.has(ev.status)) {
          if (this.activeRunId !== ev.runId) this.runStartedAt = Date.now();
          this.activeRunId = ev.runId;
        } else if (this.activeRunId === ev.runId || this.activeRunId === null) {
          this.activeRunId = null;
          this.lastActivity = null;
          this.lastProgressPhrase = "";
          if (ev.status === "completed") this.sendJson({ type: "earcon", name: "done" });
          else if (ev.status === "interrupted" || ev.status === "cancelled") this.speak(say.interrupted(lang), lang);
          else if (ev.status === "failed") this.speak(say.failed(lang), lang);
        }
        break;
      case "assistant": {
        if (ev.streaming || !ev.text.trim() || this.spokenMessages.has(ev.messageId)) break;
        this.spokenMessages.add(ev.messageId);
        this.dropAsides();
        this.timeline("agent", ev.text);
        const spoken = toSpeakable(ev.text, this.settings.maxSpokenChars);
        const msgLang = detectLang(spoken.text, lang);
        let text = spoken.text;
        if (spoken.truncated) text += ` ${say.restInThread(msgLang)}`;
        else if (spoken.hadCode && text.length < 40) text += ` ${say.codeInThread(msgLang)}`;
        if (text.trim()) this.speak(text, msgLang);
        break;
      }
      case "user":
        if (ev.source !== "web") this.timeline("you", ev.text);
        break;
      case "activity":
        if (ev.kind === "thinking") {
          if (ev.status === "completed" && ev.label.trim() && !this.thoughtsSeen.has(ev.itemId)) {
            this.thoughtsSeen.add(ev.itemId);
            this.onThought(ev.label);
          } else if (ev.status !== "completed") this.lastActivity = { kind: ev.kind, label: "" };
          break;
        }
        if (ev.status === "running" || ev.status === "inProgress" || ev.status === "in_progress") {
          this.lastActivity = { kind: ev.kind, label: ev.label };
          this.timeline("activity", say.activity("en", ev.kind, ev.label).replace(/\.$/, "") + (ev.kind === "command" ? `: ${ev.label.slice(0, 120)}` : ""));
        }
        break;
      case "approval":
        if (ev.status === "waiting" || ev.status === "pending") {
          if (!this.approvals.has(ev.requestId)) {
            this.approvals.set(ev.requestId, ev.prompt);
            this.timeline("system", `Approval needed: ${ev.prompt}`);
            this.speak(say.approval(lang, toSpeakable(ev.prompt, 200).text || ev.kind), lang, true);
          }
        } else this.approvals.delete(ev.requestId);
        break;
      case "question":
        if (ev.status === "waiting" || ev.status === "pending") {
          if (!this.questions.has(ev.requestId)) {
            this.questions.set(ev.requestId, ev.questions);
            this.timeline("system", ev.questions.map((q) => q.question).join("\n"));
            const text = ev.questions.length === 1 ? say.question(lang, ev.questions[0]) : say.manyQuestions(lang, ev.questions.length);
            this.speak(text, detectLang(text, lang), true);
          }
        } else this.questions.delete(ev.requestId);
        break;
      case "disconnected":
        this.timeline("system", `T3 connection lost (${ev.error}), reconnecting…`);
        break;
    }
    this.state();
  }

  /** First sentence of a thought, as a short aside. Skipped when a reply is already waiting to be read. */
  private onThought(text: string): void {
    const first = sentences(toSpeakable(text, 400).text)[0]?.trim() ?? "";
    if (!first) return;
    // A thought is an aside, so keep it to a short clause: cut at a comma/dash before ~110 chars, else at a space.
    let short = first;
    if (short.length > 110) {
      const head = short.slice(0, 110);
      const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf(" - "), head.lastIndexOf(" – "));
      short = cut > 40 ? head.slice(0, cut) : head.slice(0, head.lastIndexOf(" "));
      short += "…";
    }
    this.timeline("activity", `Thinking: ${short}`);
    if (!this.settings.speakThoughts || !this.activeRunId || this.queue.length > 0 || words(short).length < 3) return;
    const lang = detectLang(short, "en");
    this.speak(lang === "de" ? `Denkt nach: ${short}` : `Thinking: ${short}`, lang, false, true);
  }

  private dropAsides(): void {
    this.queue = this.queue.filter((i) => !i.aside);
    if (!this.speakingAside) return;
    this.generation++;
    this.playingUntil = 0;
    this.sendJson({ type: "stop_audio" });
  }

  // ---------------------------------------------------------------- listening

  private onAudio(samples: Float32Array): void {
    if (this.closed || (!this.threadId && !this.draft)) return;
    this.vad.accept(samples);
    if (this.vad.speaking()) {
      this.speechSamples += samples.length;
      if (this.sendTimer) {
        clearTimeout(this.sendTimer);
        this.sendTimer = null;
      }
      // Barge-in: talking over the call for a moment stops it.
      if (this.speechSamples > BARGE_IN_SAMPLES && Date.now() < this.playingUntil) {
        this.log("barge-in");
        this.stopSpeaking();
      }
      if (this.speechSamples === samples.length) this.sendJson({ type: "hearing", on: true });
    } else if (this.speechSamples > 0) {
      this.speechSamples = 0;
      this.sendJson({ type: "hearing", on: false });
    }
    for (const segment of this.vad.drain()) this.onSegment(segment).catch((e) => this.error(e));
  }

  private async onSegment(samples: Float32Array): Promise<void> {
    this.transcribing++;
    let text = "";
    let heard = "";
    try {
      heard = await this.speech.transcribe(samples);
      text = this.vocab.correct(heard);
      if (text !== heard) this.log(`corrected: ${heard} -> ${text}`);
    } finally {
      this.transcribing--;
    }
    recordSegment(samples, heard); // raw ASR output, so models can be compared later
    const w = words(text);
    // Whisper writes drawn-out fillers ("Ummm...", "Hmmm"); fold repeated letters before the check.
    if (w.length === 0 || (w.length === 1 && FILLERS.has(w[0].replace(/(.)\1+/g, "$1")))) return this.scheduleSend();

    // Drop what is most likely our own voice coming back through the mic.
    const now = Date.now();
    this.recentSpoken = this.recentSpoken.filter((s) => s.until > now - 8000);
    const echo = this.recentSpoken.some((s) => echoScore(text, s.text) >= 0.6) && w.length >= 2;
    if (echo) {
      this.log(`dropped echo: ${text}`);
      return this.scheduleSend();
    }

    if (this.utterance.length === 0) {
      const intent = parseIntent(text, this.approvals.size > 0);
      if (intent.type !== "message") {
        this.timeline("you", text);
        return this.execute(intent);
      }
    }
    this.utterance.push(text);
    this.utteranceAudio.push(samples);
    this.state();
    this.scheduleSend();
  }

  private scheduleSend(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    if (this.utterance.length === 0 || this.vad.speaking() || this.transcribing > 0) return;
    this.sendTimer = setTimeout(() => this.flushUtterance().catch((e) => this.error(e)), this.settings.sendAfterMs);
    this.sendJson({ type: "sending_in", ms: this.settings.sendAfterMs });
  }

  private async flushUtterance(): Promise<void> {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    let text = this.utterance.join(" ").trim();
    const audio = this.utteranceAudio;
    this.utterance = [];
    this.utteranceAudio = [];
    this.state();
    if (audio.length > 1 && this.speech.retranscribe) {
      const gap = new Float32Array(ASR_SAMPLE_RATE * 0.3);
      const joined = new Float32Array(audio.reduce((n, a) => n + a.length + gap.length, 0));
      let o = 0;
      for (const a of audio) { joined.set(a, o); o += a.length + gap.length; }
      const whole = this.vocab.correct((await this.speech.transcribe(joined)).trim());
      if (whole) {
        this.log(`retranscribed: ${text} -> ${whole}`);
        recordSegment(joined, whole);
        text = whole;
      }
    }
    if (text) await this.dispatch(text);
  }

  private async dispatch(text: string): Promise<void> {
    // Whatever is said while the new thread is being created goes to it once it exists.
    if (this.launching) await this.launching.catch(() => undefined);
    const lang = this.settings.lang;
    if (!this.threadId && this.draft) {
      this.timeline("you", text);
      this.launching = this.launchDraft(this.settings.voiceHint ? text + VOICE_HINT : text);
      try {
        await this.launching;
        this.sendJson({ type: "earcon", name: "sent" });
        this.sendJson({ type: "sent", text, mode: "auto" });
        if (CALLBACK_RE.test(text)) this.requestCallback().catch((e) => this.error(e));
      } catch (e) {
        this.speak(say.launchFailed(lang), lang);
        throw e;
      } finally {
        this.launching = null;
      }
      return;
    }
    if (!this.threadId) return;
    this.timeline("you", text);
    try {
      // A pending question takes the reply as its answer.
      const pendingQuestion = [...this.questions.entries()].at(-1);
      if (pendingQuestion && pendingQuestion[1].length === 1) {
        const [requestId, [q]] = pendingQuestion;
        const answer = matchAnswer(text, q);
        if (answer !== null) {
          await this.t3.answer(this.threadId, requestId, { [q.id]: answer });
          this.questions.delete(requestId);
          this.speak(say.answered(lang), lang);
          this.state();
          return;
        }
      }
      const mode = this.activeRunId ? this.settings.whileRunning : "auto";
      await this.t3.send(this.threadId, this.settings.voiceHint ? text + VOICE_HINT : text, mode);
      this.sendJson({ type: "earcon", name: "sent" });
      this.sendJson({ type: "sent", text, mode });
      this.log(`sent (${mode}): ${text}`);
      if (CALLBACK_RE.test(text)) this.requestCallback().catch((e) => this.error(e));
    } catch (e) {
      this.speak(say.sendFailed(lang), lang);
      throw e;
    }
  }

  private async execute(intent: Intent): Promise<void> {
    const lang = this.settings.lang;
    switch (intent.type) {
      case "interrupt":
        this.stopSpeaking();
        if (this.activeRunId && this.threadId) await this.t3.interrupt(this.threadId, this.activeRunId);
        break;
      case "hush":
        this.stopSpeaking();
        break;
      case "repeat":
        this.speak(this.lastSpoken || say.nothingToRepeat(lang), lang);
        break;
      case "status":
        this.speak(this.activeRunId ? (this.lastActivity ? say.activity(lang, this.lastActivity.kind, this.lastActivity.label) : say.stillWorking(lang)) : say.idle(lang), lang);
        break;
      case "callback":
        await this.requestCallback();
        break;
      case "approve": {
        const pending = [...this.approvals.keys()].at(-1);
        if (!pending || !this.threadId) break;
        await this.t3.approve(this.threadId, pending, intent.accept);
        this.approvals.delete(pending);
        this.speak(say.approved(lang, intent.accept), lang);
        this.state();
        break;
      }
    }
  }

  // ---------------------------------------------------------------- speaking

  private speak(text: string, lang: Lang, urgent = false, aside = false): void {
    if (urgent) this.queue.unshift({ text, lang, aside });
    else this.queue.push({ text, lang, aside });
    if (!this.speakingLoop) this.runSpeaker().catch((e) => this.error(e));
  }

  private stopSpeaking(): void {
    this.generation++;
    this.queue = [];
    this.playingUntil = 0;
    this.audio.stop();
    this.sendJson({ type: "stop_audio" });
  }

  private userBusy(): boolean {
    return this.vad.speaking() || this.utterance.length > 0 || this.transcribing > 0;
  }

  private async runSpeaker(): Promise<void> {
    this.speakingLoop = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const item = this.queue.shift()!;
        const gen = this.generation;
        this.speakingAside = item.aside === true;
        const spoken: string[] = [];
        for (const sentence of sentences(item.text)) {
          // Don't talk over the user; wait (up to 20 s) until they're done.
          for (let waited = 0; this.userBusy() && waited < 20_000 && gen === this.generation; waited += 150) await sleep(150);
          if (gen !== this.generation) break;
          // Streamed: the GPU voice sends pieces while it generates, so playback starts after ~0.4 s instead of after
          // the whole sentence. One resampler per sentence keeps the piece boundaries click-free (48 kHz = Opus rate).
          const abort = new AbortController();
          let resampler: SincStream | null = null;
          let entry: { text: string; until: number } | null = null;
          const out = (samples: Float32Array) => {
            if (samples.length === 0) return;
            if (!entry) {
              this.sendJson({ type: "say", text: sentence, sampleRate: PLAY_RATE });
              this.recentSpoken.push((entry = { text: sentence, until: 0 }));
            }
            this.audio.play(samples, PLAY_RATE);
            this.playingUntil = Math.max(Date.now(), this.playingUntil) + (samples.length / PLAY_RATE) * 1000;
            this.lastVoiceAt = entry.until = this.playingUntil;
          };
          for await (const piece of this.speech.synthesizeStream(sentence, item.lang, abort.signal)) {
            if (gen !== this.generation || this.closed) break;
            resampler ??= new SincStream(piece.sampleRate, PLAY_RATE);
            out(resampler.push(piece.samples));
          }
          if (gen !== this.generation || this.closed) {
            abort.abort(); // barge-in: the server stops generating too
            break;
          }
          if (resampler) out(resampler.end());
          if (!entry) continue;
          spoken.push(sentence);
          // Stay at most ~1.5 s ahead of playback so a barge-in cuts off little.
          await sleep(Math.max(0, this.playingUntil - Date.now() - 1500));
        }
        this.speakingAside = false;
        if (spoken.length > 0 && !item.aside) this.lastSpoken = spoken.join(" ");
      }
    } finally {
      this.speakingLoop = false;
      this.speakingAside = false;
    }
  }

  private progressTick(): void {
    if (!this.activeRunId || this.speakingLoop || this.userBusy() || this.approvals.size > 0) return;
    const now = Date.now();
    const quietFor = now - Math.max(this.lastVoiceAt, this.runStartedAt);
    if (quietFor < this.settings.progressAfterMs) return;
    const lang = this.settings.lang;
    const phrase = this.lastActivity ? say.activity(lang, this.lastActivity.kind, this.lastActivity.label) : say.stillWorking(lang);
    // Repeating the same update every 20 s gets old; back off to every 60 s.
    if (phrase === this.lastProgressPhrase && quietFor < this.settings.progressAfterMs * 3) return;
    this.lastProgressPhrase = phrase;
    this.speak(phrase, lang);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.threadId) this.callbacks.setLive(this.threadId, false);
    if (this.logId) {
      const e = this.calls.get(this.logId);
      this.calls.update(this.logId, { endedAt: Date.now(), ...(e?.status === "active" ? { status: "completed" } : {}) });
    }
    clearInterval(this.ticker);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.watcher?.stop();
    this.generation++;
    this.audio.close();
    this.log("call closed");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
