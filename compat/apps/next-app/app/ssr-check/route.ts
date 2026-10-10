// SSR safety probe (compat runner): what importing GenClass's one line does on the server. Expected: an inert
// runtime, the server's fetch untouched, no devtools globals added to the Node process.
export const dynamic = "force-dynamic";

export async function GET() {
  const g = globalThis as Record<string, unknown>;
  const fetchBefore = g.fetch;
  const hooksBefore = ["__REACT_DEVTOOLS_GLOBAL_HOOK__", "__REDUX_DEVTOOLS_EXTENSION__", "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__"].filter((k) => k in g);
  let out: Record<string, unknown>;
  try {
    const mod = await import("@genclass/runtime/auto");
    const rt = mod.default;
    out = {
      fetchSame: g.fetch === fetchBefore,
      state: rt.status.state,
      mode: rt.mode,
      stores: rt.stores().length,
      globalsAdded: ["__REACT_DEVTOOLS_GLOBAL_HOOK__", "__REDUX_DEVTOOLS_EXTENSION__", "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__"].filter((k) => k in g && !hooksBefore.includes(k)),
      error: null,
    };
  } catch (e) {
    out = { error: String((e as Error)?.stack ?? e) };
  }
  return Response.json(out);
}
