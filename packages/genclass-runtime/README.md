# genclass-runtime

Short alias for the [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) CLI.

```bash
npx genclass-runtime init
```

It does the same as `npx @genclass/runtime init`: it finds your framework, installs `@genclass/runtime`, adds one
line to your entry file and shows you the diff first. Docs: [@genclass/runtime](https://www.npmjs.com/package/@genclass/runtime).

Privacy: since `0.1.0-beta.3` the installed runtime sends anonymous diagnostics (GenClass's decisions, including
redacted situation text) to the GenClass maintainers by default. Opt out with `GenClass.init({ telemetry: false })`
or `?genclass=no-telemetry`; details in [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).
