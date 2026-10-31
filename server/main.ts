// Yapper server: serves the call web app, lists T3 threads, and runs voice calls.
//
// Yapper has no login of its own. Who may call is decided by a header that only a trusted front can set:
//   - YAP_AUTH_HEADER (default Remote-User), on requests from an address in YAP_TRUSTED_PROXIES
//     (your reverse proxy with SSO, e.g. Authelia/Authentik/oauth2-proxy forward auth)
//   - YAP_LOOPBACK_AUTH_HEADER (default Tailscale-User-Login), on requests from loopback (`tailscale serve`)
// The user must then be in YAP_ALLOWED_USERS (empty = anyone the front lets through).
// Everything else is refused, except /api/health (monitoring) and the PWA manifest + icon.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { T3Client } from "./t3client.ts";
import { T3Adapter } from "./t3adapter.ts";
import { loadSpeech } from "./speech.ts";
import { CallSession } from "./call.ts";
import { AudioLink } from "./transport.ts";
import { rtcConfigFromEnv } from "./transport-rtc.ts";
import { pruneRecordings } from "./recorder.ts";
import { Callbacks, nextCallWindow } from "./callbacks.ts";
import { CallLog } from "./calllog.ts";
import { detectLang, sentences, toSpeakable } from "./speakable.ts";
import { resample } from "./audio.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Built web client (`npm run build` → vite build web).
const WEB = join(ROOT, "web", "dist");

/** Reads YAP_ENV_FILE (default ./.env) into process.env; variables already set win. */
function loadEnv(): Record<string, string> {
  const file = process.env.YAP_ENV_FILE ?? join(ROOT, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
  return process.env as Record<string, string>;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const env = loadEnv();
const HOST = env.YAP_HOST ?? "127.0.0.1";
const PORT = Number(env.YAP_PORT ?? 8790);
const ALLOWED = list(env.YAP_ALLOWED_USERS);
const TRUSTED_PROXIES = list(env.YAP_TRUSTED_PROXIES).map((a) => a.replace(/^::ffff:/, ""));
// Header names are case-insensitive; Node lowercases incoming ones. Set to "" (or "none") to disable that path.
const header = (v: string | undefined, fallback: string) => {
  const h = (v ?? fallback).trim().toLowerCase();
  return h && h !== "none" ? h : null;
};
const AUTH_HEADER = header(env.YAP_AUTH_HEADER, "remote-user");
const LOOPBACK_AUTH_HEADER = header(env.YAP_LOOPBACK_AUTH_HEADER, "tailscale-user-login");
const DEV = env.YAP_DEV === "1";
if (!env.T3_TOKEN) throw new Error("T3_TOKEN missing (set it in .env, see .env.example; issue one with: t3 auth session issue --scope orchestration:read --scope orchestration:operate)");

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
if (DEV) log("YAP_DEV=1: unauthenticated requests from loopback are let in. Don't use this behind a reverse proxy on the same host.");
if (!DEV && !(TRUSTED_PROXIES.length && AUTH_HEADER) && !LOOPBACK_AUTH_HEADER)
  log("warning: no way to log in (set YAP_TRUSTED_PROXIES + YAP_AUTH_HEADER, YAP_LOOPBACK_AUTH_HEADER, or YAP_DEV=1 for local testing)");
if (!ALLOWED.length) log("warning: YAP_ALLOWED_USERS is empty, so every user your proxy authenticates may call");

const client = new T3Client(env.T3_URL ?? "http://127.0.0.1:3773", env.T3_TOKEN);
const server = await client.checkCompatibility();
if (!existsSync(join(WEB, "index.html"))) log(`web client not built: run "npm run build" (expected ${WEB})`);
log(`T3 ${server.label} ${server.serverVersion}: compatible`);
const t3 = new T3Adapter(client);
client.on("disconnected", (e: Error) => log(`T3 websocket: ${e.message}`));

log("loading speech models…");
const speech = await loadSpeech();
log("speech models ready");

const calls = new CallLog();
const callbacks = new Callbacks(t3, log);

/** The reply a callback is about, as text and in the call's voice, so a missed one can be heard later. */
async function recordCallbackSummary(entryId: string, threadId: string, requestedAt: number): Promise<void> {
  const since = new Date(requestedAt).toISOString();
  const last = (await t3.history(threadId, 30)).filter((m) => m.role === "assistant" && m.createdAt >= since).at(-1);
  if (!last) return;
  const spoken = toSpeakable(last.text, 900);
  calls.update(entryId, { summary: last.text });
  const lang = detectLang(spoken.text, "de");
  const parts: Float32Array[] = [];
  let rate = 0;
  for (const sentence of sentences(spoken.text)) {
    const a = await speech.synthesize(sentence, lang);
    const samples = rate && a.sampleRate !== rate ? resample(a.samples, a.sampleRate, rate) : a.samples;
    rate ||= a.sampleRate;
    parts.push(samples, new Float32Array(Math.round(rate * 0.25)));
  }
  if (!parts.length) return;
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (all.set(p, o), (o += p.length));
  calls.saveAudio(entryId, all, rate);
}

callbacks.onRing = (cb) => {
  const e = calls.add({ direction: "incoming", status: "ringing", threadId: cb.threadId, title: cb.title, startedAt: cb.rangAt ?? Date.now(), callbackId: cb.id, reason: cb.reason, kind: cb.kind, requestedAt: cb.requestedAt });
  recordCallbackSummary(e.id, cb.threadId, cb.requestedAt).catch((err) => log(`call log summary: ${(err as Error).message}`));
};
callbacks.onAnswered = (cb) => {
  const e = calls.byCallback(cb.id);
  if (e) calls.update(e.id, { status: "answered" });
};
callbacks.onMissed = (cb) => {
  const e = calls.byCallback(cb.id);
  if (e && e.status === "ringing") calls.update(e.id, { status: "missed", endedAt: Date.now() });
};
await callbacks.resume();

const rtc = rtcConfigFromEnv(env);
log(rtc ? `webrtc audio: host candidates ${rtc.ips.join(", ")}${rtc.ports ? `, udp ${rtc.ports.join("-")}` : ""}` : "webrtc audio: off");

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

/** The calling user, or null if the request didn't come through a trusted front. */
function caller(req: IncomingMessage): string | null {
  const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const value = (name: string | null) => {
    const v = name ? req.headers[name] : undefined;
    return typeof v === "string" && v ? v : null;
  };
  let user: string | null = null;
  if (TRUSTED_PROXIES.includes(remote)) user = value(AUTH_HEADER);
  else if (LOOPBACK.has(remote)) {
    user = value(LOOPBACK_AUTH_HEADER);
    if (!user && DEV) return "dev"; // YAP_DEV: local testing without a front, skips the allowlist
  }
  if (!user) return null;
  return ALLOWED.length === 0 || ALLOWED.includes(user) ? user : null;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("request body too large");
  }
  return body;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Open for monitoring; listing threads proves the T3 token and protocol still work, without returning any.
    if (url.pathname === "/api/health") {
      const ok = await t3.listThreads().then(() => true, () => false);
      return json(res, ok ? 200 : 503, { ok, t3: server.serverVersion });
    }
    // Chrome fetches the PWA manifest and its icon without cookies, so they're open too (nothing private in them).
    const open = url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg";
    // Agents on this host (scripts/yap-mcp.ts, tool "call_me_back"): loopback plus YAP_AGENT_TOKEN, not a user login.
    if (url.pathname === "/api/agent/callback" && req.method === "POST") {
      const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
      const want = Buffer.from(env.YAP_AGENT_TOKEN ?? "");
      if (!LOOPBACK.has(remote) || !want.length || given.length !== want.length || !timingSafeEqual(given, want))
        return json(res, 403, { error: "forbidden" });
      const { sessionId, kind: rawKind } = JSON.parse((await readBody(req)) || "{}");
      const kind = rawKind === "assistance" || rawKind === "info" ? rawKind : "requested";
      if (typeof sessionId !== "string" || !sessionId) return json(res, 400, { error: "sessionId required" });
      if (!callbacks.canRing) return json(res, 409, { error: "no phone registered for callbacks (open the Yapper Android app once)" });
      const thread = await t3.threadForSession(sessionId);
      if (!thread) return json(res, 404, { error: "no running T3 thread found for this session" });
      const cb = await callbacks.request(thread.id, thread.title, kind);
      log(`agent asked for a callback (${kind}) on ${thread.title || thread.id}`);
      const heldUntil = kind === "requested" ? null : nextCallWindow();
      return json(res, 200, { ok: true, callId: cb.id, threadId: thread.id, title: thread.title, kind, heldUntil: heldUntil?.getTime() ?? null });
    }
    if (!open && !caller(req)) return json(res, 403, { error: "forbidden" });

    // Writes are JSON only, so a cross-site form can't post here.
    const jsonBody = async () => {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw Object.assign(new Error("json only"), { status: 415 });
      return JSON.parse((await readBody(req)) || "{}");
    };
    if (url.pathname === "/api/threads" && req.method === "POST") {
      // Typed first message of a new thread, without a call.
      const body = await jsonBody();
      if (typeof body.projectId !== "string" || typeof body.text !== "string" || !body.text.trim())
        return json(res, 400, { error: "projectId and text required" });
      return json(res, 200, await t3.launch(body.projectId, body.text.trim(), body.config ?? null));
    }
    const config = url.pathname.match(/^\/api\/threads\/([^/]+)\/config$/);
    if (config && req.method === "POST") {
      const body = await jsonBody();
      await t3.setConfig(decodeURIComponent(config[1]), body);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/models") return json(res, 200, await t3.models());
    if (url.pathname === "/api/push/register" && req.method === "POST") {
      // The Android app's UnifiedPush endpoint, posted by web/src/native.ts with the login cookie.
      const body = await jsonBody();
      if (typeof body.endpoint !== "string" || !body.endpoint) return json(res, 400, { error: "endpoint required" });
      callbacks.register(body.endpoint, String(body.device || "phone").slice(0, 80));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/push/status") return json(res, 200, { canRing: callbacks.canRing });
    if (url.pathname === "/api/calls") return json(res, 200, calls.list());
    const callAudio = url.pathname.match(/^\/api\/calls\/([\w-]+)\/audio$/);
    if (callAudio) {
      const path = calls.audioPath(callAudio[1]);
      if (!path) return json(res, 404, { error: "no audio" });
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "private, max-age=86400" });
      return res.end(await readFile(path));
    }
    const defaults = url.pathname.match(/^\/api\/projects\/([^/]+)\/defaults$/);
    if (defaults) return json(res, 200, await t3.defaults(decodeURIComponent(defaults[1])));
    if (url.pathname === "/api/threads") return json(res, 200, await t3.listThreads());
    if (url.pathname === "/api/projects") return json(res, 200, await t3.listProjects());
    const history = url.pathname.match(/^\/api\/threads\/([^/]+)\/history$/);
    if (history) return json(res, 200, await t3.history(decodeURIComponent(history[1])));

    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(WEB, path);
    if (!file.startsWith(WEB) || !existsSync(file)) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(file));
  } catch (e) {
    log(`http error: ${(e as Error).message}`);
    json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
http.on("upgrade", (req, socket, head) => {
  const user = caller(req);
  if (!user || !req.url?.startsWith("/call")) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    log(`call from ${user}`);
    new CallSession(ws, new AudioLink(ws, rtc, log), speech, t3, callbacks, calls, log);
  });
});

pruneRecordings(Number(env.YAP_RECORD_DAYS ?? 30), log);
setInterval(() => pruneRecordings(Number(env.YAP_RECORD_DAYS ?? 30), log), 24 * 3600_000).unref();

http.listen(PORT, HOST, () => log(`yapper listening on http://${HOST}:${PORT}`));
