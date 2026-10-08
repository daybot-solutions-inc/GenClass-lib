# @genclass/runtime: state stores, mutation pipeline, invariants and framework adapters

> **Scope:** `packages/runtime/src/state/hub.ts`, `packages/runtime/src/state/fields.ts`, `packages/runtime/src/state/invariants.ts`, `packages/runtime/src/adapters/{react,redux,zustand}.ts`, and the store-related parts of `packages/runtime/src/runtime.ts` (`atom`, `guard`, `adapter`, `expect`, `gateMutation`, `waitRelated`, `onApplied`, settled points, rollback, chain revert, resync, pause/resume/destroy gating).
> **Read this when:** you change how state is registered, flattened, diffed, held, applied, patched, reverted or snapshotted; add or tune an invariant template; touch the React hooks, the Redux enhancer or the Zustand middleware; integrate another state library through `runtime.adapter`; debug "why was this write held / applied / dropped / not reverted"; or debug a missing or spurious `inconsistency` trigger.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- Every store lives in one `StoreHub` (`packages/runtime/src/state/hub.ts` -> `StoreHub`), keyed by a **store name** that is global per runtime. There are three kinds: `atom` (GenClass owns the value), `guard` (the app owns the value behind `get`/`set`/`subscribe`), and `adapter` (a state library owns it and the adapter commits writes). The React hooks use atoms. The Redux enhancer and the Zustand middleware use `runtime.adapter`.
- A store value is **flattened** into dotted fields: `store.key.sub`, at most 4 key levels below the store name. A plain object is expanded only when it has 1 to 32 keys and expanding it keeps the store within 200 fields (a per-object check, so the cap is soft: see "Paths and leaves"). Arrays, plain objects with more than 32 keys, and non-plain objects are one field each. Each field has a version, its last writer op, a 16-entry history that keeps values, and a 512-entry write log.
- Every `set`/`dispatch` becomes a **proposal** (`MutationRec`), except Redux no-op dispatches, Zustand `set` calls made while the store is being created, and any write after `destroy()`. It is previewed, diffed against the stored leaves, and then either **bypasses** the pipeline (applied at once, in the caller's stack) or joins the store's FIFO queue and goes through the `mutation` **trigger**.
- These writes bypass: **user-sync** writes (made in the user handler's task; `policy.holdUserWrites` defaults to false), writes made by GenClass's own ops, stores registered with `hold: false`, any write while the runtime is paused or destroyed, no-op writes, and in-place updaters that cannot be detached.
- A queued write is **held** only when the trigger is salient, the model is ready, the mode is not `observe`, and some non-passive action is permitted. Otherwise the gate answers "apply" synchronously. Queued writes to one store apply in proposal order, so a write the gate cleared can still wait behind an earlier held write (bypass writes skip the queue; see Gotchas). Verdicts are `apply`, `discard` or `defer`. When the hold budget expires the write applies anyway (**fail-open**).
- At apply time a functional update **re-runs** against the current value. A value write is re-applied as a **patch** of the fields it changed (removals first). This keeps newer user input in other fields.
- **Late revert:** a `discard` that arrives after a fail-open apply reverts exactly that write. All of these must hold: at most 2,000 ms have passed since it applied, none of its fields changed since, and the same causal chain wrote nothing after it.
- Every applied change emits a `state` event and calls `HubHooks.applied` (`RuntimeImpl.onApplied`). That updates `storeWriters` and the transition-profile accumulators, notes the changed paths for the invariant miner, and (re)schedules a **settled point**, which is debounced by `settleMs` (60 ms).
- At a settled point (no op younger than 10 s in flight and no pending write), `InvariantMiner.observe` runs the 9 templates. A newly violated learned invariant raises one `inconsistency` trigger per episode. A consistent **snapshot** (up to 8 kept) is recorded whenever nothing newly broke.
- **App errors:** if the app's setter, reducer or subscriber throws on the synchronous path, the error reaches the `set()` caller just as it would without GenClass (subscriber errors are the exception: they are always reported, never thrown). If it throws later, when GenClass applies a held write, the error is reported through `reportError`, which raises an `error` trigger, and the store's queue keeps draining.
- **Parity:** flattening, hashes, deltas and `changeText` feed the situation text, so changing them changes training data (freeze tag `situation-v1`). This scope has not changed since that tag.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/state/hub.ts` | Store registry, mutation pipeline (propose, gate, queue, drain, commit, record), field versions and write logs, recent changes, late-revert primitives, snapshots, query helpers | `StoreHub`, `StoreRec`, `MutationRec`, `FieldState`, `FieldHist`, `LogEntry`, `RecentChange`, `HubHooks`, `GateResult`, `Verdict`, `toChanges`, re-export `changeText` |
| `packages/runtime/src/state/fields.ts` | Incremental flattening into leaves, hashing, diff, delta signatures, one-line change summaries, patches, deep clone | `flatten`, `leafOf`, `diffLeaves`, `deltaOf`, `multisetDiff`, `addedElements`, `elementDiff`, `changeText`, `patchValue`, `cloneValue`, `normalizeLeafKind`, `Leaf`, `FieldChange`, `MAX_DEPTH`, `MAX_FIELDS_PER_STORE`, `MAX_KEYS_EXPAND` |
| `packages/runtime/src/state/invariants.ts` | Online invariant miner over the leaves of all stores; developer `expect()` predicates | `InvariantMiner` (`noteChanged`, `noteValues`, `addExpect`, `observe`, `preview`, `current`, `learned`, `candidates`), `numEq`, `LEARN_AFTER`, `LEARN_AFTER_NONNULL` |
| `packages/runtime/src/runtime.ts` (store parts) | Public store API, the gate hook, defer waiting, applied-write bookkeeping, settled points, snapshots, inconsistency trigger, rollback, chain revert, resync | `RuntimeImpl.atom`, `.guard`, `.adapter`, `.handle` (private), `.expect`, `.gateMutation` (private), `.waitRelated` (private), `.onApplied` (private), `.scheduleSettle` (private), `.busy` (private), `.settled`, `.raiseInconsistency` (private), `.chainWrites`, `.revertChain`, `.rollback`, `.resync`, `.makeEnv` (private), `.pause`/`.resume`/`.destroy`, `.runAsGenClass`, `.reportError` (target of `HubHooks.appError`), `.pluginApi` (private; builds `PluginApi.stores { names(), get(name) }`, read-only access to every store's current value), the private fields `snaps`, `episode`, `muted`, `storeWriters`, `settleTimer`; constants `LATE_REVERT_MS`, `LONG_RUNNING_MS` |
| `packages/runtime/src/adapters/react.ts` | React bindings (subpath `@genclass/runtime/react`) | `GenClassProvider`, `GenClassProviderProps`, `useGenClass`, `useGenClassState`, `useAtom`, `getGenClassAtom`, `useGenClassDecisions`, `useGenClassInterventions`, `useGenClassStatus` |
| `packages/runtime/src/adapters/redux.ts` | Redux store enhancer (subpath `@genclass/runtime/redux`) | `genclassEnhancer`, `GENCLASS_REPLACE`, `GenclassEnhancerOptions` |
| `packages/runtime/src/adapters/zustand.ts` | Zustand middleware (subpath `@genclass/runtime/zustand`) | `genclass` |
| `packages/runtime/src/types.ts` | Public store types | `StoreOptions`, `Atom`, `Guarded`, `StoreIO`, `AdapterIO`, `AdapterHandle`, `Change`, `RuntimeHooks.mutationProposed`, `PolicyOptions.holdUserWrites`, `InitOptions.settleMs` (inherited by `CreateOptions`) |
| `packages/runtime/src/util.ts` | Helpers used here | `isPlainObject`, `kindOf`, `hashValue` (FNV-1a over `stableStringify`, capped at 65,536 chars), `fnv1a`, `isIdSegment`, `normalizeFieldPath`, `describe` |
| `packages/runtime/src/trace/context.ts` | The ambient op; user-sync detection | `Context.isUserSync`, `Context.run`, `Context.stickUser` |
| `packages/runtime/src/situation/facts.ts`, `packages/runtime/src/situation/build.ts` | Consumers: mutation and inconsistency facts, state lines, action applicability | `mutationFacts`, `inconsistencyFacts`, `stateLines`, `builtinApplicable` (all module-private) |
| `packages/runtime/src/situation/env.ts` | The read-only view the situation builder gets of the store layer, built by `RuntimeImpl.makeEnv` | `Violation`, `SitEnv` (store-related members: `hub`, `lastConsistent()`, `consistentBefore(seq)`, `storeWriters`, `violations()`, `previewInvariants?(m)`, `resyncable(store)`, `chainWrites(op)`, `writable(store)`; the optional `writtenByChain?` is not set by `makeEnv`), `ChainWriteInfo { path, count, lastIsChain, before?: { value, removed } }` |
| `packages/runtime/package.json`, `packages/runtime/tsup.config.ts` | Subpath exports `./react`, `./redux`, `./zustand`; `react`/`redux`/`zustand` are optional peer dependencies (`>=18`, `>=4`, `>=4`) and tsup externals | - |

The state modules are **not** exported from the package index. Tests reach them through `RuntimeImpl.hub` / `.miner` (public readonly fields) or `RuntimeImpl.internals` (`RuntimeInternals { hub, ops, events, base, profiles, miner, ctx, clock }`), which is not part of the public `Runtime` type.

## Concepts and data structures

### Store kinds (`StoreRec.kind`)

| kind | created by | value lives in | `hub.read(s)` | how a write commits | external changes | `writable` (GenClass may write directly: rollback, revert) |
|---|---|---|---|---|---|---|
| `atom` | `rt.atom(name, initial, opts)`; React `useGenClassState` | `StoreRec.value` | `s.value` | `record()` sets `s.value` | impossible | always |
| `guard` | `rt.guard(name, io, opts)` | the app's store | `io.get()` | `io.set(next)` | `io.subscribe` callback -> `StoreHub.external` (recorded, never held) | always |
| `adapter` | `rt.adapter(name, io, opts)`; Redux enhancer; Zustand middleware | the library's store | `io.get()` | the proposal's `commit(next)`; GenClass's own writes go through `io.set` | same as guard | only when `AdapterIO.set` exists |

Public types (`packages/runtime/src/types.ts`):

```ts
interface StoreOptions<T> { resync?: () => Promise<unknown> | unknown; hold?: boolean /* default true */; describe?: (v: T) => string }
interface Atom<T> { readonly name: string; get(): T; set(next: T | ((prev: T) => T)): void; update(fn: (prev: T) => T): void; subscribe(fn: (v: T) => void): () => void }
type Guarded<T> = Atom<T>;
interface StoreIO<T> { get(): T; set(v: T): void; subscribe?(fn: () => void): () => void }
interface AdapterIO<T> { get(): T; set?(v: T): void; subscribe?(fn: () => void): () => void }
interface AdapterHandle<T> { readonly name: string; propose(w: { fn?: (prev: T) => T; value?: T; commit: (next: T) => void }): void; dispose(): void }
```

- `resync` lets the `resync` action reload this store. `describe` replaces the store's value in state lines with one line (`packages/runtime/src/situation/build.ts` -> `stateLines`). `hold: false` means writes are traced but never held.

### Paths and leaves (`packages/runtime/src/state/fields.ts`)

- **Path syntax:** `<store>` or `<store>.<k1>[.<k2>[.<k3>[.<k4>]]]`. Keys are joined with `.`. Arrays have no element paths: `cart.items` is one field, and the miner's text uses `cart.items[*].price` notation only inside invariant descriptions.
- `flatten(store, value, prev?)` walks plain objects (`isPlainObject`: prototype is `Object.prototype` or `null`). It expands an object only when it has between 1 and `MAX_KEYS_EXPAND` (32) keys, the depth is below `MAX_DEPTH` (4), and `out.size + keys.length <= MAX_FIELDS_PER_STORE` (200). Otherwise the object becomes one **collection** leaf (kind `object`). Empty objects are collection leaves too.
- The 200-field cap is checked once per object, before expanding it, against the leaves emitted so far. Siblings walked later still add one leaf each, so a store can end slightly above 200 fields. Example: 32 top-level keys that each hold a 32-key object give 6 expanded objects (192 leaves) plus 26 collection leaves = 218 fields. Expansion is depth-first in `Object.keys` order, so which keys get expanded depends on key order.
- `Leaf { value; hash; kind; len; elems?; keys?; khash?; src? }`:
  - `kind` comes from `kindOf`: `string`, `number`, `boolean`, `null`, `undefined`, `array`, `object`, `map`, `set`, `date`, `function`, `bigint`, `symbol`.
  - `value`: primitives keep the value itself. Arrays keep a **shallow copy** (`arr.slice()`). Collections keep a shallow copy (`{...obj}`). Other objects (class instances, Map, Set, Date) keep the live reference.
  - `len`: array length or collection size; -1 for everything else.
  - `elems`: per-element hashes (arrays). `keys` / `khash`: key order and per-key hashes (collections). `src`: the live collection object, used for a cheap "same object" check.
- Hashes (`primHash`, `valueHash`):
  - Strings up to 64 chars hash as `s:<string>`; longer strings as `S:<fnv1a>:<len>`.
  - Other primitives: `n:<num>`, `b:1`/`b:0`, `u`, `i:<bigint>`, `y:<symbol>`, `f` (any function), `null`.
  - Objects: `o:<hashValue>`, where `hashValue` uses sorted keys, so element key order does not matter.
  - `hashValue` = `fnv1a(stableStringify(v))` (`packages/runtime/src/util.ts`). `stableStringify` walks only own enumerable keys (class `#private` fields and getters are invisible), writes functions as `"[fn]"` and cycles as `"[cycle]"`, and stops walking once the output exceeds `STRINGIFY_CAP` = 65,536 chars: it returns the first 65,536 chars plus `…<len>`, where `<len>` is the length emitted when it stopped (not the full serialized length). So a change that lies entirely beyond the cut in one element or one non-plain object is not detected.
  - Non-plain objects (class instances, `Map`, `Set`, `Date`) are one leaf each, re-hashed in full by `leafOf` on every flatten of their store. There is no reference fast path for them, so a large `Map` in a store costs O(size) per write.
  - Array leaf hash: `fnv1a("a<n>|<elems joined by ,>")`. Collection leaf hash: `fnv1a("c<n>|k=h,...")` in key order, so reordering the keys of a collection changes its hash.
- **Incremental flattening:** pass the previous leaves (`s.leaves`).
  - `arrayLeaf` returns the previous `Leaf` object unchanged when the length is the same, every element is the same reference, and a sampled re-hash finds no in-place change. Otherwise it reuses element hashes by position or by reference and hashes only new elements.
  - The sampled re-hash covers `SAMPLES` = 8 positions: 0, n-1 and `floor(j*n/8)`. Elements that kept their reference are re-hashed at those positions. If any differs, every object element is re-hashed.
  - `objectLeaf` does the same for collections, keyed by key. It has one extra **fastest path**: when the object is the very same reference as last time (`obj === prev.src`, i.e. mutated in place), has the same key count and the same last key, only the 8 sampled positions are checked (same key, same value reference, and an unchanged re-hash for object values) before the previous `Leaf` is returned. A value replaced or a key swapped in place at a non-sampled position of such a collection is therefore **not** detected (see Gotchas).
  - Returning the same `Leaf` object matters: the miner caches per-array statistics in a `WeakMap<Leaf, ArrayStats>`.

### Changes and deltas

- `FieldChange { path; before; after; beforeLeaf; afterLeaf; delta }` comes from `diffLeaves(before, after)`. A path is changed when its hash differs, when it is new, or when it was removed (`afterLeaf` undefined, `delta` `x:removed`). Output order: changed and added paths in the `after` map's order, then removed paths.
- `deltaOf` signatures. They are equal for "the same change applied again" and are used in repetition facts:

| case | delta |
|---|---|
| removed | `x:removed` |
| number -> number | `n:<after-before>` (`toPrecision(12)`) |
| array -> array | `a:+<added hashes sorted>\|-<removed hashes sorted>` (multiset diff), or `o:<hash>` for a pure reorder |
| collection -> collection | `c:<sorted +k=h, ~k=h, -k>` |
| anything else | `v:<after hash>` |

- `changeText(c, redact)` produces the one-line summaries used in `state` events and facts. Examples: `3 → 4 items: added {id: 9, …}`, `3 items, 1 changed: {id: 3, qty: 1 → 2}`, `2 → 3 entries: added m21: …`, `"r" → "re"`, `3 items, reordered`. `elementDiff` shows an element's id key (from `id`, `_id`, `key`, `uuid`, `slug`, `name`, `title`, `label`) and at most 3 changed keys.
- `changeText` rules (`fields.ts` -> `changeText`), which are parity-relevant:
  - Array, same length: no differing position gives `N items, unchanged`. If the multiset is unchanged, the result is `N items, reordered`. When K differing positions number at most `max(1, N/2)`, the result is `N items, K changed: <elementDiff of the first>`, plus `, and K-1 more` when K > 1. Otherwise the full `before → after` text is used when it fits in 90 chars, else `N items, K changed`.
  - Array, length changed: the full text if it fits in 70 chars, else `B → A items: added <first> and K more; removed N items`.
  - Collection: `B → A entries: added k: …; changed k: {…}; removed k1, k2 and K more`.
  - Anything else: `<before> → <after>`, each part described in at most 36 chars.

### Field state, write logs, recent changes (`hub.ts`)

| type | fields | bound |
|---|---|---|
| `FieldState` | `path, v` (version, starts at 0), `writer` (op id or null), `t, seq` (global seq of last write), `hist: FieldHist[], log: LogEntry[]` | one per path ever seen (fields are created at registration for the initial leaves and on first write) |
| `FieldHist` | `v, seq, writer, root` (root op of the writer's chain), `user` (user-sync), `t, delta, before, after, beforeLeaf?, afterLeaf?, mutation` (MutationRec id, 0 for non-pipeline writes) | last `HIST` = 16 per field |
| `LogEntry` | `seq, v, t, writer, root, user, mutation` | last `LOG` = 512 per field |
| `RecentChange` | `t, seq, store, paths` (sorted, comma-joined), `key` (paths + `path=delta` pairs, sorted), `writer, root, user, mutation` | the hub keeps those within `RECENT_MS` = 10,000 ms, and at most `RECENT_MAX` = 256 |

- `StoreHub.seq` is the global **applied-change sequence number**. It is bumped once per recorded write that changed something. `OpRec.startSeq` is `hub.seq` when the op started, and facts compare field versions at that point using `versionAt(path, seq)`. `versionAt` is exact for the last 512 writes.
- Query helpers: `field`, `versionAt`, `logSince`, `writesSince`, `changedSince`, `pending`, `allLeaves`, `valueAt`, `leaf`, `describeValue`. The path-taking lookups (`field`, `versionAt`, `logSince`, `writesSince`, `valueAt`, `leaf`) resolve a path's store by `path.split(".")[0]`; `changedSince`, `pending` and `allLeaves` iterate all stores.
- `versionAt(path, seq)`: binary search of the field's 512-entry log for the last entry with `entry.seq <= seq`. If `seq` is older than the oldest kept entry it returns `log[0].v - 1` (exact only when nothing was trimmed); with an empty log it returns the current `v`; for an unknown path, 0.
- `changedSince(seq)` returns `{ path, hist, count }` for every field of every store with `f.seq > seq`: `hist` is limited to the 16-entry history, `count` comes from the 512-entry log.
- `FieldState` records are never deleted. A removed path keeps its `FieldState` (so `field(path)` still answers) while `leaf(path)` / `valueAt(path)` return undefined.

### `MutationRec` (one proposal)

| field | meaning |
|---|---|
| `id` | counter (`StoreHub.mid`) |
| `store`, `changes: FieldChange[]` | diff of the preview against the store's current leaves at proposal time |
| `cause: OpRec \| null`, `root` | the ambient op (`ctx.op()`) and its root |
| `t` | proposal time |
| `base` | `hub.read(s)` at proposal time |
| `preview`, `leaves` | the value the write would produce now, and its leaves |
| `fn?` | the functional updater. It is omitted when the preview had to be **detached** (see "in-place protection"), in which case the write is re-applied as a patch |
| `commit?` | custom commit (adapter `commit`); otherwise atom/guard semantics |
| `userSync`, `genclass` | bypass flags at proposal time |
| `defers` | 0, 1 or 2 |
| `state` | `queued` -> `held` -> `resolved` -> `done` |
| `verdict?: Verdict` | `"apply" \| "discard" \| "defer"` |
| `outcome?` | `applied`, `discarded`, `deferred` or `failed` (the app's setter threw) |
| `appliedAt?`, `appliedSeq?`, `applied?` | when it applied, its global seq, and the changes actually made. Late revert uses these |
| `unholdable?` | why the write could not be held |

`StoreHub.mutations` (a `Map<id, MutationRec>`, trimmed from above 512 down to 256 by deleting `done` entries) is written but never read anywhere in `src/`.

### `StoreRec` and `HubHooks`

`StoreRec { name, value, version, fields, leaves, opts, io?, subs, queue, unsubscribeIO?, committing, kind, writable }`.
- `version` counts recorded writes that changed something.
- `committing` suppresses external-change detection while GenClass itself commits through `io.set` or `commit`.
- `subs` holds `Atom.subscribe` listeners.

`HubHooks` is the seam to the runtime. `RuntimeImpl`'s constructor installs it:

| hook | runtime implementation | purpose |
|---|---|---|
| `gate(m)` | `RuntimeImpl.gateMutation` | raise the `mutation` trigger; return `{}` (apply now) or `{ held: Promise<Verdict> }` |
| `mayHold(s)` | `consultable() && mode !== "observe"` | whether a write could be held, which decides whether live state must be protected from in-place updaters |
| `waitRelated(m)` | `RuntimeImpl.waitRelated` | for `defer`: resolves when related in-flight ops end (at most `LONG_RUNNING_MS` = 10,000 ms) |
| `applied(m, s, changes, writer)` | `RuntimeImpl.onApplied` | bookkeeping plus scheduling a settled point |
| `discarded(m)` | `scheduleSettle()` | - |
| `proposed?(m)` | calls `CreateOptions.hooks.mutationProposed({ id, store, paths, cause?, changes })` synchronously; errors are swallowed | tracing (sim, demos) |
| `appError?(e, source)` | `RuntimeImpl.reportError(e, { source })` | app code threw while GenClass applied a write later |

`mayHold` ignores its store argument: `hold: false` stores never reach it because they already bypass in `propose`.

### `StoreHub` surface (`packages/runtime/src/state/hub.ts` -> `StoreHub`)

Constructor: `new StoreHub(clock, ctx, events, redact: () => Redactor)`, created once in the `RuntimeImpl` constructor. `hooks` is assigned right after.

| member | kind | used by / purpose |
|---|---|---|
| `stores: Map<string, StoreRec>` | readonly field | the registry; also read by `situation/build.ts` and `RuntimeImpl.pluginApi` |
| `seq` | field, starts 0 | global applied-change sequence (see above) |
| `recent: RecentChange[]` | readonly field | repetition facts (`situation/facts.ts`), late-revert chain check |
| `mutations: Map<number, MutationRec>` | readonly field | written, never read (see below) |
| `hooks: HubHooks` | field | installed by `RuntimeImpl` |
| `holdUserWrites` | field, default `false` | copied from `policy.holdUserWrites` once |
| `gating` | field, default `true` | `pause()`/`destroy()` set false, `resume()` sets true |
| `register(name, kind, initial, opts, io?)` / `unregister(name)` | methods | flow 1. `unregister` unsubscribes `io` and drops the snapshot cache entry; its only caller is `AdapterHandle.dispose` |
| `get(name)` / `read(s)` | methods | lookup; current value (`io.get()` or `s.value`) |
| `propose(s, w)` | method, returns `MutationRec \| null` (never null in practice) | flow 2 |
| `commit(s, m, rethrow)` | method | flow 4; also called directly by the `discard` undo |
| `write(s, next, writer, m, commit?, rethrow = false, leaves?)` | method | flow 4; also called directly by `rollback`, its undo, and post-`destroy()` writes |
| `external(s)` / `record(...)` / `notify(s)` | methods | flows 8 and 4 |
| `revertable(m)` / `revert(m, writer)` / `reapply(m, writer)` | methods | late revert and its undo (flow 7) |
| `restoreFields(values, writer)` | method, returns restored paths | chain revert and its undo (flow 10) |
| `snapshot()` / `allLeaves()` | methods | settled points (flow 9) |
| query helpers | methods | listed above |
| `previewOf`, `restoreInPlace`, `gateAndQueue`, `drain`, `defer`, `patched`, `mid`, `snapCache` | private | pipeline internals |

### Invariant miner (`invariants.ts`)

- A candidate (`Cand`, private) has: `id`, `tpl`, `text`, the operands `a`/`b`/`B`/`f`/`g`, `watch` (the leaf paths whose change counts as "involved"), `held` (supporting settled points), `learned`, and `typeKind`.
- Templates:

| tpl | id | text | proposed when (on the current leaves; paths under id-like segments skipped) | holds when |
|---|---|---|---|---|
| `type` | `type:<a>` | `typeof a stable` | every field whose kind is not null/undefined | kind == recorded kind (null/undefined: not applicable) |
| `nonnull` | `nonnull:<a>` | `a != null` | the field was never seen null/undefined, including its initial value (`nullSeen`) | value not null/undefined |
| `nonneg` | `nonneg:<a>` | `a >= 0` | number > 0 | number >= 0 (null/undefined: n/a) |
| `eq` | `eq:<a>:<b>` | `a == b` | two scalars (number/string) of the same kind, equal (`numEq` for numbers), value not 0 / `""` | equal (`numEq` for numbers, else `===`) |
| `len` | `len:<a>:<B>` | `a == len(B)` | number a (≠ 0) equals the length of a non-empty array B | `a === B.len` |
| `sum` | `sum:<a>:<B>:<f>` | `a == sum(B[*].f)` | B is a non-empty array of plain objects; f is a numeric column; `numEq(a, Σf)` | same; an empty B requires a ≈ 0 |
| `sumprod` | `sumprod:<a>:<B>:<f>:<g>` | `a == sum(B[*].f * B[*].g)` | as `sum`, for column pairs with `f < g` (string order) | same |
| `in` | `in:<a>:<B>:<k>` | `a ∈ B[*].k` | scalar a (not under B, not `""`/0) is a value of column k | the value is in the column set (null/undefined/`""`: n/a) |
| `unique` | `unique:<B>:<k>` | `B[*].k unique` | B has at least 2 elements and column k has no duplicates | no duplicates among non-null values |

- **Columns** come from the first 32 keys of element 0. The numeric columns are those numeric in every element; the scalar columns are those number-or-string in every element. Each list keeps at most `MAX_COLUMNS` = 8. Per-array statistics (`sums`, `prods`, `sets`, `unique`) are cached per `Leaf` object.
- **Non-trivial** (`nonTrivial`): a candidate is created, or gains support, only when it says something. `eq` needs a non-zero, non-empty, non-false value. `len` needs n > 0. `sum`/`sumprod` need n > 0 and a ≠ 0. `in`/`unique` need n >= 2. `nonneg` needs a value > 0.
- `numEq(a, b)` is true when the values are equal, or within a relative 1e-6 (scaled by `max(1, |a|, |b|)`), or when they differ by less than 0.0051 and round to the same cents.
- `Violation` (`packages/runtime/src/situation/env.ts`): `{ id, text, fields, values, held, developer? }`. `values` is redacted text such as `cart.count = 4, len(cart.items) = 5`.
- **Developer expectations:** `rt.expect(name, pred)` -> `InvariantMiner.addExpect`. They are evaluated at every settled point from the start. A false or throwing predicate gives `{ id: "expect:<name>", text: <name>, fields: [], values: "the predicate returned false", held: 0, developer: true }`. `expect` returns a disposer that removes only that registration; calling `expect` again with the same name replaces the earlier predicate.
- **Which fields are considered.** `propose` walks `hub.allLeaves()` in order (stores in registration order, then flatten order) and skips `dynamicPath` paths. Per-field templates (`type`, `nonnull`, `nonneg`) are tried for every remaining field. The relational templates only see the **first** `MAX_NUMERIC` (64) finite numeric leaves, `MAX_SCALAR` (96) number/string leaves and `MAX_ARRAYS` (24) array leaves in that order, so fields of stores registered late in a big app may never get `eq`/`len`/`sum`/`in`/`unique` candidates. Once `MAX_CANDIDATES` (4,000) candidates exist, `add` creates nothing new until some are dropped.
- **Null tracking:** `noteValues` runs at registration and on every applied write with `[path, afterLeaf]`. A null/undefined value **or a removed path** marks the path `nullSeen` and drops a not-yet-learned `nonnull:<path>` candidate at once (not only at the next settled point).
- **Learned is permanent.** A learned candidate is never dropped. While it is broken it is returned in `observe()`'s violations (and `current()`) at every settled point; the runtime raises it only once per episode.
- **Shape changes count as violations.** For a learned `sum`/`sumprod`, a non-empty `B` whose elements are no longer all plain objects, or whose column `f` (or `g`) is missing or non-numeric in any element, or is no longer among the first `MAX_COLUMNS` (8) numeric columns taken from element 0's first 32 keys, evaluates to `false`, not "not applicable". For example, one placeholder element `{ id, loading: true }` without `price` breaks `total == sum(items[*].price)`. A learned `in` is also `false` once `B`'s elements are not all plain objects. `unique` returns `true` in that case.
- Introspection: `learned()` returns `{ id, text, held }[]`, `candidates()` returns the candidate count, and `points` counts settled points. Tests use them through `rt.miner` (`invariants.test.ts`) or `rt.internals.miner` (`review-perf.test.ts`).

### Runtime-side state terms

- **User-sync write:** the cause is the current task's user op or descends from it (`Context.isUserSync`: `op === taskUser || op.root === taskUser.root || op.root === taskUser.id`). `taskUser` is set by `RuntimeImpl.user` -> `Context.stickUser` and cleared after the macrotask (`clock.afterTask`). A write with no ambient op at all is not user-sync and is treated like async code.
- **Bypass write:** applied at once in the caller's stack. Errors propagate to the caller.
- **Consistent snapshot:** `{ t, seq, values: Map<store, deep clone> }` in `RuntimeImpl.snaps`, newest last, at most 8.
- **Episode:** the set of violation ids at the previous settled point (`RuntimeImpl.episode`). A violation is *fresh* only when it was not violated at the previous settled point.
- **Muted:** violation ids whose rollback the developer undid. They are not raised again until they hold at a settled point.
- **Chain revert:** the `rollback` used for `error`/`transition` triggers. It restores only the fields the op's causal chain wrote (see flow 10).

## How it works

### 1. Registering a store

1. `RuntimeImpl.atom(name, initial, opts)`:
   - If a store of kind `atom` named `name` exists, it is reused: `initial` is ignored, and `opts` are merged only if `resync`, `describe` or `hold` is given.
   - Otherwise `StoreHub.register(name, "atom", initial, opts)` runs, followed by `miner.noteValues(s.leaves)`, which records fields that start out null.
   - It returns `RuntimeImpl.handle(s)`.
2. `RuntimeImpl.guard(name, io, opts)` -> `register(name, "guard", io.get(), opts, io)`. If `io.subscribe` exists, the hub subscribes and calls `StoreHub.external(s)` whenever the store changes while `!s.committing`.
3. `RuntimeImpl.adapter(name, io, opts)`:
   - Wraps `io` in a `StoreIO` whose `set` throws `store <name> cannot be written by GenClass` when `io.set` is missing.
   - Registers kind `adapter` and sets `s.writable = typeof io.set === "function"`.
   - Returns `{ name, propose, dispose }`. `propose(w)` forwards to `StoreHub.propose(s, { fn | value, commit })`. After `destroy()` it computes `next` and calls `hub.write(s, next, null, null, commit)` directly. `dispose()` unregisters only if the hub still holds this same record.
4. `StoreHub.register`:
   - **Replaces** any existing store with the same name (whatever its kind), unsubscribing the old one.
   - Flattens the initial value.
   - Creates a `FieldState` (v 0) per leaf.
5. Atom handle (`RuntimeImpl.handle`):
   - `get()` -> `hub.read(s)`.
   - `set(next)` -> `hub.propose(s, { fn })` or `hub.propose(s, { value })`. After destroy it calls `hub.write` directly.
   - `update(fn)` = `set(fn)`.
   - `subscribe(fn)` adds to `s.subs` and returns an unsubscribe function.

### 2. Proposing a write (`StoreHub.propose`)

1. `cause = ctx.op()` (this materialises a lazy timer op), `base = read(s)`, `userSync = ctx.isUserSync(cause)`, `genclass = !!cause?.genclass`.
2. `bypass = (userSync && !holdUserWrites) || genclass || s.opts.hold === false || !gating`. `gating` is false after `pause()` or `destroy()`.
3. `guarded = !bypass && hooks.mayHold(s)`.
4. `previewOf(s, w, base, guarded)`:
   - Value write: `preview = w.value`.
   - Functional write: `preview = w.fn(base)`. If the write is `guarded`, the hub checks whether the updater mutated the live value in place: it flattens `base` against the stored leaves.
   - If it did, the preview is **detached**: `cloneValue(preview)`, then `restoreInPlace` undoes the in-place edits using the recorded `beforeLeaf` values.
   - If cloning or the exact restore fails, the write is marked `unholdable` ("the update changed the stored value in place, so it could not be held").
5. `changes = diffLeaves(s.leaves, previewLeaves)`. A `MutationRec` is built and `hooks.proposed(m)` fires. This happens for bypass writes too.
6. If `changes.length === 0 || bypass || unholdable`: `commit(s, m, rethrow = true)` runs **now**, in the caller's stack, and returns.
7. Otherwise the write is pushed onto `s.queue` and `gateAndQueue(s, m)` runs.

### 3. Gate and hold (`StoreHub.gateAndQueue` -> `RuntimeImpl.gateMutation`)

1. If `!consultable()` (paused, destroyed, no decider, or decider status not `ready`/`off`), the gate returns `{}`: the write is resolved as `apply` and the queue drains.
2. Otherwise it builds a `Controller` and calls `RuntimeImpl.trigger({ trigger: "mutation", m }, ctl, { hold: true, priority: 2 })`. The controller's methods:
   - `passive` -> verdict `apply`.
   - `run("discard")` -> verdict `discard`. Its effect text is "Dropped the write to … stays at version N". Its `undo` commits the original mutation as a GenClass write.
   - `run("defer")` -> verdict `defer`.
   - `revertable` / `revert` are used for late reverts (flow 7).
3. Inside `trigger`, see [decide-policy-actions.md](decide-policy-actions.md) and [learn-situation-triage.md](learn-situation-triage.md):
   - If the trigger is not salient, the model is not ready, or no non-passive action is permitted (always the case in `observe` mode), `passive()` runs **synchronously**. `gateMutation` sees `syncVerdict === "apply"` and returns `{}`.
   - Otherwise the write is **held**. A timer fires after `holdBudgetMs()`: then `expired = true` and `passive()` runs (fail-open).
   - The decision deadline is `t0 + budget + LATE_REVERT_MS`, because the mutation controller supports `revert`.
   - When the write does not wait because no non-passive action is permitted, the decision is still requested in the background for detection (queue priority capped at 1). A non-passive answer is then only recorded: `gate` finds no permitted candidate, nothing runs, and `Decision.reason` is the restriction of the model's top choice (e.g. `observe mode never changes execution`) or `no action is permitted`, set only when that top choice was non-passive. `the subject was not held` appears only if `setMode` widened the permitted set between the trigger and the answer (see [decide-policy-actions.md](decide-policy-actions.md#3-gate-and-bookkeeping-runtimets---ondecision-policyts---gate)).
4. `gateMutation` returns `{}` for a synchronous `apply`, otherwise the pending promise. It also has a defensive branch that wraps a synchronous `discard`/`defer` in `Promise.resolve(verdict)`; with the current `trigger`, actions only run in the queue's `.then` (`onDecision`), so only `apply` can be synchronous.
5. A held promise resolves to the verdict. If the gate throws, the result is treated as `{}`. If the held promise rejects, the verdict is `apply`.

### 4. Drain, commit, record

1. `StoreHub.drain(s)` pops resolved writes **from the head only**, which keeps proposal order per store.
   - `discard` -> `outcome = "discarded"`, `hooks.discarded`. Nothing is written and app subscribers are not notified.
   - `defer` with `defers < 2` -> `outcome = "deferred"` and flow 5.
   - Otherwise (`apply`, or a third `defer`) -> `commit(s, m, false)`.
   - Every branch is wrapped in try/catch. On an error, `hooks.appError(e, "applying a write to <store>")` runs and draining continues.
2. `StoreHub.commit(s, m, rethrow)`:
   - If `read(s) === m.base`: `next = m.preview` and the precomputed leaves are reused.
   - Otherwise `next = m.fn ? m.fn(current) : patched(s, m, current)`. The updater re-runs, or the value write is re-applied as a patch.
   - If that throws: with `rethrow` it propagates. Without it, `appError(e, "re-running an update of <store>")` runs and the hub falls back to `next = m.preview`, the value computed at proposal time.
   - Then `ctx.run(m.cause, () => write(...))`. The write's cause is the ambient op, so writes made by subscribers join the same causal chain.
3. `StoreHub.write(s, next, writer, m, commit?, rethrow, leaves?)`:
   - With `commit` or `io`: set `s.committing = true` and call `commit(next)` or `io.set(next)`.
   - On a throw: rethrow, or call `appError(e, "the setter of <store>")` and return `null` (`outcome = "failed"`).
   - Afterwards re-read the store. If the store now holds a different reference than `next`, that value is what gets recorded.
4. `StoreHub.record(s, next, writer, m, precomputed?)`:
   - Diff the new leaves and set `s.value` and `s.leaves`.
   - With no changes: notify subscribers only when the reference changed or when this is a pipeline write ("every `set()` notifies subscribers").
   - With changes:
     - `seq++` and `version++`.
     - Per changed field: `v++`, writer, `t`, `seq`, a `FieldHist` entry and a `LogEntry`.
     - Push a `RecentChange` and trim the recent list.
     - Push a `state` event. Its `op` is the writer and its data is `{ store, paths, mutation, user, summary }`, where the summary covers the first 3 changes via `changeText`.
     - Call `hooks.applied` and `notify(s)`.
5. `StoreHub.notify` calls each `subs` listener with `s.value`. A throwing listener goes to `appError(e, "a subscriber of <store>")` and is never rethrown, even on the synchronous path.
6. `RuntimeImpl.onApplied(m, s, changes, writer)`:
   - `writer.wrote++` and `writer.storesWritten`.
   - For the writer and up to 8 ancestors (GenClass ops skipped): increment `storeWriters[opSignature][store]` (capped at 1,000 signatures, FIFO). Profiled op kinds (`fetch`, `xhr`, `user`, `task`, `ws`) that are not yet profiled also accumulate `op.chain[normalizeFieldPath(path)] = { kind, len0, len1 }` and `op.chainWrites` for transition profiles.
   - `miner.noteChanged(paths)` and `miner.noteValues(...)`.
   - `scheduleSettle()`.

### 5. Defer (`StoreHub.defer`)

1. `hooks.waitRelated(m)` (`RuntimeImpl.waitRelated`) waits for the related in-flight ops. An op is related when it is not in the cause's own ancestry or descent and either has the cause's signature and kind, or its signature's chains have written this store before (`storeWriters`). The wait resolves when all of them end, or after 10,000 ms.
2. Then the write is re-proposed **at the end of the queue** with the same id, cause and intent:
   - `preview = m.fn ? m.fn(cloneValue(base)) : patched(s, m, base)`. If that throws, the old preview is used.
   - `defers + 1`, new `changes`.
   - If nothing would change, or `gating` is off, it commits at once (errors reported, not rethrown). Otherwise it goes through `gateAndQueue` again.
   - `hooks.proposed` (`mutationProposed`) is **not** called again for the re-proposal. If the store was unregistered while waiting (`!stores.has(name)`), the write is silently dropped.
3. The `defer` action is not offered once `defers >= 2` (`packages/runtime/src/situation/build.ts` -> `builtinApplicable`). The facts add "This write was already deferred once." / "… twice." (`situation/facts.ts` -> `mutationFacts`).

### 6. Patches (`fields.ts` -> `patchValue`)

Used by `patched` (a held or queued value write applied over newer state), `revert`, `reapply` and `restoreFields`.

1. If a change targets the whole store (`path === store`), return its value.
2. If the current value is not a plain object, return `ok: false`.
3. `sets` = changes that are not removals. `removals` = removed changes **except** those with a set beneath them (`t.path.startsWith(c.path + ".")`). Example: when an empty object `data: {}` is filled, its collection leaf `x.data` disappears (a removal) and `x.data.name` appears (a set). Applying the removal of `x.data` would delete the whole object in the current value, including anything newer writes put under it.
4. Apply all removals first, then all sets, with copy-on-write along each path. Missing intermediate objects are created for sets and ignored for removals. A non-plain-object intermediate gives `ok: false`.
5. When a patch fails: `patched` falls back to `m.preview`, `revert`/`reapply` return null, and `restoreFields` skips that store.

### 7. Late revert (hold budget expired, then `discard`)

1. In `RuntimeImpl.onDecision`, when `st.hold && (st.expired || passiveRan)` and the gate chose `discard`, the runtime calls `ctl.revertable()`. It returns null or a reason string:
   - `the write has not applied yet`;
   - age > `LATE_REVERT_MS` (2,000 ms) -> `too late to revert: decided Xs after the write applied`;
   - `StoreHub.revertable(m)`: `the store is gone`; `the write was not applied`; `<store> cannot be written by GenClass`; `the write changed nothing`;
   - `superseded: <path> changed again after the write applied`, when for some applied path the field's last log entry is not this mutation;
   - `the same operation chain wrote <paths> after this write applied; …`, when a `RecentChange` with `seq > appliedSeq` has the same root and a different mutation id. Writes made synchronously by subscribers count, because they run under the write's cause.
2. If it is revertable: `runAsGenClass("revert", () => hub.revert(m, op))` patches `m.applied` back to the `before` values. The `ActionRecord` gets `late: true` and the text "Reverted the write to … (decided Xs after it applied); … is back to …". `undo` -> `hub.reapply(m)`.
3. Any other verdict that arrives after expiry is only recorded, with the reason "the decision arrived after the hold budget expired".
4. The decision deadline for a held write is `t0 + holdBudgetMs() + LATE_REVERT_MS`. A request still unanswered then is abandoned by the decider queue (`decide/decider.ts` -> `DeciderQueue`), so no decision is recorded at all (`atoms.test.ts` "a late discard does not revert … or after 2 s"). Because a held write cannot apply before its own budget expires, a decision that beats the deadline is at most 2 s after the apply, so the `too late to revert` branch is effectively unreachable (found by code reading).

### 8. External changes

`io.subscribe` -> `StoreHub.external(s)` -> `record(s, read(s), ctx.op(), null)`. The change is recorded with the ambient op as writer, `user = ctx.isUserSync(writer)` and `mutation = 0`. It is **never held**. This is how direct `store.dispatch` calls bypassing the enhancer, or app-side changes to a guarded store, get versions.

### 9. Settled points, invariants, snapshots, inconsistency

1. `RuntimeImpl.scheduleSettle()` is a debounced `clock.setTimeout(settled, settleMs)`, with a default of 60 ms. It is called from `onApplied`, from `discarded`, and from every `endOp`.
2. `RuntimeImpl.settled()` returns early if the runtime is destroyed or `busy()`. `busy()` is true when any in-flight op started less than 10,000 ms ago, or `hub.pending()` is non-empty. It does **not** reschedule; the next write or op end does.
3. `miner.observe(hub.allLeaves(), now)`:
   1. `points++`. Take and clear the `changed` paths.
   2. For every candidate: `h = holds(c, L)`. Skip it when `h` is null (a field is missing, or the template does not apply to the current values, e.g. a null operand). `involved` means a watched path, or a path below it, changed since the last settled point.
      - Learned: if it holds and is involved, `held++`. If it does not hold, it is a **violation** (learned candidates are never dropped).
      - Not learned: if it does not hold, it is **dropped forever** (added to the `dropped` set). If it holds, is involved and is non-trivial, `held++`. It becomes learned at `LEARN_AFTER` (3), or at `LEARN_AFTER_NONNULL` (6) for `nonnull`.
   3. `propose(L)` creates new candidates (see the template table). A new candidate starts at `held = 1` if one of its fields changed at this settled point.
   4. Evaluate the developer expectations.
   5. Return the violations, also kept in `current()`.
4. Back in `settled()`:
   - `brokeNow` = violations not in the previous `episode`; `fresh` = `brokeNow` minus `muted`. Then `episode = current ids`, and muted ids that hold again are cleared.
   - If `brokeNow` is empty, take a **snapshot**: `hub.snapshot()` deep-clones every store, reusing unchanged stores and unchanged top-level keys. If the last snapshot has the same `seq`, only its `t` is refreshed. At most 8 snapshots are kept.
   - If `fresh` is non-empty: `raiseInconsistency(fresh)` -> `trigger({ trigger: "inconsistency", violations }, ctl, { hold: false, priority: 1 })`. The actions are `ignore` (passive), `rollback` and `resync`.
   - Then the transition profiles run; see [learn-situation-triage.md](learn-situation-triage.md).
5. Mutation facts also call `env.previewInvariants(m)` -> `InvariantMiner.preview`. It reports learned invariants touching the written paths that would break on the preview leaves, as a **neutral** fact, because transient breaks between two writes are common.

### 10. State-restoring actions

| action (trigger) | implementation | what it restores | offered when (`builtinApplicable`) | undo |
|---|---|---|---|---|
| `rollback` (`inconsistency`) | `RuntimeImpl.rollback(stores, violationIds)` | the **whole value** of each involved store that is writable and present in the newest consistent snapshot. Written via `hub.write(s, cloneValue(snapValue), genclassOp, null)`; adapters receive it through `io.set` | a consistent snapshot exists and some involved store is writable | writes the pre-rollback clones back and mutes the violation ids |
| `rollback` (`error`, `transition`) | `RuntimeImpl.revertChain(op, why)` -> `chainWrites(op)` -> `hub.restoreFields` | only the fields written by the op's root chain since `root.startSeq` that nobody else overwrote (`lastIsChain`) and whose value before the chain's first write is still in the 16-entry history | the chain wrote such a field in a writable store | `restoreFields(current values)` |
| `resync` (`inconsistency`, `transition`) | `RuntimeImpl.resync(stores)` | calls each involved store's `opts.resync()` inside a GenClass op | some involved store has `resync` | none |
| `discard` undo | `hub.commit(st, { ...m, genclass: true, … }, false)` | applies the dropped write now (re-run or patch) | - | - |

Failure messages (thrown, so the action is recorded as failed): `no consistent snapshot`, `nothing to restore: the affected stores already match the snapshot` (`rollback`); `the chain wrote nothing that can be restored`, `nothing to restore: the fields already hold their earlier values` (`revertChain`); `no resync handler` (a rejected `resync`). Effect texts: `Restored <store> (<paths>) to the consistent state from Ns ago.`, `Restored <paths> to their values before <root op> (the <error|transition>'s chain wrote them).`, `Reloaded <stores> from its/their source (resync handler).`. `resync` awaits every handler with `Promise.all`. Ops started inside it inherit `genclass` from their cause (`packages/runtime/src/trace/ops.ts` -> `OpRegistry.start`), so the writes its requests trigger also bypass gating.

All of these run inside `runAsGenClass(...)`, and `ActionRecord.undo` wraps undos in `runAsGenClass("undo")`, so their writes bypass gating. They are recorded with a GenClass op as the writer. The exception is the discard undo: `hub.commit` runs under `m.cause`, so it is recorded with the original cause as the writer.

### 11. Adapters

**React** (`packages/runtime/src/adapters/react.ts`):

```tsx
GenClass.init();                                                    // or <GenClassProvider runtime={rt}>
const [results, setResults] = useGenClassState("results", [] as Item[]);   // shared named atom
const [cart, setCart] = useAtom(cartAtom);                          // any Atom from rt.atom / rt.guard
```

1. Which runtime is used: `useRuntimeOrNull()` returns the nearest `<GenClassProvider runtime>` value. If there is no provider (context `undefined`), it returns `GenClass.runtime`. `runtime={null}` explicitly means no GenClass.
2. `useGenClassState(name, initial, opts?)`:
   - With a runtime, `atomFor` creates or reuses **one atom per (runtime, name)**, stored in a module `WeakMap<Runtime, Map<name, Atom>>`. The lazy `initial` is called once. `opts` only apply at creation. Creation is idempotent, which makes it safe under StrictMode.
   - It reads with `useSyncExternalStore` over memoised wrappers of `atom.subscribe` and `atom.get` (the same getter for the server snapshot). The setter calls `atom.set`, so a held write shows up only when it applies and never when it is dropped.
   - Without a runtime it is plain `useState`, and it logs one `console.info` per module (`warned`).
3. `useAtom(atom)` is `useSyncExternalStore` over any `Atom`. `getGenClassAtom(rt, name)` returns a hook-created atom so code outside React can use it. It returns `undefined` for a store created with `rt.atom` directly, because it reads only the hook registry.
   - `atomFor` calls `rt.atom(name, …)`. If `name` is already an **atom**, that returns the existing store, merging `opts` when `resync`/`describe`/`hold` is given. If `name` is a **guard or adapter** store (for example a Redux store named `"cart"`), `rt.atom` re-registers it as an atom and replaces it (see Gotchas).
   - Signatures: `useGenClassState<T>(name: string, initial: T | (() => T), opts?: StoreOptions<T>): [T, Dispatch<SetStateAction<T>>]`; `useAtom<T>(atom: Atom<T>): [T, (next: T | ((prev: T) => T)) => void]`; `getGenClassAtom<T>(runtime: Runtime, name: string): Atom<T> | undefined`.
4. `useGenClass()` throws `[GenClass] No runtime: …` when there is none.
5. `useGenClassDecisions(limit = 50)` refreshes on `decide`/`act`. `useGenClassInterventions(limit = 50)` refreshes on `act`. Both cache snapshots per event version. `useGenClassStatus()` returns a snapshot keyed by content, so providers that mutate the status object in place still re-render, and it returns `{ state: "off" }` without a runtime.

**Redux** (`packages/runtime/src/adapters/redux.ts`):

```ts
configureStore({ reducer, enhancers: (gd) => gd().concat(genclassEnhancer(GenClass.runtime, { name: "app" })) });
createStore(reducer, compose(applyMiddleware(thunk), genclassEnhancer(rt, { name: "app" })) as StoreEnhancer);
```

Signature: `genclassEnhancer<S = unknown>(runtime: Runtime | null | undefined, options: GenclassEnhancerOptions<S>): StoreEnhancer`, where `interface GenclassEnhancerOptions<S> extends StoreOptions<S> { name: string }`. So `resync`, `hold` and `describe` can be passed next to `name`; everything except `name` is forwarded to `runtime.adapter` as `StoreOptions`.

1. The enhancer wraps the reducer:
   - `@@genclass/REPLACE` (`GENCLASS_REPLACE`) returns `action.state`.
   - If `ready` holds `{ action, prev, next }` for this exact action object and previous state, it returns `next` without re-running the reducer.
   - Otherwise it calls the current reducer.
2. If `runtime` is null, the store is returned unchanged. Only the REPLACE-aware reducer wrapper remains.
3. The store is registered as `runtime.adapter(name, { get: getState, set: v => raw({ type: GENCLASS_REPLACE, state: v }), subscribe }, storeOpts)`. Because `set` exists, Redux stores are writable (rollback works).
4. `dispatch(action)`:
   - A non-action (a thunk) passes straight to the inner dispatch.
   - Otherwise it computes `next = reducer(state, action)` once, as the preview.
   - If `next === state`, it is a plain dispatch: subscribers are notified and nothing is proposed.
   - Otherwise `handle.propose({ fn: prev => prev === state ? next : reducer(prev, action), commit: v => dispatchKnown(action, v) })`, and it returns `action` synchronously, even while the write is held.
5. `dispatchKnown` sets `ready` and calls the inner dispatch, so inner enhancers such as Redux DevTools, reducers and subscribers see the **original action exactly once**, at apply time. A dropped dispatch never reaches them.
6. `replaceReducer` swaps `current` and re-installs the wrapper.
7. Put the enhancer **last** in `compose()` (innermost). If it is outermost, the actions that thunks dispatch through the middleware API skip it; they are then only recorded as external changes and never held.

**Zustand** (`packages/runtime/src/adapters/zustand.ts`):

```ts
const useCart = create<Cart>()(genclass(GenClass.runtime, "cart")((set) => ({ items: [], add: (i) => set((s) => ({ items: [...s.items, i] })) })));
create<Cart>()(devtools(genclass(rt, "cart")(creator)));   // with devtools outside
```

Signature: `genclass(runtime: Runtime | null | undefined, name: string, opts?: StoreOptions<unknown>)` returns a middleware `(initializer) => initializer` that keeps Zustand's mutator typing. `opts` (`resync`, `hold`, `describe`) go to `runtime.adapter`.

1. If `runtime` is null, the initializer runs unchanged.
2. `gset(partial, replace, ...rest)`:
   - Before the handle exists (a `set` during creation), it calls the outer `set` directly. Such a write is neither traced nor proposed.
   - Otherwise it proposes `fn: prev => { next = typeof partial === "function" ? partial(prev) : partial; if (Object.is(next, prev)) return prev; whole = replace ?? (typeof next !== "object" || next === null); return whole ? next : Object.assign({}, prev, next) }` with `commit: v => outer(v, true, ...rest)`.
   - Extra arguments, such as devtools action names, are forwarded. The commit always passes `replace = true`, with the whole computed state.
3. `api.setState` is replaced by `gset`, so `store.setState` also goes through the pipeline.
4. Registration is `runtime.adapter(name, { get: () => api.getState() ?? initial, set: v => outer(v, true), subscribe }, opts)`. Zustand assigns its state after the creator returns, hence the `initial` fallback. The action functions in the state become fields of kind `function`.

**Common to all adapters:**
- Neither the Redux enhancer nor the Zustand middleware ever calls (or exposes) `AdapterHandle.dispose()`, so their stores stay registered for the runtime's lifetime. Creating a second store with the same name (HMR, tests, two stores both named `"app"`) replaces the first hub record through `StoreHub.register`. The first store's GenClass subscription is dropped, and its handle keeps proposing to the orphaned record.
- Packaging: `adapters/react.ts` imports `GenClass` from `../index.js`. `tsup.config.ts` builds every entry with `splitting: true`, so the singleton lives in a shared chunk: in the build output, `dist/adapters/react.js` imports `GenClass` from `../chunk-*.js`. Turning splitting off would give the React subpath its own `GenClass` copy, and `GenClass.init()` from the main entry would then be invisible to the hooks. That consequence is inferred from the build config, not tested.
- `demos/` can run against development stand-ins in `demos/src/dev/runtime-shim/` (observe-only; the Redux and Zustand shims are identity wrappers), aliased by `demos/vite.config.ts` when `GENCLASS_SHIM=1`, or when `packages/runtime/dist/index.js` is missing and `GENCLASS_SHIM` is not `0`. Behaviour seen there is not the adapters' behaviour; see [../demos.md](../demos.md).

## Configuration and constants

| name | type | default / value | defined in | effect |
|---|---|---|---|---|
| `StoreOptions.hold` | boolean | `true` | `packages/runtime/src/types.ts` (read in `StoreHub.propose`) | `false`: writes are traced, never held |
| `StoreOptions.resync` | function | none | `types.ts` | enables `resync` for the store |
| `StoreOptions.describe` | `(v) => string` | none | `types.ts` (used in `situation/build.ts` -> `stateLines`) | one-line store description in state lines |
| `policy.holdUserWrites` | boolean | `false` | `packages/runtime/src/decide/policy.ts` -> `policyConfig`; copied once to `StoreHub.holdUserWrites` in the `RuntimeImpl` constructor | `true`: user-sync writes go through the gate too |
| `policy.holdBudgetMs` | number \| `"auto"` | `"auto"`: clamp(1.5 × median recent model latency, or warm-up time, `HOLD_MIN_MS` 150, `HOLD_MAX_MS` 800); `HOLD_FALLBACK_MS` 300 when nothing is known | `decide/policy.ts` -> `holdBudget` | how long a held write waits before fail-open |
| `InitOptions.settleMs` (also on `CreateOptions`) | number | `60` | `types.ts`; default in the `runtime.ts` constructor (`o.settleMs ?? 60`) | quiet time before a settled point |
| `LATE_REVERT_MS` | const | `2000` | `runtime.ts` | late-revert window; extends the decision deadline for held writes |
| `LONG_RUNNING_MS` | const | `10_000` | `runtime.ts` | ops older than this do not block settled points; maximum wait for `defer` |
| snapshots kept | literal | `8` | `runtime.ts` -> `settled` | consistent snapshots retained |
| `storeWriters` cap | literal | 1,000 signatures | `runtime.ts` -> `onApplied` | FIFO eviction |
| ancestors per write | literal | `8` | `runtime.ts` -> `onApplied` | depth for `storeWriters` and transition accumulators |
| max defers | literal | `2` | `hub.ts` -> `drain`; `situation/build.ts` -> `builtinApplicable` | third `defer` verdict applies |
| mutation trigger priority | literal | `2` (inconsistency `1`) | `runtime.ts` | decider queue priority |
| `HIST` / `LOG` | const | `16` / `512` | `hub.ts` | rich history / compact log per field |
| `RECENT_MS` / `RECENT_MAX` | const | `10_000` ms / `256` | `hub.ts` | recent changes (repetition facts, late-revert chain check) |
| `mutations` map trim | literal | > 512 -> 256 | `hub.ts` -> `propose` | bookkeeping only |
| `MAX_DEPTH` | export const | `4` | `fields.ts` | key levels expanded below the store |
| `MAX_FIELDS_PER_STORE` | export const | `200` | `fields.ts` | an object is not expanded when `leaves so far + its keys` would exceed this (soft cap per object, not a hard store limit) |
| `STRINGIFY_CAP` | const | `65_536` chars | `util.ts` -> `stableStringify` | `hashValue` input cap (element and non-plain-object hashes) |
| `MAX_KEYS_EXPAND` | export const | `32` | `fields.ts` | larger plain objects are one collection field |
| `SAMPLES` | const | `8` | `fields.ts` | positions re-hashed to detect in-place element mutation |
| `ID_KEYS` | const | `id, _id, key, uuid, slug, name, title, label` | `fields.ts` | id key shown in element summaries |
| `cloneValue` | fn | `structuredClone`, else a manual clone (depth ≤ 32; arrays, Date, Map, Set, plain objects; other objects by reference) | `fields.ts` | snapshots, rollback values, detached previews, defer re-runs |
| `LEARN_AFTER` | export const | `3` | `invariants.ts` | supporting settled points to learn |
| `LEARN_AFTER_NONNULL` | export const | `6` | `invariants.ts` | same, for `a != null` |
| `MAX_NUMERIC` / `MAX_SCALAR` / `MAX_ARRAYS` | const | `64` / `96` / `24` | `invariants.ts` | fields considered per settled point |
| `MAX_COLUMNS` | const | `8` (from the first 32 keys) | `invariants.ts` | numeric/scalar columns per array |
| `MAX_CANDIDATES` | const | `4000` | `invariants.ts` | no new candidates beyond this |
| `MAX_DROPPED` | const | `50_000` | `invariants.ts` | the dropped set is **cleared** when full, so dropped ids can be proposed again |
| `numEq` tolerance | fn | relative 1e-6, or < 0.0051 and equal in cents | `invariants.ts` | numeric equality in invariants |
| `GENCLASS_REPLACE` | export const | `"@@genclass/REPLACE"` | `adapters/redux.ts` | action used for GenClass's whole-state writes |
| React hooks `limit` | param | `50` | `adapters/react.ts` | `useGenClassDecisions` / `useGenClassInterventions` |

## Invariants and gotchas

**Pipeline semantics (break these and tests in `atoms.test.ts` / `review-hub.test.ts` fail):**
- **Proposal order per store.** `drain` only pops from the head. A write the gate cleared synchronously still waits behind an earlier held write to the same store.
- **Bypass writes skip the queue.** This is an open product risk (`demos/NEEDS.md` §1). A user-sync write applies at once even when an earlier async write to the same store is held. When the held write is released, its functional updater re-runs on top of the user's change and can overwrite it, which differs from the order the app would see without GenClass. `atoms.test.ts` "functional updates re-run against the value at apply time" asserts the current behaviour. Fixing it changes that test.
- **A held write must not change live state before the decision.** Only *functional* updaters are protected (detach and restore). A *value* write of an object the app already mutated in place (`v = a.get(); v.items.push(x); a.set(v)`) changes live state before the hold, and a `discard` cannot undo that. GenClass's leaves then disagree with live state until the next write. This was found by code reading; no test covers it.
- **Updaters may run more than once:** at proposal (preview), again at apply when the state moved, and on a clone for each defer. The same holds for Redux reducers and Zustand partial functions. They must be pure.
- **Fallback to the stale preview.** If a re-run updater throws at apply time (not the synchronous path), or a patch is impossible, the hub applies `m.preview`, the value computed against the old state. That can overwrite newer fields.
- **Error routing.** On the synchronous path (`commit(…, rethrow = true)`), updater and setter errors propagate to the caller. Subscriber errors are always reported, never thrown. On the later path, `appError` -> `RuntimeImpl.reportError` (source `applying a write to X`, `re-running an update of X`, `the setter of X` or `a subscriber of X`) **raises an `error` trigger**. The queue continues, so a throwing setter never strands later writes (`review-hub.test.ts` "a commit that throws").
- **Reads while held:** `atom.get()`, `store.getState()` and Zustand `get()` return the pre-write state until the write applies. Redux `dispatch` returns the action immediately.
- **Discard means no notification:** app subscribers and React never see a discarded value (`atoms.test.ts`, the adapter tests).
- **`gating` is the only global switch.** `pause()` and `destroy()` set it to false, and every write then applies immediately but is still recorded. After `destroy()`, atom/guard `set` and `AdapterHandle.propose` skip `propose` entirely: they call `hub.write(…, writer = null, m = null)`, so no `mutationProposed` hook fires and no cause is recorded. `destroy()` also unsubscribes every `io.subscribe`, so external changes are no longer recorded, and `scheduleSettle` becomes a no-op.
- **An updater that throws at proposal time always throws from `set()` / `dispatch` / `propose`.** `previewOf` runs `w.fn(base)` outside any try/catch, before the write is queued or recorded, so this happens whatever path the write would have taken.
- **A library subscriber that throws inside `commit` looks like a failed setter.** Redux and Zustand update their state and then call listeners inside the same `dispatch`/`setState`. If a listener throws, `StoreHub.write` catches it as `the setter of X`: it rethrows on the synchronous path, or reports it with `outcome = "failed"` later. In both cases `record` is skipped and the hub's own listener was suppressed (`committing`), so the library holds the new state while GenClass's leaves, versions and `state` events miss it until the next recorded change. Found by code reading; no test covers it.

**Store names and paths:**
- **Store names must not contain `.`. Nothing enforces this.** Every lookup by path splits on `.` and takes segment 0 as the store name: `field`, `versionAt`, `logSince`, `writesSince`, `valueAt`, `leaf`, `restoreFields`, `snapshot` (top-level key = segment 1), `restoreInPlace` and `patchValue` (`segs = path.split(".").slice(1)`). For a store named `search.results`:
  - its fields never appear in state lines (only a `describe` one-liner can);
  - versions facts always say the field "has not changed", which defeats stale-write detection;
  - chain revert skips it, and inconsistency `rollback`/`resync` are never offered for it (`builtinApplicable` derives the store name `search`, which does not exist);
  - the in-place-updater protection cannot restore it, so such updates are marked unholdable and apply at once;
  - a patched held value write on an object-valued store writes under the wrong key (`value.results.x` instead of `value.x`);
  - `snapshot()` takes segment 1 (`results`) as the changed top-level key, so for an object-valued store it reuses stale clones of changed keys.
  The README and the `react.ts` header use `useGenClassState("search.results", [])`. That is an array value, so the patch corruption does not happen there, but the lookups still fail. This was found by code reading; no test covers it.
- **Names are global per runtime across kinds.** `register` replaces any store with the same name. For example, `rt.atom("cart")` after `rt.guard("cart", …)` re-registers it as an atom, resetting versions and history, and old handles keep writing to the orphaned record. `rt.atom(name)` with an existing atom name returns the existing store and ignores `initial`.
- **Path ids for invariants:** `dynamicPath` skips any path with an `isIdSegment` segment (numbers, uuids, long hex, long tokens, short slug ids such as `x7k2p`). `m21` is **not** an id segment there (3 chars), but `normalizeFieldPath` (transition profiles) does treat any key with a digit as `:id`.

**Change detection limits:**
- **In-place element mutation is only sampled.** An array or collection whose elements keep their references is re-hashed at 8 sampled positions only. Mutating element 1,234 of 5,000 in place, without replacing the element object, is not detected. Immutable updates are always detected (`review-hub.test.ts` "large arrays").
- **A collection mutated in place is checked even less.** Arrays always compare every element reference, but a plain-object collection (more than 32 keys, e.g. `byId`) that is the same object as last time takes `objectLeaf`'s fastest path. Only the 8 sampled keys and the key count and last key are checked. So replacing the value of an existing, non-sampled key in place, as in `s.set(v => { v.byId.k17 = newItem; return v; })` with the same `byId` object, can go unrecorded: no version bump, no `state` event, and no protection for a held write. Found by code reading; no test covers it.
- History values are shallow. Array and collection leaves hold shallow copies, so element objects are shared with live state. Patches and reverts restore those references, which assumes immutable updates.
- Reordering the keys of a collection (more than 32 keys) changes its hash and is recorded as a change with delta `c:`.
- A guard or adapter store without `subscribe` records nothing when it changes outside GenClass. The next GenClass-mediated write then diffs against stale leaves and is credited with those external changes.

**Snapshots and consistency:**
- **A snapshot is "consistent" when nothing *newly* broke, not when everything holds.** A violation that lingers from the previous settled point does not block snapshots (`review-precision.test.ts` "design risk"). An ignored inconsistency therefore becomes part of later "consistent" snapshots. CONTRACT §4 says "all learned invariants held".
- **Inconsistency rollback restores whole stores.** Every field of each involved store goes back to the snapshot, including unrelated user input written since. Chain revert (error/transition) is field-precise.
- **Possible stale snapshot for a store whose top-level value is a plain object with more than 32 keys.** That store is a single leaf at path `<store>`, so `snapshot()` derives `changedKeys = {""}` and reuses the previous clone for every existing top-level key even when its value changed. Found by code reading; no test covers it.
- `settled()` does not run while any write is pending or any op younger than 10 s is in flight. Apps with constant traffic (polling every few seconds, long-poll requests under 10 s) may rarely reach settled points, so invariants learn slowly.
- Developer `expect()` violations have `fields: []`, so they contribute no store: when they are the only violations in the trigger, neither `rollback` nor `resync` is offered and only `ignore` remains.
- **Clones are not always faithful.** `cloneValue` (snapshots, rollback values, detached previews, defer re-runs) tries `structuredClone` first. That turns class instances into plain objects (their prototype is lost), so a `rollback` writes plain objects back into a store that held class instances. Values containing functions, such as Zustand state with actions, make `structuredClone` throw, and the manual fallback then keeps functions and class instances by reference and stops copying below depth 32. Found by code reading.

**Performance (budgets asserted in `test/review-perf.test.ts`; numbers measured on the shared VM, from `packages/runtime/STATUS.md`):**

| scenario | budget (test) | measured |
|---|---|---|
| user-sync write (keystroke) on an atom holding a 5,000-item array | < 1 ms/write | 0.14 ms |
| async gated write (facts computed) on the same store | < 2 ms/write | 0.19 ms |
| redux-style `adapter.propose` on 5,000 normalized entities (user / async) | < 1 ms / < 2 ms | 0.68 ms / 0.58 ms |
| settled point, 5,000-item atom changed / plus an unchanged 5,000-item adapter store | < 16 ms each | 0.2 ms / +1.4 ms |

Fixtures: `shop(5000)` is `{ items: 5,000 × { id, sku, name, price, qty, stock, rating, weight }, filter, page, pageSize, total, selected, cartCount, cartTotal, maxPrice, minPrice, version }`, and each write replaces `filter` immutably. `entities(5000)` is `{ entities: { byId: 5,000 entries }, ui: { query } }`, so `byId` is a single collection field. The settled-point case first runs 6 learning writes, then times 10 iterations of `set` + `rt.settled()`. All cases use `setup()` from `test/helpers.ts` with `FakeClock`; the measured values are logged with a `[review]` prefix.

These numbers depend on reference-equality fast paths (`arrayLeaf`/`objectLeaf` returning the previous `Leaf`), the `WeakMap` statistics cache in the miner, and snapshot reuse (`snapCache` by version and reference). If you add per-write work that is O(n) in a store's size, such as hashing, cloning or `JSON.stringify`, these budgets break.

**Determinism and parity:**
- Only the injected `Clock` is used (`this.clock.now()`), ids come from counters (`mid`, `seq`), and hashes are FNV-1a. There is no `Math.random`, `Date.now` or global `setTimeout` (CONTRACT §0 rule 3).
- The sim drives the real runtime through `rt.atom` (`sim/src/run/runner.ts`). Field paths, versions, deltas and `changeText` output appear verbatim in situation text. Any change to `fields.ts` or the version bookkeeping changes training data. Coordinate with the lead: a new freeze tag, and a data/sim regeneration. See [../model-io-contract.md](../model-io-contract.md) and [../sim.md](../sim.md).

**Adapters:**
- Zustand and Redux capture `runtime` when the store is created. `genclass(GenClass.runtime, …)` evaluated before `GenClass.init()` gets `null`, and that store is never guarded. React hooks resolve the runtime at render time.
- `useAtom(guardAtom)` requires `io.get()` to return a stable reference between changes, as `useSyncExternalStore` does.
- The Zustand commit always calls the outer `set` with `replace = true`, so outer middleware (devtools) sees replace writes.
- A Redux reducer that throws during the preview throws from `dispatch` before anything is proposed.
- `useGenClassState(name)` with a `name` already used by a Redux/Zustand/guard store silently re-registers that name as an atom (`rt.atom` -> `register` replaces). The library store then loses its GenClass subscription. Use distinct names per runtime.

## How to change it safely

The team runs builds and tests on the VM, not on the Mac (CONTRACT §0 rule 5). Under the 2026-10-07 run policy in AGENTS.md, agents on other machines may run the build and these unit tests locally ([build-test-release.md](build-test-release.md#where-to-run-things)). From `packages/runtime`, the relevant suite is `vitest run test/atoms.test.ts test/review-hub.test.ts test/invariants.test.ts test/adapter-seam.test.ts test/adapters-react.test.ts test/adapters-redux.test.ts test/adapters-zustand.test.ts test/review-perf.test.ts test/review-precision.test.ts test/situation.test.ts test/batch3.test.ts`, then the full `vitest run --exclude "test/browser/**"`. Do not edit `test/review-*.test.ts` to make it pass: `packages/runtime/STATUS.md` records that every review test passes unmodified, so treat them as required behaviour.

1. **Integrate another state library (MobX, Jotai, Valtio, …):**
   1. Add `src/adapters/<lib>.ts`. Call `runtime.adapter(name, { get, set?, subscribe? }, opts)` once per store.
   2. Route every app write through `handle.propose({ fn | value, commit })`. `commit(next)` must perform the write on the library store synchronously; it is called later for held writes and never for discarded ones.
   3. Provide `set` if GenClass may write whole states (rollback, revert); without it the store is not writable.
   4. Add tsup entries in `tsup.config.ts` (`entry` and `dts.entry`), the `exports` subpath and an optional peer dependency in `packages/runtime/package.json`, and add the library to `external`.
   5. Write tests modelled on `test/adapters-zustand.test.ts`: `MockRuntime` (`holdWrites`, `flushHeld`, `dropHeld`, `genclassWrite`) plus one test against the real runtime with `ManualDecider`.
2. **Add an invariant template:**
   1. Extend `Tpl`.
   2. Implement it in `holds` (return null when not applicable), `nonTrivial`, `valuesText` and `propose`, with a deterministic `id` and readable `text`. The text is model-visible.
   3. Compute per-array work at most once per array version: put it in `ArrayStats` (cached per `Leaf` in `statsCache`), as `sums`, `prods`, `sets` and `unique` do.
   4. Add a learning test and a precision test (no false inconsistency on benign behaviour) to `test/invariants.test.ts` / `test/review-precision.test.ts`.
   5. This changes situations, so it needs a new freeze tag and regenerated data.
3. **Change flattening caps or hashing** (`MAX_DEPTH`, `MAX_KEYS_EXPAND`, `MAX_FIELDS_PER_STORE`, `SAMPLES`, `primHash`): re-run `review-perf` and the "large arrays" test, and check the state lines in `test/batch3.test.ts` / `test/situation.test.ts`. This is parity-affecting.
4. **Change patch semantics** (`patchValue`): keep "removals first; never remove a path with a set beneath it". Run `review-hub.test.ts` (fill an empty object while held / queued / late-reverted / undone) and `atoms.test.ts` "held value writes are re-applied as patches".
5. **Fix the user-write ordering risk** (`demos/NEEDS.md` §1): in `StoreHub.propose`, when a bypass write targets a store whose `queue` is non-empty, either apply the pending writes first in proposal order, or mark the overlapping held writes superseded and re-gate them. Add the regression test that demos suggests: hold a functional write to `s.x`, make a user-sync write to `s.x`, release with `apply`, and expect the user's value. Then update `atoms.test.ts` "functional updates re-run…", which asserts the old order.
6. **Reject or support dotted store names:** either validate in `RuntimeImpl.atom`/`guard`/`adapter` (throwing would break apps, so prefer a console warning plus a sanitised name), or stop deriving the store from `path.split(".")[0]`. That would mean passing the store explicitly to `field`, `leaf`, `valueAt` and so on, and using `path.slice(store.length + 1)` in `patchValue`/`restoreInPlace`/`snapshot`. Fix the README and `react.ts` header examples as well.
7. **Change bypass, hold or late-revert rules** (`propose` `bypass`, `LATE_REVERT_MS`, `StoreHub.revertable`): these are policy-visible. Update `docs/runtime/API.md` "State", run `atoms.test.ts`, `policy.test.ts`, `review-hub.test.ts` and `batch3.test.ts` ("a provider that never answers…"), and coordinate with [decide-policy-actions.md](decide-policy-actions.md).
8. **Change what a settled point does** (`RuntimeImpl.settled`, snapshot policy): run `invariants.test.ts`, `review-precision.test.ts`, `learn.test.ts` (transition rollback) and `review-actions.test.ts`.
9. **Change an existing adapter** (`adapters/react.ts`, `redux.ts`, `zustand.ts`). Keep these contracts, which the adapter tests assert:
   - `commit` runs exactly once when a write applies and never for a discarded write.
   - Redux: the reducer runs once per applied dispatch (the `ready` handoff), and inner enhancers see the original action. Zustand: the commit is a whole-state `replace = true` write that forwards the extra `set()` arguments.
   - React: one atom per (runtime, name), and the hooks fall back to plain `useState` without a runtime.
   - Run the adapter test files plus `adapter-seam.test.ts` and `review-perf.test.ts`.
   - Update API.md "Adapters and devtools" and the header comment of the adapter file.
   - The demos exercise each adapter: `demos/src/demos/editor/main.ts` (Redux), `demos/src/demos/board/store.ts` (Zustand), `demos/src/demos/checkout/app.tsx` (React). Check them on the VM; see [../demos.md](../demos.md).

## Tests

All paths are under `packages/runtime/test/`. Helpers: `helpers.ts` (`setup`, `ManualDecider`, `ScriptedDecider`, `defaultScript`, `FakeClock`, `FakeServer`) and `browser/ui/mock-runtime.ts` (`MockRuntime`, a scripted stand-in used by the adapter unit tests).

| test file | what it asserts (store scope) |
|---|---|
| `atoms.test.ts` | user-sync writes never held; async writes held then applied; fail-open after `holdBudgetMs` plus late revert and its undo; no late revert when superseded, older than 2 s, or the same chain wrote again (subscriber-derived write); late defer/apply only recorded; provider errors fail open at once; proposal order per store; functional re-run on the current value; value writes patched over newer user input; discard drops without notification and undo applies; defer at most twice; `hold: false`; `guard()` writes through `io.set` and records external changes; `atom()` with an existing name; field versions, writers and history deltas |
| `review-hub.test.ts` | patching fills of empty objects while held/queued; undo of a late revert; in-place push summaries ("2 → 3 items"); a held in-place updater is invisible before apply and really dropped on discard; versions counted past the 16-entry history (512 log); a 2,000-item array change recorded once; a throwing setter does not strand later writes or settled points |
| `invariants.test.ts` | learns `count == len(items)`, `total == sum(price*qty)`, `count == badge`, `items[*].id unique` after 3 settled changes; violation values text; nothing learned from unchanged fields; id-like keys skipped; inconsistency raised once per episode, rollback to the snapshot and its undo; transient between-write states ignored; `expect()` checked from the start |
| `adapter-seam.test.ts` | `runtime.adapter`: reducer preview, async writes held, commit through the library; discarded writes never committed; direct library changes recorded and never held; rollback offered only when `set` exists |
| `adapters-react.test.ts` (happy-dom) | one shared atom per name; held writes visible only on apply, never on drop; StrictMode (one atom, balanced subscriptions); plain `useState` fallback without a runtime; `useAtom`; `useGenClass` throws without a runtime; live decision/intervention/status feeds with stable snapshots; real runtime: hold, discard, undo; user-handler writes never held |
| `adapters-redux.test.ts` | pass-through when nothing is held (reducer runs once); held dispatch applied once (reducer not re-run, subscribers notified once); re-run on moved state; discard reaches no reducer or subscriber; middleware sees each action once and thunks pass; no-op dispatch; `replaceReducer`; inner enhancers see the real action, GenClass writes as REPLACE; no runtime = unchanged store; real runtime hold/discard/undo |
| `adapters-zustand.test.ts` | merge semantics and `setState` through the pipeline; held writes merged over newer state; drops; replace, functional, no-op, extra `set()` args (`[value, true, "counter/set"]`); GenClass whole-state writes; no runtime = unchanged; real runtime hold/discard |
| `review-perf.test.ts` | the 5,000-item budgets in the performance table |
| `review-precision.test.ts` | closing a selection (null) is not an inconsistency (`!= null` needs 6); lingering violations do not freeze snapshots; transition-profile precision |
| `situation.test.ts` | mutation and inconsistency situations end to end (fact wording, `["ignore","rollback"]` offered) |
| `batch3.test.ts` | state lines never print `parent = undefined`; item-change summaries; "changed twice … and is back to 6"; pending-local-change fact; a provider that never answers does not block later decisions (held write plus a write queued behind it both apply; the runtime abandons the first request after budget + 2 s) |
| `review-actions.test.ts` | error-trigger rollback offered only when the failing chain wrote state; never reverts other chains' writes |
| `learn.test.ts` | transition trigger at a settled point; chain-revert rollback text "Restored list.items to their values before …" |
| `policy.test.ts` | observe mode never holds; `pause()`/`resume()` gating; loading model fails open with no decision |
| `smoke.test.ts` | atoms apply synchronously when nothing is salient; causality user -> fetch -> json -> set; stale write discarded in guard mode |
| `review-redaction.test.ts` | the custom `redact` applies to learned-invariant facts |
| `review-timers.test.ts` | a state write after a 200,000-tick timer loop does not throw |
| `context.test.ts` | writer attribution of state writes: after fetch -> json -> `set`, the `state` event's `op` is the fetch op, whose cause and root are the user action; two concurrent click -> fetch -> `set` chains writing two atoms keep their own writers and roots |
| `dom.test.ts` | writes made by the app's click handler are user writes and are never held |
| `devtools-runtime.test.ts` | the devtools Interventions tab's undo button applies a write GenClass dropped (`search.results` goes from 4 to 8 items) |

## Drift and open issues

Doc-versus-code mismatches (the code is right):

| what | doc says | code says | evidence |
|---|---|---|---|
| Who records snapshots and when | CONTRACT §4: "the hub records a snapshot of all stores" at settled points; `lastConsistent` is "the last snapshot at which all learned invariants held" | `RuntimeImpl.settled` (not the hub) records a snapshot whenever no violation is *newly* broken; lingering violations do not block it; at most 8 are kept | `runtime.ts` -> `settled`; `review-precision.test.ts` "design risk" |
| Settled-point condition | CONTRACT §4 "no in-flight ops"; API.md "no requests in flight" | no op of any kind started less than 10 s ago in flight, **and** no pending (held or queued) write | `runtime.ts` -> `busy` |
| `a != null` support | CONTRACT §4: every candidate is learned after ≥ 3 settled snapshots | `nonnull` needs `LEARN_AFTER_NONNULL` = 6, and is never proposed for a field ever seen null | `invariants.ts` |
| Who raises `inconsistency` | CONTRACT §4: "the hub raises" it | `RuntimeImpl.settled` -> `raiseInconsistency` | `runtime.ts` |
| Field model | CONTRACT §4: arrays are one field; per-field `{ v, writer, t }` | arrays **and** plain objects with more than 32 keys are one field; at most 4 key levels and a soft cap of 200 fields per store; `FieldState` also has `seq`, a 16-entry `hist` and a 512-entry `log` | `fields.ts` -> `flatten`; `hub.ts` |
| `Mutation` shape | CONTRACT §4 `{ id, store, changes, cause, root, t }` | `MutationRec` has many more fields (see the table above) | `hub.ts` |
| `rollback` effect | CONTRACT §7: "write snapshot back" for every trigger | snapshot rollback only for `inconsistency`; `error`/`transition` use a field-precise chain revert | `runtime.ts` -> `revertChain`; API.md and STATUS.md agree with the code |
| `Runtime.adapter` | CONTRACT §2's `Runtime` interface lists only `atom`, `guard`, `expect` | `adapter()` is public (`types.ts` `Runtime.adapter`); API.md documents it | `types.ts` |
| `holdBudgetMs` default | CONTRACT §8: 300 | `"auto"` (150 to 800 ms; 300 only when nothing is known) | `decide/policy.ts` -> `holdBudget` |
| "could not be held" fact | STATUS.md: when an in-place update cannot be detached, "the write applies at once with a fact" | such a write is committed in `propose` without being gated, so `mutationFacts`' `m.unholdable` fact is never produced | `hub.ts` -> `propose`; `situation/facts.ts` |
| Example store names | README "State it can protect" and `react.ts` header: `useGenClassState("search.results", [])`; `test/smoke/smoke.sh`: `rt.atom("search.results", [])` | dotted names break path-to-store lookups (see Gotchas) | `hub.ts` -> `field`/`leaf`; `situation/build.ts` -> `stateLines` |
| UI-NEEDS item 2 | `packages/runtime/UI-NEEDS.md` asks for `react-dom` / `@types/react-dom` as devDependencies | both are already in `packages/runtime/package.json` devDependencies (stale request) | `package.json` |
| Adapter signatures | API.md "Adapters and devtools": `genclassEnhancer(runtime, { name })`, `genclass(runtime, name)(stateCreator)` | both also take `StoreOptions` (`resync`, `hold`, `describe`): Redux through `GenclassEnhancerOptions<S> extends StoreOptions<S>`, Zustand through a third `opts` parameter. This is an omission, not a contradiction | `adapters/redux.ts`, `adapters/zustand.ts` |
| `mutationProposed` coverage | `types.ts` `RuntimeHooks.mutationProposed`: "Called synchronously inside atom.set / guarded set / adapter writes, before gating" | not called for writes after `destroy()` (they go straight to `hub.write`) or for a deferred write's re-proposal | `runtime.ts` -> `handle`, `adapter`; `hub.ts` -> `defer` |
| `MAX_FIELDS_PER_STORE` | the constant's name reads as a hard per-store limit | a per-object pre-check; a store can exceed 200 fields | `fields.ts` -> `flatten` |
| Code comments in scope | `fields.ts` `FieldChange.delta` comment gives the example `"n:+1"`; `hub.ts` `RecentChange.key` comment says "Hash of paths + deltas"; `situation/env.ts` `SitEnv.lastConsistent` says "Last snapshot at which all learned invariants held" | `deltaOf` emits `n:1` (no `+` sign; `Number(d.toPrecision(12))`); `key` is the plain string `paths\|path=delta;…`, not a hash; `lastConsistent` is the newest snapshot at which nothing *newly* broke | `fields.ts` -> `deltaOf`; `hub.ts` -> `record`; `runtime.ts` -> `settled`, `makeEnv` |

Open issues relevant to this scope:
- **User writes overtaken by held writes** (`demos/NEEDS.md` §1, CORE, product risk): +56% visible jump-backs on the board demo in guard mode with zero actions executed. The proposed fix is in recipe 5. Still open at 654d822; the code is unchanged since `situation-v1`.
- **Hold latency** (`demos/NEEDS.md` §2): typeahead result writes are salient on clean runs (127 of 148 held, median 543 ms). Suggestions there: do not hold when recent decision latency exceeds the budget; drop superseded queued decisions. This belongs to the policy and decider side; see [decide-policy-actions.md](decide-policy-actions.md).
- **App-level snapshots miss held writes** (`demos/NEEDS.md` §1): the board demo's own whole-board rollback on a failed move (`demos/src/demos/board/main.ts`, `set({ cards: before })`) captures `before` while GenClass is holding writes, so restoring it erases more (cards stuck "syncing": 6 Off, 9 Guard, 10 Heal). This is the app's rollback, not GenClass's `rollback` action (Guard executed 0 actions in those runs), but it is another consequence of holding.
- Unverified-by-test findings above: the unreachable `too late to revert` branch, dotted store names, the stale snapshot of a top-level store with more than 32 keys, value writes of mutated-in-place objects, in-place value replacement in a large collection, library listeners throwing during commit, `structuredClone` prototype loss, and the unused `StoreHub.mutations` map.
- Dead or unused code paths:
  - `RuntimeImpl.rollback(stores, violationIds, beforeSeq?)`: no caller passes `beforeSeq`, so inconsistency rollback always uses the newest snapshot. `snapshotBefore` is used only for `SitEnv.consistentBefore` (facts).
  - `StoreHub.revertable`'s `the write changed nothing` is unreachable: `appliedSeq` is set only when a write changed something, and the earlier `the write was not applied` check already catches the other case.
  - The mutation controller's `too late to revert` branch is effectively unreachable: the decision deadline (`t0 + budget + LATE_REVERT_MS`) passes before any held write can be more than 2 s past its apply (see flow 7).
  - `RuntimeImpl.onApplied` takes `m` but ignores it (`void m`).
- `OPEN_TASKS.md` lists the runtime as frozen at `situation-v1`. Changes here affect the final data and training plan, so check with the lead first.

## Related docs

- [public-api-and-lifecycle.md](public-api-and-lifecycle.md): `GenClass.init`, `createRuntime`, options, pause/destroy.
- [observe-and-trace.md](observe-and-trace.md): ops, the ambient op, `Context.isUserSync`, causality.
- [learn-situation-triage.md](learn-situation-triage.md): mutation and inconsistency facts, triage, state lines, transition profiles.
- [decide-policy-actions.md](decide-policy-actions.md): the trigger/decision flow, policy gate, hold budget, actions, undo, reports.
- [devtools.md](devtools.md): the overlay (it uses the public API and the React feeds' sources).
- [build-test-release.md](build-test-release.md): the VM, vitest and the npm subpath exports.
- [../overview.md](../overview.md#4-walkthrough-a-typeahead-stale-write): a held mutation end to end
- [../glossary.md](../glossary.md)
- [../model-io-contract.md](../model-io-contract.md), [../sim.md](../sim.md), [../demos.md](../demos.md), [../status-and-known-issues.md](../status-and-known-issues.md).
- Existing specs: [../../runtime/CONTRACT.md](../../runtime/CONTRACT.md) (§4 State, §7 actions), [../../runtime/API.md](../../runtime/API.md) ("State", "Adapters and devtools"), [../../runtime/ARCHITECTURE.md](../../runtime/ARCHITECTURE.md); [../../../packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md); [../../../demos/NEEDS.md](../../../demos/NEEDS.md).
