// Minimal client for the T3 Code server's WebSocket RPC (Effect RPC, JSON framing).
//
// This is the only module that knows T3's wire protocol. Everything T3-specific the
// rest of the app relies on lives here or in t3adapter.ts, so a T3 update that changes
// the protocol should only need changes in these two files.
//
// Verified against t3 0.1.1-nightly.20261020.3386 (orchestration protocol 2).

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export const SUPPORTED_PROTOCOL = 2;
export const REQUIRED_CAPABILITIES = ["serverResolvedCommandContext", "threadStop"] as const;

type Json = any;

interface Pending {
  kind: "unary" | "stream";
  resolve?: (value: Json) => void;
  reject?: (error: Error) => void;
  onItem?: (item: Json) => void;
  onEnd?: (error?: Error) => void;
}

export interface StreamHandle {
  cancel(): void;
}

export class T3RpcError extends Error {
  readonly detail?: Json;
  constructor(message: string, detail?: Json) {
    super(message);
    this.detail = detail;
  }
}

export class T3Client extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    super();
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /** Reads the server descriptor and refuses to run against an incompatible server. */
  async checkCompatibility(): Promise<{ serverVersion: string; label: string }> {
    const res = await fetch(`${this.baseUrl}/.well-known/t3/environment`);
    if (!res.ok) throw new Error(`T3 descriptor request failed: HTTP ${res.status}`);
    const d = await res.json();
    if (d.orchestrationProtocolVersion !== SUPPORTED_PROTOCOL) {
      throw new Error(
        `T3 server ${d.serverVersion} speaks orchestration protocol ${d.orchestrationProtocolVersion}, ` +
          `Yapper supports ${SUPPORTED_PROTOCOL}. Update t3client.ts/t3adapter.ts.`,
      );
    }
    const missing = REQUIRED_CAPABILITIES.filter((c) => d.capabilities?.[c] !== true);
    if (missing.length > 0) throw new Error(`T3 server ${d.serverVersion} lacks capabilities: ${missing.join(", ")}`);
    return { serverVersion: d.serverVersion, label: d.label };
  }

  async getJson(path: string): Promise<Json> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, "x-t3-orchestration-protocol": String(SUPPORTED_PROTOCOL) },
    });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private async open(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`websocket ticket: HTTP ${res.status}`);
    const { ticket } = await res.json();
    const url = new URL("/ws", this.baseUrl.replace(/^http/, "ws"));
    url.searchParams.set("orchestrationProtocol", String(SUPPORTED_PROTOCOL));
    url.searchParams.set("wsTicket", ticket);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("T3 websocket open timeout")), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("T3 websocket error"));
      };
      ws.onmessage = (m) => this.onFrame(String(m.data));
      ws.onclose = (e) => {
        if (this.ws === ws) this.ws = null;
        const err = new Error(`T3 websocket closed (${e.code})`);
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          if (p.kind === "unary") p.reject?.(err);
          else p.onEnd?.(err);
        }
        if (!this.closed) this.emit("disconnected", err);
      };
    });
  }

  private send(frame: Json): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("T3 websocket not open");
    this.ws.send(JSON.stringify(frame));
  }

  private onFrame(raw: string): void {
    let decoded: Json;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }
    for (const msg of Array.isArray(decoded) ? decoded : [decoded]) {
      switch (msg._tag) {
        case "Ping":
          this.send({ _tag: "Pong" });
          break;
        case "Chunk": {
          const p = this.pending.get(String(msg.requestId));
          // Streams are backpressured: the server waits for an Ack before the next chunk.
          this.send({ _tag: "Ack", requestId: msg.requestId });
          if (p?.onItem) for (const v of msg.values) p.onItem(v);
          break;
        }
        case "Exit": {
          const id = String(msg.requestId);
          const p = this.pending.get(id);
          if (!p) break;
          this.pending.delete(id);
          const exit = msg.exit;
          if (exit?._tag === "Success") {
            if (p.kind === "unary") p.resolve?.(exit.value);
            else p.onEnd?.();
          } else {
            const fail = exit?.cause?.find((c: Json) => c._tag === "Fail");
            const error = new T3RpcError(
              fail?.error?.message ?? fail?.error?._tag ?? JSON.stringify(exit?.cause ?? exit).slice(0, 300),
              fail?.error ?? exit?.cause,
            );
            if (p.kind === "unary") p.reject?.(error);
            else p.onEnd?.(error);
          }
          break;
        }
        case "Defect":
          this.emit("defect", msg.defect);
          break;
      }
    }
  }

  async request(tag: string, payload: Json): Promise<Json> {
    await this.connect();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "unary", resolve, reject });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  async stream(tag: string, payload: Json, onItem: (item: Json) => void, onEnd: (error?: Error) => void): Promise<StreamHandle> {
    await this.connect();
    const id = String(this.nextId++);
    this.pending.set(id, { kind: "stream", onItem, onEnd });
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return {
      cancel: () => {
        if (!this.pending.delete(id)) return;
        try {
          this.send({ _tag: "Interrupt", requestId: id, interruptors: [] });
        } catch {
          // socket already gone
        }
      },
    };
  }
}

export const newId = (): string => randomUUID();
