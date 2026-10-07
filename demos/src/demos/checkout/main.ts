import { bootDemo } from "../../site/demo-page.ts";
import { highlight } from "../../site/highlight.ts";
import { mountCheckout } from "./app.tsx";
import { checkoutOracle } from "./oracle.ts";
import { checkoutScenario } from "./scenario.ts";

bootDemo({
  id: "checkout",
  host: "fieldsupply.example/cart",
  mount: mountCheckout,
  scenario: checkoutScenario,
  oracle: checkoutOracle,
  loaded: "loaded",
  settle: { idleMs: 900, timeoutMs: 25000 },
  code: highlight(`GenClass.init();

function Store() {
  // resync: an app capability ("reload the cart")
  const [cart, setCart] = useGenClassState("cart", EMPTY,
    { resync: () => reloadCart() });

  async function placeOrder() {   // button stays enabled
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchWithTimeout("/api/orders",
          { method: "POST", body }, 5000);
        ...
      } catch { await sleep(600 * attempt); }  // retry
    }
  }
}`),
});
