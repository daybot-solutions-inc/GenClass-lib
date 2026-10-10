// Where the runtime finds the state-discovery installers (InitOptions.autoState). Kept apart from the installers so
// the main entry (`GenClass.init`) does not carry them: `@genclass/runtime/auto`, the script tag and
// `@genclass/runtime/discover` register them (src/discover/index.ts, src/discover/entry.ts).

import type { ReactDiscovery } from "./react.js";
import type { ReduxDiscovery, ReduxDiscoveryHost } from "./redux.js";
import type { DiscoveryHost } from "./types.js";

export interface DiscoveryInstallers {
  react(host: DiscoveryHost): ReactDiscovery | null;
  redux(host: ReduxDiscoveryHost, o: { redux: boolean; connect: boolean }): ReduxDiscovery | null;
}

/** A host that forwards to the runtime attached to it (none: nothing is recorded, everything passes through). */
export interface SwitchHost extends ReduxDiscoveryHost {
  readonly attached: boolean;
  attach(h: ReduxDiscoveryHost): void;
  detach(h: ReduxDiscoveryHost): void;
}

/** Discovery installed when `@genclass/runtime/discover` was evaluated, before any runtime existed. */
export interface EarlyDiscovery {
  host: SwitchHost;
  react: ReactDiscovery | null;
  redux: ReduxDiscovery | null;
}

export const discoveryRegistry: { installers: DiscoveryInstallers | null; early: EarlyDiscovery | null } = { installers: null, early: null };
