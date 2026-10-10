// Loads a fresh react / react-dom (development or production build) after the runtime installed its DevTools hook,
// as on a page where GenClass's one line comes first. Node's require cache is cleared for React's packages so every
// test gets a renderer that injects again.
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

export interface ReactMods {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
}

export function loadReact(prod: boolean): ReactMods {
  for (const k of Object.keys(req.cache)) if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(k)) delete req.cache[k];
  const env = process.env.NODE_ENV;
  if (prod) process.env.NODE_ENV = "production";
  try {
    return { React: req("react"), client: req("react-dom/client") };
  } finally {
    process.env.NODE_ENV = env;
  }
}
