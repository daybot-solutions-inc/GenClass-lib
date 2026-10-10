// Preloaded into the CLI by test/install/cli.test.ts (`node --import`): replaces fetch so no test reaches the network
// (in particular never https://genclass.dev/api/projects). GENCLASS_TEST_FETCH picks the answer: "fail" (default:
// a network error), "ok" (201 with a project), "429", "500", "bad" (201 without a valid token). Every call is
// appended to the file GENCLASS_TEST_FETCH_LOG as one JSON line.

import { appendFileSync } from "node:fs";

const mode = process.env.GENCLASS_TEST_FETCH || "fail";
const log = process.env.GENCLASS_TEST_FETCH_LOG;

globalThis.fetch = async (url, init = {}) => {
  if (log) appendFileSync(log, `${JSON.stringify({ url: String(url), method: init.method ?? "GET", body: init.body ?? null })}\n`);
  if (mode === "fail") throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (mode === "429") return json(429, { error: "rate limited" });
  if (mode === "500") return json(500, { error: "boom" });
  if (mode === "bad") return json(201, { token: "nope" });
  const name = (() => {
    try {
      return JSON.parse(init.body).name ?? "";
    } catch {
      return "";
    }
  })();
  return json(201, { token: "gc_TestToken0123456789abc", dashboardUrl: "https://genclass.dev/dashboard/TestSecret0123456789abcdefghijkl", name, created: "2026-10-10T00:00:00.000Z" });
};
