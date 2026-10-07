"""Standalone primitive families (not situation-shaped): JSON invariants, HTTP semantics, JS errors, and
generic decisions whose options carry descriptions (plugin-style actions / developer `decide`)."""

from __future__ import annotations

import json
import random

import prims as P
from app import App, rand_token
from fmt import Style, pick_from
from vocab import COMPONENTS, FILE_EXT, THIRD_PARTY


def _row(state, questions, labels, family, meta) -> dict:
    return {"state": state, "questions": questions, "labels": labels, "family": family, "meta": meta}


# ------------------------------------------------------------------------------------------- JSON invariants


def json_invariants(rng: random.Random, app: App, st: Style) -> dict:
    test = st.test
    store = rng.choice(("cart", "order", app.coll, "basket", "invoice", "summary"))
    k = rng.randint(1, 6)
    num_spec = rng.choice(app.num_fields)
    nf = app.ident(num_spec[0])
    ids = []
    while len(ids) < k:
        x = app.new_id()
        if x not in ids:
            ids.append(x)
    items = []
    for i in range(k):
        price = round(rng.uniform(1, 150), 2)
        qty = rng.randint(1, 5)
        items.append({"id": ids[i], app.ident(app.text_field): app.word().capitalize(), "price": price, "qty": qty,
                      nf: app.num_value(num_spec)})
    true_total = round(sum(it["price"] * it["qty"] for it in items), 2)
    breaks = rng.random() < 0.5
    which = rng.choice(("total", "count", "selected", "unique", "nonneg"))
    total = true_total
    count = k
    selected = rng.choice(ids)
    if breaks:
        if which == "total":
            total = round(true_total + rng.choice((-1, 1)) * rng.choice((0.5, 1, 5, 10, items[0]["price"])), 2)
        elif which == "count":
            count = k + rng.choice((-1, 1, 2))
        elif which == "selected":
            selected = app.new_id()
            while selected in ids:
                selected = app.new_id()
        elif which == "unique" and k >= 2:
            items[1]["id"] = items[0]["id"]
        elif which == "nonneg":
            items[rng.randrange(k)]["qty"] = -rng.randint(1, 3)
            true_total = round(sum(it["price"] * it["qty"] for it in items), 2)
            total = true_total
    data = {"items": items, "total": total, "count": count, "selectedId": selected}
    fmt = rng.random()
    if fmt < 0.4:
        state = {store: data}
    elif fmt < 0.7:
        state = {f"{store}.items": json.dumps(items), f"{store}.total": total, f"{store}.count": count,
                 f"{store}.selectedId": selected}
    else:
        state = json.dumps({store: data}, indent=None)
    ids_now = [it["id"] for it in items]
    checks = {
        "total": (f"Does {store}.total equal the sum of price × qty over {store}.items?",
                  abs(total - round(sum(it['price'] * it['qty'] for it in items), 2)) < 0.005),
        "count": (f"Does {store}.count equal the number of items in {store}.items?", count == len(items)),
        "selected": (f"Is {store}.selectedId one of the ids in {store}.items?", selected in ids_now),
        "unique": (f"Are all ids in {store}.items unique?", len(set(ids_now)) == len(ids_now)),
        "nonneg": (f"Is every qty in {store}.items at least 1?", all(it["qty"] >= 1 for it in items)),
    }
    questions, labels = {}, {}
    for name in rng.sample(sorted(checks), rng.randint(2, 4)):
        txt, truth = checks[name]
        if test and rng.random() < 0.5:
            txt = txt.replace("Does", "Check: does").replace("Is", "Check: is").replace("Are", "Check: are")
        q, lab = P.noul(txt, truth)
        questions[f"j_{name}"] = q
        labels[f"j_{name}"] = lab
    rel_text = {"total": f"{store}.total == sum(price × qty)", "count": f"{store}.count == len(items)",
                "selected": f"{store}.selectedId ∈ items[*].id", "unique": "items[*].id unique",
                "nonneg": "items[*].qty >= 1"}
    broken = [n for n, (_, ok) in checks.items() if not ok]
    if len(broken) <= 1:
        opts = rng.sample(sorted(rel_text), 3)
        if broken and broken[0] not in opts:
            opts[0] = broken[0]
        crit = {n: rel_text[n] for n in opts}
        crit["none"] = "all of these hold"
        q, lab = P.choice(pick_from(rng, ["Which relation is violated?", "Which of these invariants is broken?",
                                          "Pick the relation that does not hold."], test), crit,
                          broken[0] if broken else "none")
        questions["j_which"] = q
        labels["j_which"] = lab
    thr = rng.choice((20, 50, 100))
    n_over = sum(1 for it in items if it["price"] > thr)
    q, lab = P.score(f"How many items have a price above {thr}?", ["0", "1", "2", "3 or more"], min(n_over, 3))
    questions["j_count"] = q
    labels["j_count"] = lab
    return _row(state, questions, labels, "cur/prim/json_invariants", {"kind": "prim", "family": "json_invariants",
                                                                     "domain": app.dom.key})


# ------------------------------------------------------------------------------------------- HTTP semantics

HTTP_CASES = [  # (code, err, headers, body)
    (400, "", "", '{"error":"bad_request","message":"Malformed JSON"}'),
    (401, "", 'WWW-Authenticate: Bearer error="invalid_token", error_description="The access token expired"', ""),
    (403, "", "", '{"error":"forbidden","message":"Requires role admin"}'),
    (404, "", "", '{"error":"not_found"}'),
    (409, "", "ETag mismatch", '{"error":"conflict","message":"Version 12 is outdated; current is 14"}'),
    (410, "", "", '{"error":"gone"}'),
    (413, "", "", '{"error":"payload_too_large","limit":"10MB"}'),
    (422, "", "", '{"error":"validation_failed","fields":{"FIELD":"must be a valid value"}}'),
    (429, "", "Retry-After: RA", '{"error":"rate_limited"}'),
    (500, "", "", '{"error":"internal"}'),
    (502, "", "", "<html>Bad Gateway</html>"),
    (503, "", "Retry-After: RA", '{"error":"maintenance"}'),
    (504, "", "", "<html>Gateway Timeout</html>"),
    (None, "network error", "", "TypeError: Failed to fetch"),
    (None, "timeout", "", "AbortError: signal timed out after 10000 ms"),
]


def http_semantics(rng: random.Random, app: App, st: Style) -> dict:
    test = st.test
    code, err, headers, body = rng.choice(HTTP_CASES)
    method = rng.choice(("GET", "GET", "POST", "PUT", "PATCH", "DELETE"))
    id_ = app.new_id()
    url = app.coll_url() if method in ("GET", "POST") else app.item_url(id_)[0]
    field = app.ident(rng.choice(("email", "phone", "quantity", "start date", "name", "postal code")))
    body = body.replace("FIELD", field)
    ra = rng.choice((1, 3, 10, 30, 60, 300))
    headers = headers.replace("RA", str(ra))
    has_key = method == "POST" and rng.random() < 0.3
    req = f"{method} {url}" + (" (Idempotency-Key set)" if has_key else "")
    status = f"{code} {P_status(code)}" if code else err
    if rng.random() < 0.5:
        state = {"request": req, "response": status, "headers": headers or "none", "body": body or "(empty)"}
    else:
        state = f"{req} -> {status}" + (f"; {headers}" if headers else "") + (f"; body: {body}" if body else "")
    from world import Op
    op = Op(1, "fetch", 0.0, method=method, url=url, sig=method + " " + url, code=code, err=err)
    questions, labels = {}, {}
    for qid, q, lab in P.failure_q(rng, st, op, has_key):
        questions[qid], labels[qid] = q, lab
    if code in (429, 503) and headers:
        lv = 0 if ra <= 2 else 1 if ra <= 15 else 2 if ra <= 90 else 3
        q, lab = P.score(pick_from(rng, ["How long should the client wait before retrying?",
                                         "Minimum wait before the next attempt?", "Back-off the server asks for?"], test),
                         ["about a second", "a few seconds", "about a minute", "several minutes"], lv)
        questions["h_wait"], labels["h_wait"] = q, lab
    q, lab = P.noul(pick_from(rng, ["Does the user need to sign in again (or refresh credentials)?",
                                    "Is this an expired or missing login?", "Are credentials the problem?"], test),
                    code == 401)
    questions["h_auth"], labels["h_auth"] = q, lab
    who = "client" if code and 400 <= code < 500 and code not in (408, 429) else "server" if code and code >= 500 else \
        "network" if err == "network error" else "server" if err == "timeout" else "client"
    if code == 429:
        who = "client"
    if err != "timeout":
        q, lab = P.choice(pick_from(rng, ["Whose side is the problem on?", "Where does the fault lie?",
                                      "Which side should change something?"], test),
                          {"client": "the request or the client's behaviour", "server": "the server or a gateway",
                           "network": "connectivity between them"}, who)
        questions["h_side"], labels["h_side"] = q, lab
    if code == 422:
        others = [app.ident(x) for x in ("email", "phone", "quantity", "start date", "name", "postal code")]
        opts = [field] + rng.sample([x for x in others if x != field], 2)
        rng.shuffle(opts)
        q, lab = P.choice("Which field was rejected?", {x: None for x in opts}, field)
        questions["h_field"], labels["h_field"] = q, lab
    return _row(state, questions, labels, "cur/prim/http", {"kind": "prim", "family": "http", "domain": app.dom.key,
                                                            "code": code, "err": err})


def P_status(code: int) -> str:
    from world import STATUS_TEXT

    return STATUS_TEXT.get(code, "")


# ------------------------------------------------------------------------------------------- JS errors

JS_ERRS = [
    ("TypeError", "Cannot read properties of undefined (reading '{p}')", "null_data"),
    ("TypeError", "Cannot read properties of null (reading '{p}')", "null_data"),
    ("TypeError", "{f} is not a function", "not_function"),
    ("ReferenceError", "{f} is not defined", "undefined_name"),
    ("RangeError", "Maximum call stack size exceeded", "recursion"),
    ("SyntaxError", "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", "bad_json"),
    ("QuotaExceededError", "Failed to execute 'setItem' on 'Storage': exceeded the quota", "storage_quota"),
    ("TypeError", "Failed to fetch", "network"),
    ("AbortError", "The operation was aborted.", "aborted"),
]
JS_KIND_DESC = {"null_data": "code used data that was null or undefined", "not_function": "called something that is not a function",
                "undefined_name": "referenced a variable that does not exist", "recursion": "infinite recursion",
                "bad_json": "parsed HTML or garbage as JSON (usually an error page)", "storage_quota": "browser storage is full",
                "network": "a network request failed", "aborted": "an operation was cancelled on purpose"}


def js_errors(rng: random.Random, app: App, st: Style) -> dict:
    test = st.test
    name, msg, kind = rng.choice(JS_ERRS)
    prop = rng.choice(("map", "length", "id", "items", "forEach", "price", "name"))
    fn = app.ident(rng.choice(("format price", "on select", "render row", "use items", "track event")))
    msg = msg.format(p=prop, f=fn)
    third = rng.random() < 0.25
    comps = [app.ident(app.noun).capitalize() + rng.choice(COMPONENTS) for _ in range(3)]
    comps = list(dict.fromkeys(comps))
    if third:
        src = rng.choice(THIRD_PARTY)
        stack = [f"at {rand_token(rng, 3)} ({src}:1:{rng.randint(100, 9000)})" for _ in range(rng.randint(1, 3))]
        top = None
    else:
        stack = [f"at {c} ({app.url_word(app.noun)}{rng.choice(FILE_EXT)}:{rng.randint(5, 400)}:{rng.randint(2, 60)})"
                 for c in comps]
        top = comps[0]
    state = {"error": f"{name}: {msg}", "stack": stack,
             "recent": rng.sample([f"click {app.button()}", f"GET {app.coll_url()} 200", "route change",
                                   f"set {app.coll}.items", "focus #search"], 2)}
    if rng.random() < 0.3:
        state = f"Uncaught {name}: {msg}\n" + "\n".join("    " + s for s in stack)
    questions, labels = {}, {}
    opts = [kind] + rng.sample([k for k in JS_KIND_DESC if k != kind], 3)
    rng.shuffle(opts)
    q, lab = P.choice(pick_from(rng, ["What kind of error is this?", "What most likely went wrong?",
                                      "Classify this exception."], test), {k: JS_KIND_DESC[k] for k in opts}, kind)
    questions["js_kind"], labels["js_kind"] = q, lab
    q, lab = P.noul(pick_from(rng, ["Is the error thrown by the app's own code (not a third-party script)?",
                                    "Does the stack point into first-party code?", "Is this the app's own bug?"], test),
                    not third)
    questions["js_first"], labels["js_first"] = q, lab
    if top:
        decoys = [app.ident(app.noun2).capitalize() + rng.choice(COMPONENTS), "App", "Router"]
        opts = list(dict.fromkeys([top] + decoys))[:4]
        rng.shuffle(opts)
        q, lab = P.choice(pick_from(rng, ["Which component threw the error?", "Where was it thrown (top frame)?",
                                          "Name the component at the top of the stack."], test), {o: None for o in opts}, top)
        questions["js_comp"], labels["js_comp"] = q, lab
    return _row(state, questions, labels, "cur/prim/js_errors", {"kind": "prim", "family": "js_errors", "domain": app.dom.key})


# ------------------------------------------------------------------------------------------- described options

DECIDE = [
    # (situation text, {option: (description, correct?)}) — the right option follows from the text.
    ("The API answered 401 with error=\"invalid_token\" (access token expired 3 min ago). A refresh token is stored and valid for 29 more days.",
     {"refresh": ("silently get a new access token with the refresh token, then retry", True),
      "login": ("send the user to the sign-in page", False), "retry": ("retry the same request unchanged", False),
      "ignore": ("do nothing", False)}),
    ("The API answered 401 with error=\"invalid_token\"; no refresh token is stored (the user signed in 31 days ago).",
     {"refresh": ("silently get a new access token with the refresh token, then retry", False),
      "login": ("send the user to the sign-in page", True), "retry": ("retry the same request unchanged", False),
      "ignore": ("do nothing", False)}),
    ("Saving the form returned 422: {\"fields\":{\"email\":\"must be a valid address\"}}. The user typed \"ana@example\".",
     {"highlight": ("mark the invalid field and show the server's message", True),
      "retry": ("submit the same data again", False), "report": ("file a bug report automatically", False),
      "clear": ("clear the whole form", False)}),
    ("The device is offline (navigator.onLine is false). The user just edited a note; the save request failed with a network error.",
     {"queue": ("keep the change locally and send it when the connection returns", True),
      "drop": ("discard the user's edit", False), "retry_now": ("retry immediately in a tight loop", False),
      "alert": ("show a blocking error dialog and discard", False)}),
    ("Updating record 12 returned 409: the server copy is version 14, the client edited version 12. The user changed only the title; the server changes were to the tags.",
     {"merge": ("reload the latest version and re-apply the user's title change", True),
      "overwrite": ("force the client's version over the server's", False),
      "drop_local": ("throw away the user's edit", False), "retry": ("send the same update again", False)}),
    ("localStorage.setItem threw QuotaExceededError. 4.8 MB are used, 4.1 MB of it by an old cache of thumbnails.",
     {"evict": ("delete old cached entries, then try again", True), "ignore": ("ignore the failure", False),
      "clear_all": ("wipe all storage including drafts and settings", False), "reload": ("reload the page", False)}),
    ("The search request for \"rea\" returned after the request for \"react\" had already been displayed.",
     {"drop_old": ("ignore the older response", True), "show_old": ("display the older response", False),
      "merge": ("concatenate both result lists", False), "retry": ("send \"rea\" again", False)}),
    ("A payment POST timed out after 30 s. The request carried no idempotency key; the order list shows no new order yet.",
     {"check_status": ("ask the server whether the payment went through before doing anything else", True),
      "retry": ("send the same payment again", False), "assume_failed": ("tell the user it failed and let them pay again", False),
      "assume_ok": ("tell the user it succeeded", False)}),
    ("The dashboard poll for /api/status has failed 7 times in a row with 503 over the last minute.",
     {"backoff": ("poll less often until it recovers", True), "faster": ("poll more often to catch the recovery", False),
      "stop_forever": ("stop polling for the rest of the session", False), "reload": ("reload the whole page", False)}),
    ("The user double-clicked \"Place order\"; the second click fired 80 ms after the first while the first POST is still pending.",
     {"dedupe": ("ignore the second click and wait for the first request", True),
      "send_both": ("send both orders", False), "cancel_first": ("abort the first request and send the second", False),
      "disable_forever": ("disable the button for the rest of the session", False)}),
    ("An image upload of 45 MB is at 60% after 40 s; similar uploads usually take about 70 s.",
     {"wait": ("let it continue", True), "restart": ("cancel and start the upload again", False),
      "duplicate": ("start a second parallel upload", False), "fail": ("give up and show an error", False)}),
    ("The total shown in the cart (59.97) disagrees with the line items (79.96) after the add-to-cart request failed half-way.",
     {"reload_cart": ("reload the cart from the server", True), "keep": ("keep showing 59.97", False),
      "edit_lines": ("delete line items until the sum matches", False), "logout": ("sign the user out", False)}),
]


def described_options(rng: random.Random, app: App, st: Style) -> dict:
    test = st.test
    text, opts = rng.choice(DECIDE)
    names = list(opts)
    if rng.random() < 0.3:  # opaque option names: the description is the only signal
        rng.shuffle(names)
        alias = {n: f"option_{c}" for n, c in zip(names, "abcdef")}
    else:
        alias = {n: n for n in names}
        rng.shuffle(names)
    crit = {alias[n]: opts[n][0] for n in names}
    gold = [alias[n] for n in names if opts[n][1]][0]
    state = {"situation": text} if rng.random() < 0.6 else text
    q, lab = P.choice(pick_from(rng, ["What should the app do?", "Choose the best response.", "Which option is right here?",
                                      "Decide the next step.", "Pick the safest correct action."], test), crit, gold)
    return _row(state, {"decide": q}, {"decide": lab}, "cur/prim/decide",
                {"kind": "prim", "family": "decide", "domain": app.dom.key})
