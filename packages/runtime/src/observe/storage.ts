// Storage observer: localStorage/sessionStorage setItem/removeItem/clear become `storage` events. Storage objects
// have a named-property setter (assigning a property stores an item), so the methods are wrapped on the
// prototype and the area is identified by comparing `this`.

type Cb = (area: string, op: string, key: string) => void;

export function installStorage(g: Record<string, unknown>, cb: Cb): (() => void) | null {
  const S = g.Storage as { prototype: Storage } | undefined;
  if (!S || !S.prototype) return null;
  const P = S.prototype;
  const area = (s: Storage): string => {
    try {
      if (s === (g.localStorage as Storage | undefined)) return "localStorage";
      if (s === (g.sessionStorage as Storage | undefined)) return "sessionStorage";
    } catch {
      /* access denied */
    }
    return "storage";
  };
  const set = P.setItem;
  const remove = P.removeItem;
  const clear = P.clear;
  const wSet = function (this: Storage, k: string, v: string) {
    const r = set.call(this, k, v);
    try {
      cb(area(this), "setItem", String(k));
    } catch {
      /* ignore */
    }
    return r;
  };
  const wRemove = function (this: Storage, k: string) {
    const r = remove.call(this, k);
    try {
      cb(area(this), "removeItem", String(k));
    } catch {
      /* ignore */
    }
    return r;
  };
  const wClear = function (this: Storage) {
    const r = clear.call(this);
    try {
      cb(area(this), "clear", "");
    } catch {
      /* ignore */
    }
    return r;
  };
  try {
    P.setItem = wSet;
    P.removeItem = wRemove;
    P.clear = wClear;
  } catch {
    return null;
  }
  return () => {
    if (P.setItem === wSet) P.setItem = set;
    if (P.removeItem === wRemove) P.removeItem = remove;
    if (P.clear === wClear) P.clear = clear;
  };
}
