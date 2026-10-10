# Design note: TanStack Query / SWR adapters (not built)

Status: proposal, 2026-10-10 (COMPAT workstream). Nothing here is implemented. Evidence: `compat/RESULTS.md`
(run of 2026-10-10), NIGHT-REPORT.md §6 item 4.

## Question

Query-cache libraries keep server data outside the state GenClass discovers. Should `@genclass/runtime` ship
adapters that expose the TanStack Query cache and the SWR cache as stores, so delivery decisions ("this response
would overwrite newer data") also work for apps built on them?

## What the compatibility matrix shows

- **Keyed caches already prevent the stale typeahead.** In scenario a (out-of-order search responses), the TanStack
  Query, SWR and Apollo layers (and Solid's `createResource`) never showed stale results without GenClass, on any
  seed: a response is stored under its own key and the screen reads the current key. The naive `useState`, Zustand,
  Redux-thunk, Pinia, Svelte-store, Angular and plain-JS versions did show it. The main thing a cache adapter would
  enable, a delivery `discard` of a stale write, has little to prevent in idiomatic use of these libraries.
- **What still goes wrong is network-level.** Double submits (scenario b) reach the server twice with every data
  layer. GenClass already sees them without any adapter (the `duplicate` detection fired in every layer); preventing
  them is a request-time decision (`coalesce` / `block`), not a state decision.
- **Partial visibility exists today.** With the one line, React discovery already records what each component
  reads from these caches, because `useQuery` (TanStack and Apollo) and `useSWR` return a `useSyncExternalStore`
  snapshot. A probe of the compat apps (`COMPAT_SHAPES=1`, 2026-10-10) found, per component, fields such as
  `external0: {status, fetchStatus, isPending, isSuccess, …, data, dataUpdatedAt, error, …}` (TanStack),
  `external0: {isValidating, isLoading, error, data}` (SWR) and `external0: {data, dataState, loading, networkStatus,
  partial}` (Apollo), next to the component's own `useState` fields: 7 to 69 fields per page. These are observed-only
  stores (no write actions), and their writes are attributed to whatever op was ambient when React committed. RTK
  Query is fully covered because its cache is a Redux store (discovered and controllable). The matrix's "Automatic
  state discovery" table lists what was found per layer.

## If built: shape that needs no situation-format change

The situation text renders any store's writes the same way (store name, field path, value, writer op), so an adapter
that registers an ordinary store changes no wording. Two variants:

1. **SWR, controllable, no monkey-patching.** SWR takes a user-supplied cache `provider`. An adapter
   `genclassSWRCache(rt, name, map = new Map())` returns a Map-like provider whose `set(key, state)` is the write
   point: each `state.data` change becomes a write of `name.<key path>` with the ambient op as writer. Because every
   write goes through the adapter, GenClass can also hold or drop it like an atom (`discard`, late revert), using the
   existing `StoreHub` pipeline. Usage: `<SWRConfig value={{ provider: () => genclassSWRCache(rt, "swr") }}>`.
2. **TanStack Query, observed only.** `genclassQueryClient(rt, queryClient, name)` subscribes to
   `queryClient.getQueryCache().subscribe(e => ...)` and records `updated` events whose action is `success` (or a
   `setQueryData`) as writes to an observed store (kind `observed`, like discovered React state): facts, triage,
   detections and `deliver` / `defer`, but no write actions. Making it controllable would mean intercepting
   `Query.setData` / the reducer, which is internal API and changes between minor versions; not worth the risk.

Both are opt-in imports (`@genclass/runtime/swr`, `@genclass/runtime/tanstack-query`), optional peer dependencies,
like the Redux and Zustand adapters. Apollo's `InMemoryCache` could follow variant 2 through `cache.watch`.

## Open problems (why it is not built now)

- **Query keys in the situation text.** A field path built from a query key carries what the user typed
  (`search.san francisco`), and situation text is sent with telemetry. Keys would have to be normalised to a shape
  (`search.:q`) or hashed. Choosing that is a privacy and telemetry decision for the owner (AGENTS.md rule 9).
- **Distribution shift.** No SIM or REAL row has key-shaped cache paths; the model has not seen this kind of store.
  Before enabling it by default, generate REAL rows from the TanStack and SWR apps already in `realapps/` (not from
  `compat/`, which stays evaluation-only) and check false interventions on them.
- **Low expected value now** (see the matrix): idiomatic cache usage already avoids the stale-write class, and the
  remaining failures are visible without an adapter.

Recommendation: keep it on the list behind REAL evidence; if one is built first, build the SWR provider (variant 1),
because it needs no internal API and can be controllable.
