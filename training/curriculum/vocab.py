"""Vocabularies for the stage-1 curriculum: app domains, resources, fields, UI targets, errors.

Every domain is a compact spec; stores, routes, fields and values are derived from it so the generator sees many
surface forms. Domains marked in TEST_DOMAINS never appear in train/dev rows (held-out evaluation).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Domain:
    key: str
    titles: tuple[str, ...]
    nouns: tuple[str, ...]  # singular resource nouns; plural = noun + "s" unless listed in PLURALS
    nums: tuple[tuple[str, float, float, int], ...]  # (field, lo, hi, decimals)
    texts: tuple[str, ...]  # text fields of a resource
    buttons: tuple[str, ...]  # user-facing action labels
    money: bool = False  # cart/order-like aggregates (price * qty sums)


PLURALS = {"category": "categories", "company": "companies", "property": "properties", "entry": "entries",
           "policy": "policies", "story": "stories", "delivery": "deliveries", "reply": "replies",
           "activity": "activities", "inventory": "inventories", "child": "children", "person": "people",
           "address": "addresses", "status": "statuses", "batch": "batches", "match": "matches", "class": "classes",
           "box": "boxes", "quiz": "quizzes", "series": "series", "analysis": "analyses"}


def plural(n: str) -> str:
    last = n.split(" ")[-1]
    head = n[: len(n) - len(last)]
    return head + PLURALS.get(last, last + "s")


D = Domain
DOMAINS: tuple[Domain, ...] = (
    D("online store", ("Shoply", "Cartwheel", "Basketly"), ("product", "order", "review", "coupon"),
      (("price", 2, 400, 2), ("qty", 1, 9, 0), ("stock", 0, 500, 0), ("rating", 1, 5, 1)), ("name", "sku", "brand"),
      ("Add to cart", "Place order", "Apply coupon", "Remove", "Checkout"), True),
    D("music streaming", ("Tunebox", "Melodia", "Soundloft"), ("playlist", "track", "album", "artist"),
      (("duration", 90, 480, 0), ("plays", 0, 90000, 0), ("position", 1, 60, 0)), ("title", "genre", "label"),
      ("Add to playlist", "Play", "Like", "Shuffle", "Rename"), False),
    D("food delivery", ("Dishdash", "Platefly", "Forkful"), ("restaurant", "dish", "order", "courier"),
      (("price", 3, 60, 2), ("qty", 1, 6, 0), ("eta", 5, 75, 0), ("tip", 0, 20, 2)), ("name", "cuisine", "note"),
      ("Add dish", "Order now", "Track", "Tip courier", "Cancel order"), True),
    D("ride sharing", ("Rydr", "Hopcar", "Wayfare"), ("ride", "driver", "route", "payment"),
      (("fare", 4, 90, 2), ("distance", 1, 60, 1), ("eta", 1, 25, 0), ("seats", 1, 6, 0)), ("pickup", "dropoff", "plate"),
      ("Request ride", "Cancel ride", "Rate driver", "Split fare"), True),
    D("banking", ("Ledgerly", "Northbank", "Coinwell"), ("account", "transfer", "payee", "card"),
      (("amount", 1, 5000, 2), ("balance", 0, 20000, 2), ("limit", 100, 10000, 0)), ("iban", "memo", "nickname"),
      ("Send money", "Add payee", "Freeze card", "Download statement"), True),
    D("travel booking", ("Tripwise", "Farepath", "Jetnest"), ("flight", "booking", "passenger", "seat"),
      (("price", 40, 2400, 2), ("duration", 45, 900, 0), ("bags", 0, 3, 0)), ("origin", "destination", "carrier"),
      ("Search flights", "Book", "Choose seat", "Add bag"), True),
    D("hotel booking", ("Staybook", "Roomly", "Innsight"), ("hotel", "room", "reservation", "guest"),
      (("rate", 50, 900, 2), ("nights", 1, 14, 0), ("guests", 1, 6, 0)), ("name", "city", "board"),
      ("Reserve", "Change dates", "Cancel reservation", "Add guest"), True),
    D("real estate", ("Homescope", "Nestlist", "Keyfinder"), ("listing", "agent", "viewing", "offer"),
      (("price", 90000, 2500000, 0), ("bedrooms", 1, 7, 0), ("area", 30, 600, 0)), ("address", "type", "status"),
      ("Save listing", "Book viewing", "Make offer", "Contact agent"), False),
    D("recruiting", ("Hirely", "Talentry", "Pipeworks"), ("candidate", "job", "interview", "offer"),
      (("score", 1, 10, 1), ("salary", 30000, 250000, 0), ("stage", 1, 7, 0)), ("name", "role", "source"),
      ("Advance", "Reject", "Schedule interview", "Send offer"), False),
    D("learning platform", ("Learnloop", "Coursely", "Studyhall"), ("course", "lesson", "quiz", "enrollment"),
      (("progress", 0, 100, 0), ("score", 0, 100, 0), ("minutes", 1, 120, 0)), ("title", "instructor", "level"),
      ("Enroll", "Start lesson", "Submit quiz", "Mark complete"), False),
    D("project management", ("Taskforge", "Planwise", "Sprintly"), ("task", "project", "milestone", "comment"),
      (("estimate", 1, 40, 0), ("progress", 0, 100, 0), ("priority", 1, 5, 0)), ("title", "assignee", "status"),
      ("Create task", "Assign", "Close task", "Add comment"), False),
    D("kanban board", ("Boardly", "Cardstack", "Flowboard"), ("card", "column", "board", "label"),
      (("position", 0, 40, 0), ("points", 1, 13, 0), ("wip", 1, 9, 0)), ("title", "owner", "color"),
      ("Move card", "Add card", "Archive card", "Rename column"), False),
    D("notes app", ("Notely", "Jotpad", "Inkwell"), ("note", "folder", "tag", "attachment"),
      (("words", 0, 3000, 0), ("version", 1, 80, 0), ("size", 1, 900, 0)), ("title", "body", "color"),
      ("Save", "New note", "Move to folder", "Pin"), False),
    D("document editor", ("Draftly", "Pagecraft", "Docwell"), ("document", "section", "suggestion", "collaborator"),
      (("revision", 1, 400, 0), ("words", 10, 9000, 0), ("cursor", 0, 9000, 0)), ("title", "owner", "language"),
      ("Save", "Share", "Accept suggestion", "Rename"), False),
    D("team chat", ("Chatter", "Huddle", "Relaybox"), ("message", "channel", "thread", "reaction"),
      (("unread", 0, 99, 0), ("members", 2, 400, 0), ("seq", 1, 90000, 0)), ("text", "author", "topic"),
      ("Send", "React", "Mark read", "Create channel"), False),
    D("email client", ("Mailbird", "Inboxer", "Postwell"), ("email", "folder", "draft", "contact"),
      (("unread", 0, 500, 0), ("size", 1, 25000, 0), ("attachments", 0, 6, 0)), ("subject", "sender", "label"),
      ("Send", "Archive", "Reply", "Move", "Mark as spam"), False),
    D("calendar", ("Dayplan", "Slotly", "Agendo"), ("event", "invite", "calendar", "reminder"),
      (("duration", 15, 240, 0), ("attendees", 1, 40, 0), ("offset", 0, 120, 0)), ("title", "location", "organizer"),
      ("Create event", "Accept", "Decline", "Reschedule"), False),
    D("crm", ("Clientbase", "Dealflow", "Pipeline Pro"), ("lead", "deal", "contact", "activity"),
      (("value", 500, 250000, 0), ("probability", 0, 100, 0), ("touches", 0, 30, 0)), ("name", "company", "owner"),
      ("Convert lead", "Log call", "Close deal", "Assign owner"), False),
    D("helpdesk", ("Supportly", "Ticketbay", "Helpwise"), ("ticket", "agent", "macro", "customer"),
      (("priority", 1, 4, 0), ("age", 0, 240, 0), ("replies", 0, 30, 0)), ("subject", "queue", "status"),
      ("Reply", "Escalate", "Close ticket", "Assign"), False),
    D("inventory", ("Stockroom", "Binwise", "Shelfly"), ("item", "warehouse", "shipment", "supplier"),
      (("qty", 0, 900, 0), ("cost", 1, 300, 2), ("reorder", 5, 100, 0)), ("sku", "location", "unit"),
      ("Receive", "Adjust stock", "Transfer", "Reorder"), True),
    D("fleet tracking", ("Fleetview", "Trackwise", "Roadmap Ops"), ("vehicle", "trip", "driver", "alert"),
      (("speed", 0, 140, 0), ("fuel", 0, 100, 0), ("odometer", 100, 400000, 0)), ("plate", "status", "region"),
      ("Dispatch", "Acknowledge alert", "Assign driver", "End trip"), False),
    D("fitness tracker", ("Stridely", "Pulsefit", "Movewell"), ("workout", "goal", "set", "measurement"),
      (("reps", 1, 30, 0), ("weight", 2, 220, 1), ("minutes", 5, 180, 0)), ("type", "note", "unit"),
      ("Log workout", "Add set", "Set goal", "Finish"), False),
    D("recipes", ("Cookbook", "Savory", "Pantrypal"), ("recipe", "ingredient", "step", "shopping item"),
      (("servings", 1, 12, 0), ("grams", 5, 1500, 0), ("minutes", 5, 240, 0)), ("name", "cuisine", "unit"),
      ("Save recipe", "Scale", "Add to list", "Rate"), False),
    D("photo gallery", ("Snapvault", "Pixshelf", "Lenslog"), ("photo", "album", "tag", "share link"),
      (("width", 320, 8000, 0), ("likes", 0, 9000, 0), ("size", 50, 30000, 0)), ("caption", "camera", "place"),
      ("Upload", "Add to album", "Delete", "Share"), False),
    D("video streaming", ("Streamly", "Flickbox", "Reelhouse"), ("video", "episode", "watchlist", "profile"),
      (("progress", 0, 100, 0), ("duration", 60, 10800, 0), ("rating", 1, 10, 1)), ("title", "genre", "language"),
      ("Play", "Add to watchlist", "Rate", "Resume"), False),
    D("social feed", ("Chirply", "Feedly Social", "Loopnet"), ("post", "comment", "like", "follow"),
      (("likes", 0, 50000, 0), ("comments", 0, 3000, 0), ("shares", 0, 9000, 0)), ("text", "author", "visibility"),
      ("Like", "Comment", "Share", "Follow"), False),
    D("forum", ("Threadly", "Boardroom", "Agora"), ("topic", "reply", "vote", "moderator note"),
      (("votes", -50, 900, 0), ("replies", 0, 400, 0), ("views", 0, 90000, 0)), ("title", "author", "category"),
      ("Reply", "Upvote", "Lock topic", "Report"), False),
    D("news reader", ("Newsly", "Headline Hub", "Briefcase"), ("article", "source", "bookmark", "topic"),
      (("read_time", 1, 30, 0), ("score", 0, 100, 0), ("age", 0, 72, 0)), ("headline", "outlet", "section"),
      ("Bookmark", "Mute source", "Share", "Mark read"), False),
    D("weather dashboard", ("Skyline", "Forecastr", "Cloudnine"), ("station", "forecast", "alert", "location"),
      (("temp", -30, 45, 1), ("humidity", 5, 100, 0), ("wind", 0, 120, 0)), ("name", "condition", "region"),
      ("Add location", "Refresh", "Dismiss alert", "Change units"), False),
    D("smart home", ("Homehub", "Nestor", "Lumio"), ("device", "room", "scene", "schedule"),
      (("brightness", 0, 100, 0), ("setpoint", 15, 28, 1), ("battery", 0, 100, 0)), ("name", "type", "state"),
      ("Turn on", "Turn off", "Run scene", "Set temperature"), False),
    D("iot monitoring", ("Sensorium", "Telemetrix", "Gridwatch"), ("sensor", "gateway", "reading", "threshold"),
      (("value", 0, 1000, 2), ("rate", 1, 120, 0), ("uptime", 0, 100, 1)), ("name", "unit", "site"),
      ("Acknowledge", "Calibrate", "Mute", "Set threshold"), False),
    D("analytics dashboard", ("Metricly", "Chartbase", "Insightful"), ("report", "chart", "segment", "metric"),
      (("value", 0, 100000, 0), ("delta", -100, 100, 1), ("rows", 0, 50000, 0)), ("name", "period", "owner"),
      ("Run report", "Add chart", "Export", "Save segment"), False),
    D("ad campaigns", ("Adwise", "Clickforge", "Reachly"), ("campaign", "ad group", "creative", "budget"),
      (("spend", 0, 20000, 2), ("clicks", 0, 90000, 0), ("ctr", 0, 15, 2)), ("name", "status", "channel"),
      ("Pause", "Resume", "Increase budget", "Duplicate"), True),
    D("payroll", ("Paywell", "Salaria", "Runroll"), ("employee", "payslip", "pay run", "deduction"),
      (("gross", 1000, 15000, 2), ("hours", 0, 220, 1), ("tax", 0, 5000, 2)), ("name", "department", "status"),
      ("Run payroll", "Approve", "Add deduction", "Export"), True),
    D("expense tracking", ("Spendly", "Receiptly", "Costwise"), ("expense", "category", "receipt", "report"),
      (("amount", 1, 2500, 2), ("count", 0, 90, 0), ("limit", 50, 5000, 0)), ("merchant", "note", "currency"),
      ("Add expense", "Attach receipt", "Submit report", "Approve"), True),
    D("invoicing", ("Billwise", "Invoicely", "Ledgerline"), ("invoice", "line item", "client", "payment"),
      (("amount", 10, 9000, 2), ("qty", 1, 40, 0), ("days_due", 0, 90, 0)), ("number", "client", "status"),
      ("Send invoice", "Record payment", "Add line", "Void"), True),
    D("subscription billing", ("Subly", "Renewly", "Planbase"), ("subscription", "plan", "invoice", "seat"),
      (("price", 5, 900, 2), ("seats", 1, 500, 0), ("mrr", 0, 90000, 2)), ("plan", "status", "interval"),
      ("Upgrade", "Downgrade", "Add seats", "Cancel subscription"), True),
    D("library catalog", ("Shelfwise", "Bookhive", "Readwell"), ("book", "loan", "hold", "member"),
      (("copies", 0, 12, 0), ("due_in", 0, 30, 0), ("year", 1900, 2026, 0)), ("title", "author", "isbn"),
      ("Borrow", "Place hold", "Return", "Renew"), False),
    D("school grades", ("Gradebook", "Classly", "Markwise"), ("student", "assignment", "grade", "class"),
      (("score", 0, 100, 0), ("weight", 1, 40, 0), ("absences", 0, 20, 0)), ("name", "subject", "term"),
      ("Enter grade", "Publish", "Message parent", "Excuse"), False),
    D("clinic appointments", ("Carebook", "Clinicly", "Healwell"), ("appointment", "patient", "doctor", "slot"),
      (("duration", 10, 90, 0), ("wait", 0, 120, 0), ("age", 1, 99, 0)), ("name", "reason", "room"),
      ("Book", "Check in", "Reschedule", "Cancel"), False),
    D("event tickets", ("Ticketly", "Seatgeek Lite", "Gatepass"), ("event", "ticket", "seat", "order"),
      (("price", 10, 600, 2), ("qty", 1, 8, 0), ("remaining", 0, 5000, 0)), ("name", "venue", "section"),
      ("Buy tickets", "Select seat", "Transfer ticket", "Refund"), True),
    D("sports scores", ("Scoreline", "Matchday", "Fixturely"), ("match", "team", "player", "league"),
      (("score", 0, 9, 0), ("minute", 0, 120, 0), ("points", 0, 99, 0)), ("name", "venue", "status"),
      ("Follow team", "Refresh", "Set alert", "Open match"), False),
    D("game leaderboard", ("Rankup", "Highscore", "Ladderly"), ("player", "match", "season", "reward"),
      (("score", 0, 99999, 0), ("rank", 1, 5000, 0), ("level", 1, 99, 0)), ("handle", "region", "tier"),
      ("Claim reward", "Join match", "Report player", "Refresh"), False),
    D("code review", ("Reviewly", "Diffhub", "Mergewise"), ("pull request", "comment", "check", "reviewer"),
      (("additions", 0, 4000, 0), ("deletions", 0, 4000, 0), ("approvals", 0, 5, 0)), ("title", "branch", "author"),
      ("Approve", "Request changes", "Merge", "Comment"), False),
    D("ci dashboard", ("Buildly", "Pipewatch", "Greenlight"), ("build", "job", "artifact", "runner"),
      (("duration", 10, 3600, 0), ("tests", 0, 9000, 0), ("failures", 0, 200, 0)), ("branch", "commit", "status"),
      ("Rerun", "Cancel build", "Download artifact", "Pin"), False),
    D("feature flags", ("Flagship", "Togglely", "Rollout"), ("flag", "environment", "segment", "rule"),
      (("rollout", 0, 100, 0), ("evaluations", 0, 900000, 0), ("rules", 0, 20, 0)), ("key", "owner", "state"),
      ("Enable", "Disable", "Edit rule", "Archive flag"), False),
    D("survey builder", ("Surveyly", "Askwell", "Pollhouse"), ("survey", "question", "response", "choice"),
      (("responses", 0, 9000, 0), ("rate", 0, 100, 0), ("order", 1, 40, 0)), ("title", "type", "status"),
      ("Add question", "Publish", "Close survey", "Export results"), False),
    D("maps", ("Wayfinder", "Mapnest", "Routely"), ("place", "route", "pin", "review"),
      (("distance", 0, 900, 1), ("minutes", 1, 600, 0), ("rating", 1, 5, 1)), ("name", "address", "category"),
      ("Get directions", "Save place", "Drop pin", "Share"), False),
    D("parking", ("Parkly", "Spotfinder", "Curbside"), ("spot", "session", "garage", "permit"),
      (("rate", 1, 40, 2), ("minutes", 15, 600, 0), ("free", 0, 400, 0)), ("zone", "plate", "status"),
      ("Start session", "Extend", "End session", "Buy permit"), True),
    D("car rental", ("Rentwheel", "Drivewise", "Keyless"), ("car", "rental", "extra", "location"),
      (("rate", 20, 400, 2), ("days", 1, 30, 0), ("mileage", 0, 3000, 0)), ("model", "class", "branch"),
      ("Reserve car", "Add extra", "Extend rental", "Return car"), True),
    D("insurance claims", ("Claimwise", "Coverly", "Shieldline"), ("claim", "policy", "document", "adjuster"),
      (("amount", 100, 90000, 2), ("days_open", 0, 180, 0), ("deductible", 0, 5000, 0)), ("number", "type", "status"),
      ("File claim", "Upload document", "Approve claim", "Request info"), True),
    D("language learning", ("Lingua", "Wordwise", "Fluently"), ("lesson", "word", "streak", "exercise"),
      (("xp", 0, 90000, 0), ("accuracy", 0, 100, 0), ("days", 0, 900, 0)), ("term", "language", "level"),
      ("Start lesson", "Check answer", "Skip", "Review words"), False),
    D("job board", ("Jobly", "Careerline", "Workfind"), ("job", "application", "company", "saved search"),
      (("salary", 20000, 300000, 0), ("applicants", 0, 900, 0), ("age_days", 0, 60, 0)), ("title", "location", "type"),
      ("Apply", "Save job", "Withdraw", "Follow company"), False),
    D("auction", ("Bidwell", "Gavel", "Lotline"), ("lot", "bid", "watchlist", "seller"),
      (("amount", 1, 50000, 2), ("bids", 0, 300, 0), ("seconds_left", 0, 86400, 0)), ("title", "condition", "status"),
      ("Place bid", "Watch", "Buy now", "Retract bid"), True),
    D("grocery", ("Freshcart", "Grocerly", "Basket Market"), ("item", "aisle", "order", "substitution"),
      (("price", 0.5, 40, 2), ("qty", 1, 12, 0), ("weight", 0.1, 5, 2)), ("name", "brand", "unit"),
      ("Add item", "Checkout", "Allow substitution", "Remove"), True),
    D("restaurant reservations", ("Tablely", "Seatwise", "Dinewell"), ("reservation", "table", "restaurant", "waitlist entry"),
      (("party", 1, 12, 0), ("minutes", 0, 180, 0), ("deposit", 0, 200, 2)), ("name", "time", "status"),
      ("Reserve", "Join waitlist", "Cancel", "Modify"), False),
    D("bike sharing", ("Pedalshare", "Spinly", "Cyclewise"), ("bike", "dock", "ride", "pass"),
      (("battery", 0, 100, 0), ("minutes", 1, 240, 0), ("free_docks", 0, 40, 0)), ("station", "type", "status"),
      ("Unlock", "End ride", "Report bike", "Buy pass"), True),
    D("energy usage", ("Wattwise", "Gridly", "Powerpal"), ("meter", "reading", "tariff", "appliance"),
      (("kwh", 0, 90, 2), ("cost", 0, 60, 2), ("peak", 0, 15, 2)), ("name", "period", "unit"),
      ("Refresh", "Change tariff", "Set budget", "Export"), True),
    D("shipping tracker", ("Shipwise", "Parcelly", "Trackline"), ("shipment", "package", "carrier", "checkpoint"),
      (("weight", 0.1, 70, 2), ("days", 0, 30, 0), ("stops", 0, 20, 0)), ("tracking_no", "status", "city"),
      ("Track", "Change address", "Hold package", "Report issue"), False),
    D("wiki", ("Wikinest", "Docuhub", "Knowly"), ("page", "revision", "link", "category"),
      (("revision", 1, 900, 0), ("views", 0, 90000, 0), ("links", 0, 400, 0)), ("title", "author", "namespace"),
      ("Edit page", "Revert", "Watch", "Move page"), False),
    D("spreadsheet", ("Gridsheet", "Cellwise", "Tabula"), ("sheet", "cell", "range", "formula"),
      (("value", -1000, 100000, 2), ("row", 1, 5000, 0), ("col", 1, 60, 0)), ("name", "format", "owner"),
      ("Recalculate", "Insert row", "Sort", "Share"), True),
    D("whiteboard", ("Sketchboard", "Canvasly", "Ideaspace"), ("shape", "board", "sticky note", "connector"),
      (("x", 0, 4000, 0), ("y", 0, 4000, 0), ("z", 0, 300, 0)), ("label", "color", "kind"),
      ("Add sticky", "Group", "Delete", "Export board"), False),
)

# Held-out domains: only in the test split (≈20%).
TEST_DOMAINS = frozenset({"recipes", "parking", "forum", "payroll", "maps", "auction", "insurance claims",
                          "weather dashboard", "ci dashboard", "restaurant reservations", "energy usage",
                          "language learning", "photo gallery"})


def domain_split(d: Domain) -> str:
    return "test" if d.key in TEST_DOMAINS else "train"


# ---------------------------------------------------------------------------------------------- generic UI

PERSON_FIRST = ("Ana", "Ben", "Chen", "Dara", "Eli", "Fatima", "Gus", "Hana", "Ivan", "Jade", "Kofi", "Lena", "Mateo",
                "Nia", "Omar", "Priya", "Quinn", "Rosa", "Sven", "Tara", "Umar", "Vera", "Wes", "Ximena", "Yuki", "Zane")
COMPONENTS = ("List", "Table", "Panel", "Card", "Header", "Sidebar", "Form", "Modal", "Row", "Summary", "Badge",
              "Toolbar", "Grid", "Chart", "Feed", "Detail", "Editor", "Picker", "Footer", "Tabs")
FILE_EXT = (".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte")
INPUT_TARGETS = ("#search", "#query", "#filter", "#title", "#name", "#email", "#note", "#comment", "#amount",
                 "input[name=q]", "#tag-input", "#message", "#address")
THIRD_PARTY = ("https://cdn.analytics-tag.example/t.js", "chrome-extension://abcdefghijklmnop/content.js",
               "https://widget.chat-vendor.example/embed.js", "moz-extension://4f1c2e/inject.js",
               "https://ads.partner.example/slot.js")
