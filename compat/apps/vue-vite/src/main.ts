import "@genclass/runtime/auto"; // GenClass, first line of the entry (observe by default), as `npx @genclass/runtime init` writes it
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).use(createPinia()).mount("#app");
