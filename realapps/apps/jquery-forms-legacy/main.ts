// Organization admin console from the jQuery era (jQuery 3, $.ajax/$.getJSON with success/error option callbacks,
// form-encoded bodies, a global $.ajaxSetup error handler that retries; the DOM is the state). Observe-only
// integration. Latent bugs by flag: the global handler retries every method including non-idempotent POSTs
// (retry=all: an invite or a "+10 GB" that committed before the 5xx is sent again), submit buttons that stay enabled
// (disableOnSubmit=false: Enter plus click sends the invite twice), the member table refresh that redraws rows the
// admin is still editing (refreshKeepsEdits=false), team quota loads applied out of order (teamGuard=none: the
// previous team's quota lands in the field) and the "+10 GB" button sent as a relative increment
// (quotaGrow=relative).
import $ from "jquery";
import { flag } from "../_shared/genclass";

const RETRY = flag("retry", "idempotent") as "idempotent" | "all" | "none";
const DISABLE_ON_SUBMIT = Boolean(flag("disableOnSubmit", true));
const KEEP_EDITS = Boolean(flag("refreshKeepsEdits", true));
const TEAM_GUARD = flag("teamGuard", "latest") as "latest" | "none";
const GROW = flag("quotaGrow", "absolute") as "absolute" | "relative";
const AUDIT_MS = Number(flag("auditPollMs", 5000));
const MEMBERS_MS = 8000;

type Member = { id: number; name: string; email: string; role: string; status: string };
type Team = { id: number; name: string; quotaGb: number; usedGb: number };
type Invite = { id: number; email: string; role: string };
type Audit = { id: number; actor: string; action: string; target: string };

const esc = (s: unknown) => $("<div>").text(String(s ?? "")).html();
const ROLES = ["viewer", "editor", "admin", "billing"];

$("#app").html(`
  <header><h1>Acme Cloud · Organization settings</h1><nav class="crumbs">Admin › Members, quotas &amp; invites</nav></header>
  <div class="flash"></div>
  <section id="members"><h2>Members</h2>
    <table class="members"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody><tr><td colspan="4">Loading…</td></tr></tbody></table>
    <button type="button" class="save-roles">Save role changes</button> <button type="button" class="reload-members">Reload</button> <span class="roles-msg"></span>
  </section>
  <section id="quotas"><h2>Storage quotas</h2>
    <form class="quota-form"><label>Team <select name="team"></select></label> <label>Quota (GB) <input name="quota" size="6"></label>
      <button type="submit" class="apply-quota">Apply</button> <button type="button" class="grow">+10 GB</button></form>
    <p class="quota-usage"></p>
  </section>
  <section id="invites"><h2>Invite a teammate</h2>
    <form class="invite-form"><input type="email" name="email" placeholder="name@company.com" aria-label="Email"> <select name="role">${ROLES.map((r) => `<option value="${r}">${r}</option>`).join("")}</select> <button type="submit" class="send-invite">Send invite</button></form>
    <div class="invite-msg"></div>
    <h3>Pending invites</h3><ul class="invite-list"><li>Loading…</li></ul>
  </section>
  <aside id="audit"><h2>Recent activity</h2><ol class="audit-list"></ol></aside>`);

// ---------------------------------------------------------------------------------------- global ajax
function flash(msg: string) {
  $(".flash").html(`<p role="alert">${esc(msg)} <button type="button" class="dismiss">Dismiss</button></p>`);
}
$(".flash").on("click", "button.dismiss", () => $(".flash").empty());

$.ajaxSetup({
  timeout: 8000,
  // legacy: every failed call goes through here; a few tries before giving up
  error(this: any, xhr: JQuery.jqXHR, textStatus: string) {
    if (textStatus === "abort") return;
    const method = String(this.type || "GET").toUpperCase();
    const retryable = textStatus === "timeout" || xhr.status === 0 || xhr.status >= 500;
    const allowed = RETRY === "all" || (RETRY === "idempotent" && ["GET", "PUT", "PATCH", "DELETE"].includes(method));
    this.tryCount = (this.tryCount ?? 0) + 1;
    if (retryable && allowed && this.tryCount <= 2) {
      const settings = this;
      setTimeout(() => $.ajax(settings), 500 * this.tryCount);
      return;
    }
    if (typeof this.onGiveUp === "function") this.onGiveUp(xhr);
    else flash(`${this.errorMessage ?? "Request failed"} (${xhr.status || textStatus}).`);
  },
} as JQuery.AjaxSettings);

// --------------------------------------------------------------------------------------------- members
let rolesSaving = 0;

function renderMembers(list: Member[]) {
  const $tb = $("table.members tbody");
  const rows = list.map((m) => {
    const $old = $tb.find(`tr[data-id=${m.id}]`);
    if (KEEP_EDITS && $old.find("select.role").hasClass("dirty")) return $old.detach();
    return $(`<tr data-id="${m.id}"><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td><select class="role">${ROLES.map((r) => `<option value="${r}"${r === m.role ? " selected" : ""}>${r}</option>`).join("")}</select></td><td>${esc(m.status)}</td></tr>`).data("saved", m.role);
  });
  $tb.empty().append(rows.length ? rows : $(`<tr><td colspan="4">No members.</td></tr>`));
}

let membersLoading = false;
function loadMembers() {
  if ((KEEP_EDITS && rolesSaving > 0) || membersLoading) return;
  membersLoading = true;
  $.ajax({
    url: "/api/members",
    dataType: "json",
    errorMessage: "Members could not be loaded",
    success: (res: { data: Member[] }) => renderMembers(res.data ?? []),
    onGiveUp: () => flash("Members could not be loaded."),
    complete: () => (membersLoading = false),
  } as JQuery.AjaxSettings);
}

$("table.members").on("change", "select.role", function () {
  const $s = $(this);
  $s.toggleClass("dirty", $s.val() !== $s.closest("tr").data("saved"));
  $(".roles-msg").text(`${$("select.role.dirty").length} unsaved change(s)`);
});

$(".save-roles").on("click", function () {
  const $dirty = $("select.role.dirty");
  if (!$dirty.length) return $(".roles-msg").text("Nothing to save.");
  const $btn = $(this);
  if (DISABLE_ON_SUBMIT) $btn.prop("disabled", true).text("Saving…");
  let ok = 0;
  let failed = 0;
  const finish = () => {
    rolesSaving = Math.max(0, rolesSaving - 1);
    if (rolesSaving > 0) return;
    $btn.prop("disabled", false).text("Save role changes");
    $(".roles-msg").text(failed ? `${failed} change(s) failed, ${ok} saved.` : `Saved ${ok} change(s).`);
  };
  $dirty.each(function () {
    const $s = $(this);
    const $tr = $s.closest("tr");
    const role = String($s.val());
    rolesSaving++;
    $.ajax({
      url: `/api/members/${$tr.data("id")}`,
      type: "PATCH",
      data: { role },
      dataType: "json",
      errorMessage: "A role change was not saved",
      success: (m: Member) => {
        ok++;
        $tr.data("saved", m.role);
        $s.removeClass("dirty");
        finish();
      },
      onGiveUp: () => {
        failed++;
        flash("A role change was not saved.");
        finish();
      },
    } as JQuery.AjaxSettings);
  });
});
$(".reload-members").on("click", () => loadMembers());

// ---------------------------------------------------------------------------------------------- quotas
let teamReq = 0;
let teams: Team[] = [];

function showTeam(t: Team) {
  $("input[name=quota]").val(String(t.quotaGb));
  $(".quota-usage").text(`${t.name}: ${t.usedGb} GB used of ${t.quotaGb} GB`);
}

function loadTeam(id: number) {
  const mine = ++teamReq;
  $(".quota-usage").text("Loading quota…");
  $.getJSON(`/api/teams/${id}`).done((t: Team) => {
    if (TEAM_GUARD === "latest" && mine !== teamReq) return;
    showTeam(t);
  });
}

$("select[name=team]").on("change", function () {
  loadTeam(Number($(this).val()));
});

$(".quota-form").on("submit", function (e) {
  e.preventDefault();
  const id = Number($("select[name=team]").val());
  const quota = Number($("input[name=quota]").val());
  if (!Number.isFinite(quota) || quota < 1 || quota > 5000) return flash("Quota must be between 1 and 5000 GB.");
  const $btn = $(".apply-quota");
  if (DISABLE_ON_SUBMIT) $btn.prop("disabled", true);
  $.ajax({ url: `/api/teams/${id}`, type: "PATCH", data: { quotaGb: quota }, dataType: "json", errorMessage: "The quota was not changed", success: (t: Team) => showTeam(t), complete: () => $btn.prop("disabled", false) } as JQuery.AjaxSettings);
});

$(".grow").on("click", function () {
  const id = Number($("select[name=team]").val());
  const $btn = $(this);
  if (DISABLE_ON_SUBMIT) {
    if ($btn.prop("disabled")) return;
    $btn.prop("disabled", true);
  }
  const done = { dataType: "json", errorMessage: "The quota could not be increased", success: (t: Team) => showTeam(t), complete: () => $btn.prop("disabled", false) };
  if (GROW === "relative") $.ajax({ url: `/api/teams/${id}/grow`, type: "POST", ...done } as JQuery.AjaxSettings);
  else $.ajax({ url: `/api/teams/${id}`, type: "PATCH", data: { quotaGb: Number($("input[name=quota]").val()) + 10 }, ...done } as JQuery.AjaxSettings);
});

// --------------------------------------------------------------------------------------------- invites
function loadInvites() {
  $.getJSON("/api/invites").done((res: { data: Invite[] }) => {
    const list = res.data ?? [];
    $(".invite-list").html(list.map((i) => `<li data-id="${i.id}">${esc(i.email)} (${esc(i.role)}) <button type="button" class="revoke">Revoke</button></li>`).join("") || `<li class="muted">No pending invites.</li>`);
  });
}

$(".invite-form").on("submit", function (e) {
  e.preventDefault();
  const $f = $(this);
  const email = String($f.find("input[name=email]").val() ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    $(".invite-msg").html(`<p role="alert">Enter a valid email address.</p>`);
    return;
  }
  const $btn = $f.find("button.send-invite");
  if (DISABLE_ON_SUBMIT) {
    if ($btn.prop("disabled")) return;
    $btn.prop("disabled", true).text("Sending…");
  }
  $.ajax({
    url: "/api/invites",
    type: "POST",
    data: { email, role: String($f.find("select[name=role]").val()) },
    dataType: "json",
    errorMessage: "The invite was not sent",
    success: (inv: Invite) => {
      $(".invite-msg").html(`<p class="ok">Invite sent to ${esc(inv.email)}.</p>`);
      $f.find("input[name=email]").val("");
      loadInvites();
    },
    onGiveUp: (xhr: JQuery.jqXHR) => $(".invite-msg").html(`<p role="alert">${xhr.status === 409 ? `${esc(email)} has already been invited.` : `The invite was not sent (${xhr.status || "network error"}).`}</p>`),
    complete: () => $btn.prop("disabled", false).text("Send invite"),
  } as JQuery.AjaxSettings);
});

$(".invite-list").on("click", "button.revoke", function () {
  const $li = $(this).closest("li");
  $li.addClass("revoking");
  $.ajax({ url: `/api/invites/${$li.data("id")}`, type: "DELETE", errorMessage: "The invite could not be revoked", success: () => $li.remove(), complete: () => $li.removeClass("revoking") } as JQuery.AjaxSettings);
});

// ----------------------------------------------------------------------------------------------- audit
let auditXhr: JQuery.jqXHR | null = null;
function loadAudit() {
  if (auditXhr) return; // the previous refresh is still running
  auditXhr = $.getJSON("/api/audit", { sort: "-createdAt", limit: 6 })
    .done((res: { data: Audit[] }) => {
      $(".audit-list").html((res.data ?? []).map((a) => `<li>${esc(a.actor)} ${esc(a.action)} <em>${esc(a.target)}</em></li>`).join(""));
    })
    .always(() => (auditXhr = null));
}

$(() => {
  loadMembers();
  loadInvites();
  loadAudit();
  $.getJSON("/api/teams").done((res: { data: Team[] }) => {
    teams = res.data ?? [];
    $("select[name=team]").html(teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join(""));
    if (teams[0]) showTeam(teams[0]);
  });
  setInterval(loadMembers, MEMBERS_MS);
  setInterval(loadAudit, AUDIT_MS);
});
