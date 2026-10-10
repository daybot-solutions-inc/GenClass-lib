// Request-scope presets for `requests.protect` (OPTIONS-SPEC §4.4): an opt-in starting point for money and identity
// flows. They name endpoints by URL words only (a path segment or a dash/underscore/dot-separated word in it, or a
// host label). They never read a situation and never choose an action (AGENTS.md rule 1): a request, message
// channel or response they match is only ever narrowed to observe (never held, delayed, retried, replayed, hedged,
// coalesced, answered from cache or discarded; its decisions are recorded with reason "protected"), and so is
// everything its response callbacks cause (runtime.ts -> blockOf). Nothing here is applied unless the app asks:
//
//   GenClass.init({ mode: "guard", requests: { protect: protectPreset("payments", "auth") } });
//   GenClass.init({ requests: { protect: [...PROTECT_PRESETS.payments, "/api/cart/"] } });
//   window.GENCLASS_CONFIG = { requests: { protect: ["preset:payments", "preset:auth"] } };  // JSON-friendly form
//
// A preset over-matches by design (an `/orders` list is protected too): protection only removes interventions.

/** One of `words` as a URL word: after "/", "-", "_" or ".", then the end, a query, a fragment or another separator. */
const word = (words: string): RegExp => new RegExp(`[/_.-](?:${words})(?:[/_.?#-]|$)`, "i");

export const PROTECT_PRESETS = {
  /** Payments, checkout, billing, orders, refunds, subscriptions, transfers, wallets and payment providers. */
  payments: [
    word(
      "pay|payments?|payment[-_]?intents?|checkouts?|billing|invoices?|charges?|refunds?|subscriptions?|orders?|purchases?|transactions?|transfers?|payouts?|wallets?|stripe|paypal|braintree|adyen|klarna|square",
    ),
  ],
  /** Sign-in, sign-up, sign-out, tokens, sessions, OAuth / SSO, multi-factor and password flows. */
  auth: [
    word(
      "auth|oauth2?|login|logout|log[-_]?in|log[-_]?out|sign[-_]?in|sign[-_]?out|sign[-_]?up|register|tokens?|sessions?|sso|saml|oidc|mfa|2fa|otp|passwords?|verify|verification",
    ),
  ],
} as const satisfies Record<string, readonly RegExp[]>;

export type ProtectPresetName = keyof typeof PROTECT_PRESETS;

/** The matchers of one or more presets, for `requests.protect` (fresh RegExp copies; no names: every preset). */
export function protectPreset(...names: ProtectPresetName[]): RegExp[] {
  const list = names.length ? names : (Object.keys(PROTECT_PRESETS) as ProtectPresetName[]);
  const out: RegExp[] = [];
  for (const n of list) for (const re of PROTECT_PRESETS[n] ?? []) out.push(new RegExp(re.source, re.flags));
  return out;
}

/** The string form of a preset in `requests.protect` (JSON configs: meta tag, window.GENCLASS_CONFIG, init's file). */
export const PRESET_PREFIX = "preset:";

/**
 * `requests.protect` with every "preset:<name>" string replaced by that preset's matchers. Unknown names are dropped
 * and reported through `warn` (a protect list never silently narrows to nothing).
 */
export function expandPresets<T>(list: readonly T[] | undefined, warn: (msg: string) => void): (T | RegExp)[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: (T | RegExp)[] = [];
  for (const m of list) {
    if (typeof m === "string" && m.startsWith(PRESET_PREFIX)) {
      const name = m.slice(PRESET_PREFIX.length).trim().toLowerCase();
      if (name in PROTECT_PRESETS) out.push(...protectPreset(name as ProtectPresetName));
      else warn(`requests.protect: unknown preset "${m}" (known: ${Object.keys(PROTECT_PRESETS).map((k) => PRESET_PREFIX + k).join(", ")}); ignored.`);
    } else out.push(m);
  }
  return out;
}
