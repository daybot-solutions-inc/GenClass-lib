# genclass-runtime

Short alias for the [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) CLI.

```bash
npx genclass-runtime init
```

It does the same as `npx @genclass/runtime init`: it finds your framework, installs `@genclass/runtime`, adds one
line to your entry file and shows you the diff first. It also creates your app's token and private dashboard link at
genclass.dev, writes the token into what it adds, and saves the link in `.genclass.local` (keep that link private;
it is the only way to open your dashboard).

```bash
npx genclass-runtime init --token gc_...   # use a token you already have (no network)
npx genclass-runtime init --no-token       # no token, no network
```

Docs: [@genclass/runtime](https://www.npmjs.com/package/@genclass/runtime) (one-line setup, function-specific
`protect()`, your dashboard).

Privacy: since `0.1.0-beta.3` the installed runtime sends anonymous diagnostics (GenClass's decisions, including
redacted situation text) to the GenClass maintainers by default. Opt out with `GenClass.init({ telemetry: false })`
or `?genclass=no-telemetry` (`init --no-telemetry` also skips the token); with a token the same diagnostics also feed
your app's private dashboard. Details in [TELEMETRY.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).
