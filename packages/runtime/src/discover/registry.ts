// Where the runtime finds the state-discovery installers (InitOptions.autoState). Kept apart from the installers so
// the main entry (`GenClass.init`) does not carry them: `@genclass/runtime/auto`, the script tag and
// `@genclass/runtime/discover` register them (src/discover/index.ts) when they are evaluated.

import type { ReactDiscovery } from "./react.js";
import type { ReduxDiscovery, ReduxDiscoveryHost } from "./redux.js";
import type { DiscoveryHost } from "./types.js";

export interface DiscoveryInstallers {
  react(host: DiscoveryHost): ReactDiscovery | null;
  redux(host: ReduxDiscoveryHost, o: { redux: boolean; connect: boolean }): ReduxDiscovery | null;
}

export const discoveryRegistry: { installers: DiscoveryInstallers | null } = { installers: null };
