// The app token and private dashboard link for `genclass-runtime init` (owner: INSTALL).
//
// A token (`gc_` + 22 base62) identifies one web app. It is public (it ships in the page) and only lets telemetry be
// grouped under that app. The dashboard link (https://genclass.dev/dashboard/<secret>) is private: whoever has it sees
// the app's stats. init creates both with POST https://genclass.dev/api/projects (server: telemetry-worker/), writes the
// token into the snippet it adds, and keeps the link in .genclass.local (git-ignored when a .gitignore exists).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TOKEN_RE = /^gc_[A-Za-z0-9]{22}$/;
const TOKEN_IN_TEXT = /\bgc_[A-Za-z0-9]{22}\b/;
export const PROJECTS_URL = "https://genclass.dev/api/projects";
export const START_URL = "https://genclass.dev/start";
const DASHBOARD_RE = /^https:\/\/genclass\.dev\/dashboard\/[A-Za-z0-9]+$/;
export const LOCAL_FILE = ".genclass.local";
const TIMEOUT_MS = 10_000;

const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};

/** { token?, dashboardUrl? } from <dir>/.genclass.local (KEY=value lines), or null. */
export function readLocal(dir) {
  const t = read(join(dir, LOCAL_FILE));
  if (t === null) return null;
  const kv = {};
  for (const line of t.split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(\S*)\s*$/.exec(line);
    if (m) kv[m[1]] = m[2];
  }
  const r = {};
  if (TOKEN_RE.test(kv.GENCLASS_TOKEN ?? "")) r.token = kv.GENCLASS_TOKEN;
  if (DASHBOARD_RE.test(kv.GENCLASS_DASHBOARD ?? "")) r.dashboardUrl = kv.GENCLASS_DASHBOARD;
  return r.token ? r : null;
}

/** The first token written in these files (a setup init already made), or null. */
export function tokenInFiles(files) {
  for (const f of files) {
    const m = TOKEN_IN_TEXT.exec(read(f) ?? "");
    if (m) return m[0];
  }
  return null;
}

/**
 * Writes .genclass.local and, when <dir>/.gitignore exists and does not list it yet, adds it there. Returns
 * { file, gitignore: "added" | "listed" | "none" }.
 */
export function saveLocal(dir, { token, dashboardUrl, name, created }) {
  const lines = [
    "# GenClass: this app's token and private dashboard link (written by `npx @genclass/runtime init`).",
    "# Keep this file private and out of git: the dashboard link is the only way to open your dashboard.",
    `GENCLASS_TOKEN=${token}`,
    ...(dashboardUrl ? [`GENCLASS_DASHBOARD=${dashboardUrl}`] : []),
    ...(name ? [`GENCLASS_PROJECT=${String(name).replace(/\s+/g, "_")}`] : []),
    ...(created ? [`GENCLASS_CREATED=${created}`] : []),
  ];
  const file = join(dir, LOCAL_FILE);
  writeFileSync(file, `${lines.join("\n")}\n`);
  const gi = join(dir, ".gitignore");
  const g = read(gi);
  if (g === null) return { file, gitignore: "none" };
  if (g.split(/\r?\n/).some((l) => /^\/?\.genclass\.local\s*$/.test(l.trim()))) return { file, gitignore: "listed" };
  const eol = g.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(gi, `${g}${g === "" || g.endsWith("\n") ? "" : eol}${LOCAL_FILE}${eol}`);
  return { file, gitignore: "added" };
}

/**
 * POST /api/projects. Resolves { ok: true, token, dashboardUrl, name, created } or { ok: false, reason } (never
 * rejects). `fetchFn` defaults to the global fetch (tests replace it).
 */
export async function createProject(name, fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== "function") return { ok: false, reason: "this Node.js has no fetch" };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const body = JSON.stringify(name ? { name: String(name).slice(0, 80) } : {});
    const res = await fetchFn(PROJECTS_URL, { method: "POST", headers: { "content-type": "application/json" }, body, ...(ctl ? { signal: ctl.signal } : {}) });
    if (res.status === 429) return { ok: false, reason: "too many new projects from this network right now (HTTP 429)" };
    if (!res.ok) return { ok: false, reason: `the server answered HTTP ${res.status}` };
    let j;
    try {
      j = await res.json();
    } catch {
      return { ok: false, reason: "the server's answer was not JSON" };
    }
    if (!j || !TOKEN_RE.test(String(j.token ?? "")) || !DASHBOARD_RE.test(String(j.dashboardUrl ?? ""))) return { ok: false, reason: "the server's answer had no valid token and dashboard link" };
    return { ok: true, token: j.token, dashboardUrl: j.dashboardUrl, name: typeof j.name === "string" ? j.name : name, created: typeof j.created === "string" ? j.created : undefined };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { ok: false, reason: aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : `network error (${e?.cause?.code ?? e?.message ?? e})` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
