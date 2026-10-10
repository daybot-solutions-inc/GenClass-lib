// App tokens (InitOptions.token): `gc_` + 22 base62 characters. Public by design: a token only lets a page's
// telemetry batches be grouped under the app's private dashboard link (https://genclass.dev/dashboard/<secret>).

export const TOKEN_PATTERN = /^gc_[A-Za-z0-9]{22}$/;

/** True for a well-formed token. */
export function isValidToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_PATTERN.test(v);
}

/**
 * The configured token, trimmed, or undefined. A value that is set but malformed logs one warning (`warn`) and is
 * ignored. Never throws.
 */
export function resolveToken(v: unknown, warn: (msg: string) => void): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const t = typeof v === "string" ? v.trim() : v;
  if (isValidToken(t)) return t;
  try {
    const shown = typeof v === "string" ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : typeof v;
    warn(`Ignoring token ${shown}: a GenClass token is "gc_" followed by 22 letters or digits. Get one with \`npx @genclass/runtime init\` or at https://genclass.dev/start.`);
  } catch {
    /* ignore */
  }
  return undefined;
}
