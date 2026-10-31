// Translates T3's orchestration protocol into the handful of events and actions a voice
// call needs. Together with t3client.ts this is the whole T3 surface of the app.

import { T3Client, newId, type StreamHandle } from "./t3client.ts";

export type SendMode = "auto" | "steer" | "queue";

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: { id: string; value: string | boolean }[];
}

/** How a thread runs: model (+ reasoning etc. in options), permission mode, plan or normal. */
export interface ThreadConfig {
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
}

export interface ModelCatalog {
  providers: {
    instanceId: string;
    displayName: string;
    models: {
      slug: string;
      name: string;
      legacy: boolean;
      options: { id: string; label: string; type: string; options?: { id: string; label: string; isDefault?: boolean }[]; currentValue?: unknown }[];
    }[];
  }[];
  runtimeModes: string[];
  defaults: ThreadConfig;
}

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"];

export interface ThreadSummary {
  id: string;
  title: string;
  projectTitle: string;
  status: string;
  running: boolean;
  updatedAt: string;
  pinned: boolean;
  config: ThreadConfig | null;
}

export interface ProjectSummary {
  id: string;
  title: string;
  lastUsedAt: string;
}

export interface Question {
  id: string;
  header: string;
  question: string;
  options: { label: string; value: string }[];
  allowCustomAnswer: boolean;
}

export type ThreadEvent =
  | { type: "ready"; activeRunId: string | null; title: string }
  | { type: "run"; runId: string; status: string }
  | { type: "assistant"; messageId: string; runId: string | null; text: string; streaming: boolean }
  | { type: "user"; messageId: string; text: string; source: string }
  | { type: "activity"; itemId: string; kind: string; label: string; status: string }
  | { type: "approval"; requestId: string; kind: string; prompt: string; status: string }
  | { type: "question"; requestId: string; questions: Question[]; status: string }
  | { type: "disconnected"; error: string };

const ACTIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);

export class T3Adapter {
  readonly client: T3Client;

  constructor(client: T3Client) {
    this.client = client;
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const shell = await this.client.getJson("/api/orchestration/shell");
    const snap = shell.snapshot ?? shell;
    const projects = new Map<string, string>(snap.projects.map((p: any) => [p.id, p.title]));
    return snap.threads
      .filter((t: any) => !t.archivedAt && !t.deletedAt)
      .map((t: any) => ({
        id: t.id,
        title: t.title,
        projectTitle: projects.get(t.projectId) ?? "",
        status: t.status,
        running: t.activeRunId != null,
        updatedAt: t.updatedAt,
        pinned: t.pinnedAt != null,
        config: t.modelSelection
          ? { modelSelection: t.modelSelection, runtimeMode: t.runtimeMode ?? "full-access", interactionMode: t.interactionMode ?? "default" }
          : null,
      }))
      .sort((a: ThreadSummary, b: ThreadSummary) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Projects, most recently used first (by their newest thread). */
  async listProjects(): Promise<ProjectSummary[]> {
    const snap = await this.snapshot();
    const lastUsed = new Map<string, string>();
    for (const t of snap.threads) if (t.updatedAt > (lastUsed.get(t.projectId) ?? "")) lastUsed.set(t.projectId, t.updatedAt);
    return snap.projects
      .filter((p: any) => !p.deletedAt)
      .map((p: any) => ({ id: p.id, title: p.title, lastUsedAt: lastUsed.get(p.id) ?? p.updatedAt ?? "" }))
      .sort((a: ProjectSummary, b: ProjectSummary) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  async projectRoot(projectId: string): Promise<string | null> {
    const snap = await this.snapshot();
    return snap.projects.find((p: any) => p.id === projectId)?.workspaceRoot ?? null;
  }

  private catalog: { at: number; value: ModelCatalog } | null = null;

  /** Ready providers and their current models with option descriptors (reasoning etc.), plus T3's defaults. */
  async models(): Promise<ModelCatalog> {
    if (this.catalog && Date.now() - this.catalog.at < 60_000) return this.catalog.value;
    const [config, settings] = await Promise.all([this.client.request("server.getConfig", {}), this.client.request("server.getSettings", {})]);
    const providers = (config.providers ?? [])
      .filter((p: any) => p.enabled && p.status === "ready" && (p.models ?? []).length > 0)
      .map((p: any) => ({
        instanceId: p.instanceId,
        displayName: p.displayName,
        models: p.models.map((m: any) => ({
          slug: m.slug,
          name: m.name,
          legacy: m.isLegacy === true,
          options: m.capabilities?.optionDescriptors ?? [],
        })),
      }));
    const value: ModelCatalog = {
      providers,
      runtimeModes: RUNTIME_MODES,
      defaults: {
        modelSelection: settings.defaultModelSelection ?? { instanceId: providers[0]?.instanceId, model: providers[0]?.models[0]?.slug },
        runtimeMode: settings.defaultRuntimeMode ?? "full-access",
        interactionMode: "default",
      },
    };
    this.catalog = { at: Date.now(), value };
    return value;
  }

  /** What a new thread in the project starts with unless told otherwise: the project's default model, else T3's. */
  async defaults(projectId: string): Promise<ThreadConfig> {
    const [snap, catalog] = await Promise.all([this.snapshot(), this.models()]);
    const project = snap.projects.find((p: any) => p.id === projectId);
    return { ...catalog.defaults, ...(project?.defaultModelSelection ? { modelSelection: project.defaultModelSelection } : {}) };
  }

  /** Changes a thread's model/options, runtime mode or interaction mode; takes effect from its next turn. */
  async setConfig(threadId: string, config: Partial<ThreadConfig>): Promise<void> {
    if (config.modelSelection)
      await this.client.request("orchestration.dispatchCommand", { type: "thread.model-selection.set", commandId: newId(), threadId, modelSelection: config.modelSelection });
    if (config.runtimeMode)
      await this.client.request("orchestration.dispatchCommand", { type: "thread.runtime-mode.set", commandId: newId(), threadId, runtimeMode: config.runtimeMode });
    if (config.interactionMode)
      await this.client.request("orchestration.dispatchCommand", { type: "thread.interaction-mode.set", commandId: newId(), threadId, interactionMode: config.interactionMode });
  }

  /**
   * Starts a thread in a project with `text` as its first message, with `config` or the project's defaults.
   * T3 generates the title from the message.
   */
  async launch(projectId: string, text: string, config?: ThreadConfig | null): Promise<ThreadSummary> {
    const snap = await this.snapshot();
    const project = snap.projects.find((p: any) => p.id === projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const cfg = config?.modelSelection ? config : await this.defaults(projectId);
    const seed = text.replace(/\s+/g, " ").trim().slice(0, 60);
    const launched = await this.client.request("orchestration.launchThread", {
      commandId: newId(),
      creationSource: "web",
      projectId,
      title: seed || "New thread",
      generateTitle: true,
      modelSelection: cfg.modelSelection,
      runtimeMode: cfg.runtimeMode,
      interactionMode: cfg.interactionMode,
      workspaceStrategy: { type: "root" },
      initialMessage: { text, attachments: [] },
    });
    return {
      id: launched.threadId,
      title: launched.projection?.thread?.title ?? seed,
      projectTitle: project.title,
      status: launched.projection?.thread?.status ?? "running",
      running: true,
      updatedAt: new Date().toISOString(),
      pinned: false,
      config: cfg,
    };
  }

  /**
   * The T3 thread a Claude Code session is running in, found through the native thread id T3 records on each run
   * attempt. Only threads with an active run are searched, since the caller is an agent mid-turn.
   */
  async threadForSession(sessionId: string): Promise<{ id: string; title: string } | null> {
    const snap = await this.snapshot();
    const running = snap.threads.filter((t: any) => t.activeRunId).slice(0, 30);
    for (const t of running) {
      const projection = await this.client.request("orchestration.getThreadProjection", { threadId: t.id }).catch(() => null);
      if (projection && (projection.attempts ?? []).some((a: any) => a.nativeThreadId === sessionId)) return { id: t.id, title: t.title };
    }
    return null;
  }

  private async snapshot(): Promise<any> {
    const shell = await this.client.getJson("/api/orchestration/shell");
    return shell.snapshot ?? shell;
  }

  /** Directory the thread works in: its worktree, else the project root. */
  async workspace(threadId: string): Promise<string | null> {
    const shell = await this.client.getJson("/api/orchestration/shell");
    const snap = shell.snapshot ?? shell;
    const thread = snap.threads.find((t: any) => t.id === threadId);
    if (!thread) return null;
    return thread.worktreePath ?? snap.projects.find((p: any) => p.id === thread.projectId)?.workspaceRoot ?? null;
  }

  /** Last visible chat messages of a thread, oldest first. */
  async history(threadId: string, limit = 20): Promise<{ role: string; text: string; createdAt: string }[]> {
    const projection = await this.client.request("orchestration.getThreadProjection", { threadId });
    return (projection.messages ?? [])
      .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
      .slice(-limit)
      .map((m: any) => ({ role: m.role, text: m.text, createdAt: m.createdAt }));
  }

  /** Follows a thread live. Resubscribes from the last sequence after a disconnect. */
  async watch(threadId: string, onEvent: (event: ThreadEvent) => void): Promise<{ stop(): void }> {
    let handle: StreamHandle | null = null;
    let stopped = false;
    let lastSequence: number | undefined;
    let retry = 0;

    const subscribe = async (): Promise<void> => {
      const payload: any = { threadId, acceptCompactTurnItems: true };
      if (lastSequence !== undefined) payload.afterSequence = lastSequence;
      handle = await this.client.stream(
        "orchestration.subscribeThread",
        payload,
        (item) => {
          retry = 0;
          if (typeof item.sequence === "number") lastSequence = item.sequence;
          if (item.kind === "snapshot") {
            lastSequence = item.snapshotSequence;
            const p = item.projection;
            const active = (p.runs ?? []).findLast((r: any) => ACTIVE_RUN.has(r.status));
            onEvent({ type: "ready", activeRunId: active?.id ?? null, title: p.thread?.title ?? "" });
            for (const turnItem of (p.turnItems ?? []).filter((i: any) => i.status === "waiting")) {
              const ev = mapTurnItem(turnItem);
              if (ev) onEvent(ev);
            }
          } else if (item.kind === "event") {
            const ev = mapEvent(item.event);
            if (ev) onEvent(ev);
          }
        },
        (error) => {
          if (stopped) return;
          onEvent({ type: "disconnected", error: error?.message ?? "stream ended" });
          const delay = Math.min(15_000, 500 * 2 ** retry++);
          setTimeout(() => !stopped && subscribe().catch(() => undefined), delay);
        },
      );
    };
    await subscribe();
    return {
      stop() {
        stopped = true;
        handle?.cancel();
      },
    };
  }

  async send(threadId: string, text: string, mode: SendMode): Promise<void> {
    // With serverResolvedCommandContext the server picks the active run itself.
    await this.client.request("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: newId(),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: newId(),
      text,
      attachments: [],
      ...(mode === "queue" ? {} : { deliveryIntent: mode }),
      dispatchMode: mode === "queue" ? { type: "queue_after_active" } : { type: "start_immediately" },
    });
  }

  async interrupt(threadId: string, runId: string): Promise<void> {
    await this.client.request("orchestration.dispatchCommand", { type: "run.interrupt", commandId: newId(), threadId, runId });
  }

  async approve(threadId: string, requestId: string, accept: boolean): Promise<void> {
    await this.client.request("orchestration.dispatchCommand", {
      type: "runtime-request.respond",
      commandId: newId(),
      threadId,
      requestId,
      decision: accept ? "accept" : "decline",
    });
  }

  async answer(threadId: string, requestId: string, answers: Record<string, string>): Promise<void> {
    await this.client.request("orchestration.dispatchCommand", {
      type: "runtime-request.respond",
      commandId: newId(),
      threadId,
      requestId,
      answers,
    });
  }
}

function mapEvent(event: any): ThreadEvent | null {
  const p = event.payload ?? {};
  switch (event.type) {
    case "run.updated":
      return { type: "run", runId: p.id, status: p.status };
    case "message.updated":
      if (p.role === "assistant") return { type: "assistant", messageId: p.id, runId: p.runId ?? null, text: p.text ?? "", streaming: p.streaming === true };
      if (p.role === "user") return { type: "user", messageId: p.id, text: p.text ?? "", source: p.creationSource ?? "" };
      return null;
    case "turn-item.updated":
      return mapTurnItem(p);
    default:
      return null;
  }
}

function mapTurnItem(p: any): ThreadEvent | null {
  switch (p.type) {
    case "approval_request":
      return { type: "approval", requestId: p.requestId, kind: p.requestKind ?? "", prompt: p.prompt ?? "", status: p.status };
    case "user_input_request":
      return {
        type: "question",
        requestId: p.requestId,
        status: p.status,
        questions: (p.questions ?? []).map((q: any) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          options: (q.options ?? []).map((o: any) => ({ label: o.label, value: o.value ?? o.label })),
          allowCustomAnswer: q.allowCustomAnswer !== false,
        })),
      };
    case "command_execution":
      return { type: "activity", itemId: p.id, kind: "command", label: String(p.input ?? ""), status: p.status };
    case "file_change":
      return { type: "activity", itemId: p.id, kind: "file", label: String(p.fileName ?? ""), status: p.status };
    case "web_search":
      return { type: "activity", itemId: p.id, kind: "search", label: String(p.patterns?.[0] ?? p.title ?? ""), status: p.status };
    case "file_search":
      return { type: "activity", itemId: p.id, kind: "search-files", label: String(p.pattern ?? ""), status: p.status };
    case "reasoning":
      // The label is the (summarised) thought itself; call.ts can mention it.
      return { type: "activity", itemId: p.id, kind: "thinking", label: String(p.text ?? ""), status: p.status };
    case "dynamic_tool":
      return { type: "activity", itemId: p.id, kind: "tool", label: String(p.toolName ?? p.title ?? ""), status: p.status };
    case "subagent":
      return { type: "activity", itemId: p.id, kind: "subagent", label: String(p.title ?? p.prompt ?? "").slice(0, 120), status: p.status };
    case "error":
      return { type: "activity", itemId: p.id, kind: "error", label: String(p.failure?.message ?? p.title ?? ""), status: p.status };
    default:
      return null;
  }
}
