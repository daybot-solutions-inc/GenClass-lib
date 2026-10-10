// GenClass goes first, before Vue, so it is installed before your app and its requests start.
// "@genclass/runtime/auto" observes (reports what it sees, never changes anything). To let it act, switch to
// "@genclass/runtime/auto/guard". Add ?genclass=off to the URL to turn it off for a page load.
import genclass from "@genclass/runtime/auto";
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");

// The devtools overlay, in development only (not in your production bundle).
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
