#!/usr/bin/env node
// Forwards to the @genclass/runtime CLI so `npx genclass-runtime init` works.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = dirname(require.resolve("@genclass/runtime/package.json"));
await import(pathToFileURL(join(pkg, "bin", "genclass-runtime.mjs")).href);
