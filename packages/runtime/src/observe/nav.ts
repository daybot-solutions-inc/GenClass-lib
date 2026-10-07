// Navigation observer: history.pushState/replaceState, popstate and hashchange become `nav` events.

import { truncate } from "../util.js";

export function installNav(g: Record<string, unknown>, _rt: unknown, onNav: (route: string) => void): (() => void) | null {
  const hist = g.history as History | undefined;
  const loc = g.location as Location | undefined;
  const t = g as unknown as EventTarget;
  if (!hist || !loc || typeof t.addEventListener !== "function") return null;
  const route = () => truncate(`${loc.pathname ?? ""}${loc.search ?? ""}${loc.hash ?? ""}`, 80);
  const push = hist.pushState;
  const replace = hist.replaceState;
  let disabled = false;
  const wrap = (orig: History["pushState"]) =>
    function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      if (disabled) return r;
      try {
        onNav(route());
      } catch {
        /* ignore */
      }
      return r;
    };
  const wp = typeof push === "function" ? wrap(push) : undefined;
  const wr = typeof replace === "function" ? wrap(replace) : undefined;
  try {
    if (wp) hist.pushState = wp;
    if (wr) hist.replaceState = wr;
  } catch {
    /* non-writable */
  }
  const onPop = () => onNav(route());
  t.addEventListener("popstate", onPop);
  t.addEventListener("hashchange", onPop);
  return () => {
    disabled = true;
    try {
      if (wp && hist.pushState === wp) hist.pushState = push;
      if (wr && hist.replaceState === wr) hist.replaceState = replace;
    } catch {
      /* ignore */
    }
    t.removeEventListener("popstate", onPop);
    t.removeEventListener("hashchange", onPop);
  };
}
