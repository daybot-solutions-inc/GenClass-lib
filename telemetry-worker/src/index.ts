// Worker entry point. Only the default export lives here: the Workers runtime treats every named export of the main
// module as an entrypoint, so the collector and dashboard code (and their constants) live in collector.ts.
import { handle, reply, type Env } from "./collector.js";
import { retention } from "./dashboard.js";

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // Unserved genclass.dev paths go to the site worker through a service binding (a plain fetch() from a route to a
    // custom-domain origin fails with 522).
    const site = env.SITE;
    const passthrough = site ? (r: Request) => site.fetch(r) : undefined;
    return handle(request, env, { waitUntil: (p) => ctx.waitUntil(p), passthrough }).catch(() =>
      reply(500, { ok: false, error: "internal error" }),
    );
  },
  /** Daily cron: delete dashboard rows past retention (R2 has its own 90-day lifecycle rule). */
  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    if (env.DB) ctx.waitUntil(retention(env.DB, new Date()));
  },
};
