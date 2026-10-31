// Checks that the running T3 server still speaks what Yapper expects. Read-only.
// Run after a T3 update: `npm run smoke`. Exit code 0 = fine. Reads T3_URL/T3_TOKEN from the environment,
// else from YAP_ENV_FILE (default ./.env).
import { existsSync, readFileSync } from "node:fs";
import { T3Client } from "../server/t3client.ts";
import { T3Adapter } from "../server/t3adapter.ts";

const envFile = process.env.YAP_ENV_FILE ?? new URL("../.env", import.meta.url).pathname;
const env: Record<string, string | undefined> = {
  ...(existsSync(envFile)
    ? Object.fromEntries(
        readFileSync(envFile, "utf8")
          .split("\n")
          .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => [m[1], m[2]]),
      )
    : {}),
  ...Object.fromEntries(["T3_URL", "T3_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
};
if (!env.T3_TOKEN) {
  console.error("FAIL config: T3_TOKEN not set (environment or .env)");
  process.exit(1);
}

const fail = (step: string, e: unknown) => {
  console.error(`FAIL ${step}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
};

const client = new T3Client(env.T3_URL ?? "http://127.0.0.1:3773", env.T3_TOKEN);
const t3 = new T3Adapter(client);

const info = await client.checkCompatibility().catch((e) => fail("compatibility", e));
console.log(`ok   T3 ${info!.serverVersion} protocol + capabilities`);

const threads = await t3.listThreads().catch((e) => fail("list threads", e));
console.log(`ok   ${threads!.length} threads listed`);
const sample = threads!.find((t) => !t.running) ?? threads![0];
if (!sample) fail("pick thread", "no threads");

const history = await t3.history(sample.id, 5).catch((e) => fail("thread history", e));
console.log(`ok   history of "${sample.title}" (${history!.length} messages)`);

const ready = await new Promise<boolean>(async (resolve) => {
  const timer = setTimeout(() => resolve(false), 10_000);
  const w = await t3
    .watch(sample.id, (ev) => {
      if (ev.type === "ready") {
        clearTimeout(timer);
        w.stop();
        resolve(true);
      }
    })
    .catch((e) => fail("subscribe", e));
});
if (!ready) fail("subscribe", "no snapshot within 10 s");
console.log("ok   live thread subscription");
client.close();
process.exit(0);
