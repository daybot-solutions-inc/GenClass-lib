// Registers the discovery installers for tests that create runtimes themselves (what registerDiscovery() does,
// without the early install that `@genclass/runtime/discover` performs when it is evaluated).
import { installReactDiscovery } from "../src/discover/react.js";
import { installReduxDiscovery } from "../src/discover/redux.js";
import { discoveryRegistry } from "../src/discover/registry.js";

discoveryRegistry.installers = { react: installReactDiscovery, redux: installReduxDiscovery };
