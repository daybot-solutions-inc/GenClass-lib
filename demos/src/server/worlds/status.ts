import type { World, WorldDef } from "../core.ts";
import { now } from "../core.ts";

export type Health = "operational" | "degraded" | "down";

export interface Incident {
  svc: string;
  status: Exclude<Health, "operational">;
  /** Epoch ms. */
  from: number;
  to: number;
}

export const SERVICES: { id: string; name: string; region: string }[] = [
  { id: "api", name: "API Gateway", region: "us-east-1" },
  { id: "auth", name: "Auth", region: "us-east-1" },
  { id: "payments", name: "Payments", region: "eu-west-1" },
  { id: "search", name: "Search", region: "us-west-2" },
  { id: "notify", name: "Notifications", region: "eu-central-1" },
  { id: "cdn", name: "CDN", region: "global" },
];

interface StatusState {
  incidents: Incident[];
  polls: Record<string, number>;
}

/** The true health of a service at an instant (shared with the oracle). */
export function truthAt(incidents: Incident[], svc: string, t: number): Health {
  let h: Health = "operational";
  for (const i of incidents) {
    if (i.svc === svc && t >= i.from && t < i.to) {
      if (i.status === "down") return "down";
      h = "degraded";
    }
  }
  return h;
}

function scheduleRandomIncidents(w: World<StatusState>) {
  const next = () => {
    const svc = w.scriptRng.pick(SERVICES).id;
    const status = w.scriptRng.chance(0.35) ? "down" : "degraded";
    const from = now();
    const dur = w.scriptRng.range(8000, 20000);
    w.state.incidents.push({ svc, status, from, to: from + dur });
    w.script(w.scriptRng.range(20000, 45000), next);
  };
  w.script(w.scriptRng.range(6000, 15000), next);
}

export const statusWorld: WorldDef<StatusState> = {
  demo: "status",
  create: () => ({ incidents: [], polls: {} }),
  start: (w) => {
    const scripted = w.params.incidents as { svc: string; status: Incident["status"]; at: number; dur: number }[] | undefined;
    if (Array.isArray(scripted)) {
      for (const i of scripted) w.state.incidents.push({ svc: i.svc, status: i.status, from: w.created + i.at, to: w.created + i.at + i.dur });
    } else if (w.params.randomIncidents !== false) {
      scheduleRandomIncidents(w);
    }
  },
  action: (w, name, args) => {
    if (name === "incident") {
      const a = args as { svc: string; status: Incident["status"]; dur: number };
      const from = now();
      w.state.incidents.push({ svc: a.svc, status: a.status, from, to: from + a.dur });
      return true;
    }
    if (name === "resolveAll") {
      const t = now();
      for (const i of w.state.incidents) if (i.to > t) i.to = t;
      return true;
    }
    return undefined;
  },
  routes: [
    {
      method: "GET",
      pattern: /^\/status\/([\w-]+)$/,
      key: (m) => `status/${m[1]}`,
      handle: (w, req) => {
        const svc = SERVICES.find((s) => s.id === req.params[0]);
        if (!svc) return { status: 404, json: { error: "Unknown service" } };
        const t = now();
        const status = truthAt(w.state.incidents, svc.id, t);
        w.state.polls[svc.id] = (w.state.polls[svc.id] ?? 0) + 1;
        const latencyMs =
          status === "operational" ? Math.round(w.rng.range(35, 95)) : status === "degraded" ? Math.round(w.rng.range(400, 1200)) : null;
        return {
          status: 200,
          json: { id: svc.id, name: svc.name, region: svc.region, status, latencyMs, checkedAt: t },
          work: 4,
        };
      },
    },
  ],
  snapshot: (w) => ({ created: w.created, incidents: w.state.incidents, polls: w.state.polls, services: SERVICES }),
};
