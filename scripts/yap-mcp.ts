// MCP server (stdio) that gives T3's agents a "call me back" tool. Register it user-wide in Claude Code, on the
// same host as the Yapper server:
//
//   claude mcp add --scope user yap -- node /path/to/yapper/scripts/yap-mcp.ts
//
// The tool asks the local Yapper server (POST /api/agent/callback, loopback + YAP_AGENT_TOKEN) to ring the user's
// phones when the calling agent's run ends. Yapper finds the T3 thread from the Claude session id
// (CLAUDE_CODE_SESSION_ID, inherited from Claude Code or read from the parent process). No dependencies:
// MCP over stdio is newline-delimited JSON-RPC.
//
// Config: YAP_AGENT_TOKEN, YAP_PORT and YAP_CALL_HOURS from the environment (e.g. `claude mcp add -e ...`), else
// from YAP_ENV_FILE (default: the repo's .env, the same file the server reads).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const ENV_FILE = process.env.YAP_ENV_FILE ?? fileURLToPath(new URL("../.env", import.meta.url));

function fileEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return env;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function config(): { port: string; token: string } {
  const file = fileEnv();
  const token = process.env.YAP_AGENT_TOKEN || file.YAP_AGENT_TOKEN;
  if (!token) throw new Error(`YAP_AGENT_TOKEN not set (environment or ${ENV_FILE})`);
  return { port: process.env.YAP_PORT || file.YAP_PORT || "8790", token };
}

/** Same window the server uses for agent-initiated calls (YAP_CALL_HOURS, default 7-22). */
function callHours(): string {
  const raw = process.env.YAP_CALL_HOURS || fileEnv().YAP_CALL_HOURS || "7-22";
  const m = raw.match(/^(\d{1,2})-(\d{1,2})$/);
  const [from, to] = m ? [m[1], m[2]] : ["7", "22"];
  return `${from.padStart(2, "0")}:00-${to.padStart(2, "0")}:00`;
}

/** Claude Code passes its session id to child processes; fall back to the parent's environment. */
function sessionId(): string | null {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const parent = readFileSync(`/proc/${process.ppid}/environ`, "utf8").split("\0");
    return parent.find((v) => v.startsWith("CLAUDE_CODE_SESSION_ID="))?.split("=")[1] ?? null;
  } catch {
    return null;
  }
}

const TOOLS = [
  {
    name: "call_me_back",
    description:
      "Phone the user through Yapper: their phone(s) ring when your current turn ends, and when they pick up your " +
      "final message is read aloud to them. So after calling this, finish your turn with a short, spoken-style message " +
      "(what happened, or the one question you need answered). kind:\n" +
      "- requested: the user asked to be called back (\"call me when you're done\"). Rings any time.\n" +
      "- assistance: you are blocked on long or unattended work and need their decision or help.\n" +
      "- info: you have something they should hear soon (an outage, a finished long job they're waiting for, a risk).\n" +
      `assistance and info only ring within call hours (${callHours()} local); outside them the call waits until the ` +
      "window opens and is dropped if the user has replied in the thread by then. Don't use it for routine replies " +
      "while they are chatting with you at the screen.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["requested", "assistance", "info"], description: "Why you are calling (default: requested)." },
      },
      additionalProperties: false,
    },
  },
];

async function callMeBack(kind: string): Promise<string> {
  const sid = sessionId();
  if (!sid) throw new Error("no Claude session id: can't tell which T3 thread this is");
  const { port, token } = config();
  const res = await fetch(`http://127.0.0.1:${port}/api/agent/callback`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: sid, kind }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; title?: string; heldUntil?: number | null };
  if (!res.ok) throw new Error(body.error ?? `yapper answered HTTP ${res.status}`);
  const when = body.heldUntil
    ? `It's outside call hours, so the phone rings at ${new Date(body.heldUntil).toLocaleString()} unless the user replies here first.`
    : "The user's phone rings when this turn ends.";
  return `Callback (${kind}) set for "${body.title ?? "this thread"}". ${when} Your final message is read to them when they answer.`;
}

const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let req: { id?: number | string; method?: string; params?: any };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result: object) => req.id !== undefined && send({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "yap", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (req.params?.name !== "call_me_back")
        return reply({ isError: true, content: [{ type: "text", text: `unknown tool ${req.params?.name}` }] });
      try {
        const kind = ["assistance", "info"].includes(req.params?.arguments?.kind) ? req.params.arguments.kind : "requested";
        return reply({ content: [{ type: "text", text: await callMeBack(kind) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: "text", text: `yap: ${(e as Error).message}` }] });
      }
    }
    default:
      if (req.id !== undefined) send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
  }
});
