// Public status page for a cloud provider (jQuery 3 + $.ajax over XMLHttpRequest, no state library: the DOM is
// the state). Observe-only integration. Latent bugs by flag: overlapping polls whose responses land out of order
// (overlap=overlap), retrying failed polls immediately in a tight loop (onError=tight-loop), incident details
// rendered in arrival order (detailGuard=none), and a subscribe form that stays enabled while posting
// (subscribeDisable=false).
import $ from "jquery";
import { flag } from "../_shared/genclass";

type Service = { id: number; name: string; group: string; status: "operational" | "degraded" | "outage" | "maintenance"; latencyMs: number; uptime: number };
type Incident = { id: number; title: string; service: string; severity: "minor" | "major" | "critical"; state: "investigating" | "identified" | "monitoring" | "resolved"; updates?: string[] };

const POLL_MS = Number(flag("pollMs", 5000));
const OVERLAP = flag("overlap", "skip") as "skip" | "overlap";
const ON_ERROR = flag("onError", "backoff") as "backoff" | "tight-loop";
const DETAIL_GUARD = flag("detailGuard", "latest") as "latest" | "none";
const SUB_DISABLE = Boolean(flag("subscribeDisable", true));

const LABEL: Record<Service["status"], string> = { operational: "Operational", degraded: "Degraded performance", outage: "Major outage", maintenance: "Under maintenance" };
const esc = (s: unknown) => $("<div>").text(String(s ?? "")).html();
const hhmm = () => {
  const d = new Date();
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
};

$("#app").html(`
  <header class="masthead"><h1>Northwind Cloud status</h1><p class="banner">Checking systems…</p></header>
  <section class="services">
    <div class="toolbar">
      <label>Show <select name="group"><option value="all">All components</option><option value="compute">Compute</option><option value="storage">Storage</option><option value="network">Network</option><option value="data">Data</option></select></label>
      <button type="button" class="refresh">Refresh</button>
      <span class="updated"></span>
    </div>
    <div class="poll-error"></div>
    <table class="svc"><thead><tr><th>Component</th><th>Status</th><th>p50 latency</th><th>90-day uptime</th></tr></thead><tbody></tbody></table>
  </section>
  <section class="incidents">
    <h2>Incidents</h2>
    <div class="tabs"><button type="button" class="tab" data-state="open">Open</button> <button type="button" class="tab" data-state="resolved">Resolved</button></div>
    <ul class="incident-list"><li class="muted">Loading incidents…</li></ul>
    <article class="incident-detail" hidden></article>
  </section>
  <section class="subscribe">
    <h2>Get notified</h2>
    <form class="sub-form"><input type="email" name="email" placeholder="you@company.com" aria-label="Email"> <button type="submit" class="sub-btn">Subscribe</button></form>
    <div class="sub-msg"></div>
  </section>`);

// --------------------------------------------------------------------------------------------- services
let inflight: JQuery.jqXHR | null = null;
let failures = 0;
let tightRetries = 0;
let backoffUntil = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function renderServices(list: Service[]) {
  const rows = list.map((s) => `<tr class="svc-row status-${s.status}"><td>${esc(s.name)}</td><td class="st">${LABEL[s.status] ?? esc(s.status)}</td><td>${s.latencyMs} ms</td><td>${Number(s.uptime).toFixed(2)}%</td></tr>`);
  $("table.svc tbody").html(rows.join("") || `<tr><td colspan="4" class="muted">No components in this group.</td></tr>`);
  const bad = list.filter((s) => s.status === "outage").length;
  const slow = list.filter((s) => s.status === "degraded").length;
  $(".banner")
    .text(bad ? `Major outage affecting ${bad} component(s)` : slow ? `Partial degradation: ${slow} component(s)` : "All systems operational")
    .toggleClass("is-bad", bad > 0);
  $(".updated").text(`Last checked ${hhmm()}`);
}

function poll(manual = false) {
  if (inflight && OVERLAP === "skip") {
    // a background tick never stacks on a running poll; an explicit refresh replaces it
    if (!manual) return;
    inflight.abort();
  }
  if (!manual && Date.now() < backoffUntil) return;
  const group = String($("select[name=group]").val() ?? "all");
  const xhr = $.ajax({ url: "/api/services", data: group === "all" ? {} : { group }, dataType: "json", timeout: 10000 });
  inflight = xhr;
  xhr
    .done((res: { data: Service[] }) => {
      failures = 0;
      tightRetries = 0;
      backoffUntil = 0;
      $(".poll-error").empty();
      renderServices(res.data ?? []);
    })
    .fail((_x, textStatus) => {
      if (textStatus === "abort") return;
      failures++;
      $(".poll-error").html(`<p role="alert">Status data is temporarily unavailable (${esc(textStatus)}). Retrying…</p>`);
      if (ON_ERROR === "tight-loop") {
        // try again right away until it works
        if (tightRetries++ < 30) setTimeout(() => poll(true), 0);
      } else {
        backoffUntil = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      }
    })
    .always(() => {
      if (inflight === xhr) inflight = null;
    });
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => poll(false), POLL_MS);
}

$(".refresh").on("click", () => {
  backoffUntil = 0;
  poll(true);
});
$("select[name=group]").on("change", () => poll(true));

// -------------------------------------------------------------------------------------------- incidents
let tab: "open" | "resolved" = "open";
let detailReq = 0;

function loadIncidents() {
  const params = tab === "resolved" ? { state: "resolved" } : {};
  $.getJSON("/api/incidents", params)
    .done((res: { data: Incident[] }) => {
      const list = (res.data ?? []).filter((i) => (tab === "resolved" ? i.state === "resolved" : i.state !== "resolved"));
      $(".incident-list").html(
        list.map((i) => `<li><a href="#incident-${i.id}" class="incident-link" data-id="${i.id}">${esc(i.title)}</a> <span class="sev sev-${i.severity}">${esc(i.severity)}</span> <span class="state">${esc(i.state)}</span></li>`).join("") ||
          `<li class="muted">${tab === "open" ? "No open incidents." : "No resolved incidents."}</li>`,
      );
    })
    .fail(() => $(".incident-list").html(`<li role="alert">Incidents could not be loaded.</li>`));
}

function openIncident(id: number) {
  const mine = ++detailReq;
  const $d = $(".incident-detail").prop("hidden", false).html(`<p class="muted">Loading incident…</p>`);
  $.ajax({ url: `/api/incidents/${id}`, dataType: "json" })
    .done((i: Incident) => {
      if (DETAIL_GUARD === "latest" && mine !== detailReq) return;
      const ups = (i.updates ?? []).map((u) => `<li>${esc(u)}</li>`).join("");
      $d.html(`<h3>${esc(i.title)}</h3><p>${esc(i.service)} · ${esc(i.severity)} · <strong>${esc(i.state)}</strong></p><ol class="updates">${ups}</ol><button type="button" class="close-detail">Close</button>`);
    })
    .fail(() => {
      if (DETAIL_GUARD === "latest" && mine !== detailReq) return;
      $d.html(`<p role="alert">This incident could not be loaded.</p><button type="button" class="close-detail">Close</button>`);
    });
}

$(".incident-list").on("click", "a.incident-link", function (e) {
  e.preventDefault();
  openIncident(Number($(this).data("id")));
});
$(".incident-detail").on("click", "button.close-detail", () => {
  detailReq++;
  $(".incident-detail").prop("hidden", true).empty();
});
$(".tabs").on("click", "button.tab", function () {
  tab = $(this).data("state") === "resolved" ? "resolved" : "open";
  $(".tabs .tab").removeClass("active");
  $(this).addClass("active");
  loadIncidents();
});

// -------------------------------------------------------------------------------------------- subscribe
let subscribing = false;
$(".sub-form").on("submit", function (e) {
  e.preventDefault();
  const email = String($(this).find("input[name=email]").val() ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    $(".sub-msg").html(`<p role="alert">Please enter a valid email address.</p>`);
    return;
  }
  if (SUB_DISABLE && subscribing) return;
  subscribing = true;
  if (SUB_DISABLE) $(".sub-btn").prop("disabled", true).text("Subscribing…");
  $.ajax({ url: "/api/subscribers", method: "POST", contentType: "application/json", data: JSON.stringify({ email, channel: "email" }), dataType: "json" })
    .done(() => {
      $(".sub-msg").html(`<p class="ok">Subscribed ${esc(email)} to incident updates.</p>`);
      $(this).find("input[name=email]").val("");
    })
    .fail((x) => $(".sub-msg").html(`<p role="alert">Subscription failed (${x.status || "network error"}). Please try again.</p>`))
    .always(() => {
      subscribing = false;
      $(".sub-btn").prop("disabled", false).text("Subscribe");
    });
});

$(() => {
  poll(true);
  loadIncidents();
  startPolling();
});
