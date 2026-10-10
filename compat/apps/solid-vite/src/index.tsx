import "@genclass/runtime/auto"; // GenClass, first line of the entry (observe by default), as `npx @genclass/runtime init` writes it
import { render } from "solid-js/web";
import App from "./App";

render(() => <App />, document.getElementById("root")!);
