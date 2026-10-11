# Security policy

GenClass (`@genclass/runtime` and the model package `@genclass/runtime-model`) runs inside your web app: it wraps the
page's network and timer APIs, reads application state and, when you opt in, changes how requests, responses and
state writes proceed. We take reports about it seriously.

## Reporting a vulnerability

Please report security issues privately, not in public GitHub issues, discussions or pull requests.

- **Email:** [mehar@daybot.ca](mailto:mehar@daybot.ca)
- **GitHub:** a private vulnerability report (Security → Report a vulnerability) on the GenClass-lib repository, if
  private reporting is enabled there.

Include what you can of: the affected package and version (`GenClass.runtime.status`, or the version in
`package.json`), how GenClass was installed (`@genclass/runtime/auto`, `GenClass.init`, the script tag), the mode
(`observe`, `guard`, `heal`), a minimal page or steps that reproduce it, and the impact you see. Please do not test
against sites you do not own, do not access other people's data, and give us a reasonable time to fix the issue before
you disclose it.

What to expect:

| | target |
|---|---|
| acknowledgement | within 3 business days |
| first assessment (severity, affected versions) | within 10 business days |
| fix or mitigation for high and critical issues | as soon as possible, normally within 30 days |
| disclosure | coordinated with you; we credit reporters who want to be credited |

There is no bug bounty programme at this time.

## Supported versions

GenClass is pre-1.0. Security fixes go into the newest published version only; upgrade to receive them.

| package | supported |
|---|---|
| `@genclass/runtime`, the newest published `0.2.x` release (npm dist-tag `latest`) | yes |
| `@genclass/runtime`, all `0.1.0` betas and alphas | no |
| `@genclass/runtime-model`, the version the supported runtime loads by default (`DEFAULT_MODEL_BASE_URL`) | yes |
| `research/` and the other directories of this repository that are not published packages | no |

## In scope

- the runtime library (`packages/runtime/src`), its zero-code entries (`/auto`, the script-tag build), the `init` /
  `remove` CLI (`packages/runtime/bin`), the devtools overlay;
- the model loader and host (integrity checks, Cache Storage, the worker);
- the telemetry client and the collector (`telemetry-worker/`), including anything that sends more than
  [TELEMETRY.md](packages/runtime/TELEMETRY.md) says;
- a way to make GenClass act where its documentation says it never does (see
  [INTERCEPTION.md](packages/runtime/INTERCEPTION.md), "What it never does"): for example changing a request's body,
  retrying a non-idempotent request without an idempotency key, acting on a `requests.protect` endpoint, acting in
  `observe` mode, or writing discovered React or Zustand state.

Out of scope: the model choosing a wrong action within what the documentation allows (that is a quality issue: please
open a normal issue with the situation from `rt.explain(id)`), attacks that need script execution in the page (any
page script already has the same access GenClass has; see the threat model), and denial of service against
infrastructure we do not operate.

## Security design

- [docs/runtime/THREAT-MODEL.md](docs/runtime/THREAT-MODEL.md): who could attack an app through GenClass, how, the
  mitigations in the code and the risks that remain.
- [packages/runtime/INTERCEPTION.md](packages/runtime/INTERCEPTION.md): every API GenClass wraps or listens to, what
  each mode may change, the preconditions and undo of every action, and how `disable()` and `?genclass=off` restore
  the page. A unit test keeps it in sync with the code.
- [packages/runtime/TELEMETRY.md](packages/runtime/TELEMETRY.md) and [PRIVACY.md](PRIVACY.md): what leaves the page.
- [RELEASE.md](RELEASE.md#verifying-a-published-tarball): how to check that a published tarball was built from this
  repository.

Recommended for production: keep the default `observe` mode until you have looked at what GenClass reports for your
app; set `mode` explicitly (a URL parameter can then only lower it); keep payment, checkout and sign-in endpoints
observe-only with `requests: { protect: protectPreset("payments", "auth") }`; self-host the model and onnxruntime-web
behind a Content-Security-Policy (README, "Content-Security-Policy and self-hosting"); review `rt.audit()`.
