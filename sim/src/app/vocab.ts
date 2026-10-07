// Domain vocabularies. Each domain gives entity nouns, field names, value words, document nouns, metrics, live
// topics and settings, so that generated programs read like real apps from many industries. Names are further
// randomised per program (naming.ts): route styles, store/field synonyms, casing.

export interface Entity {
  s: string;
  p: string;
  /** Name-like field. */
  name: string;
  /** Words used to build item names. */
  words: string[];
  /** Numeric fields: [field, lo, hi, decimals]. */
  nums: [string, number, number, number][];
  /** Status enum values (first is the default). */
  status: string[];
  /** Boolean flags users toggle. */
  flags: string[];
  /** Verb for creating one ("place", "book", "log"). */
  create: string;
}

export interface Domain {
  name: string;
  titles: string[];
  entities: Entity[];
  /** Editable documents: [noun, text fields]. */
  docs: [string, string[]][];
  metrics: string[];
  topics: string[];
  settings: string[];
  /** Bulk verbs. */
  bulk: string[];
  /** People nouns. */
  people: string[];
}

function E(
  s: string,
  p: string,
  name: string,
  words: string,
  nums: string,
  status: string,
  flags: string,
  create: string,
): Entity {
  return {
    s,
    p,
    name,
    words: words.split(" "),
    nums: nums
      ? nums.split(" ").map((x) => {
          const [f, r] = x.split("=");
          const [lo, hi, dec] = (r ?? "1-100").split("-").map((n) => Number(n));
          return [f!, lo ?? 1, hi ?? 100, dec ?? 0] as [string, number, number, number];
        })
      : [],
    status: status ? status.split(" ") : [],
    flags: flags ? flags.split(" ") : [],
    create,
  };
}

function D(
  name: string,
  titles: string,
  entities: Entity[],
  docs: string,
  metrics: string,
  topics: string,
  settings: string,
  bulk: string,
  people: string,
): Domain {
  return {
    name,
    titles: titles.split(","),
    entities,
    docs: docs.split(";").map((d) => {
      const [n, f] = d.split(":");
      return [n!, (f ?? "title body").split(" ")] as [string, string[]];
    }),
    metrics: metrics.split(" "),
    topics: topics.split(" "),
    settings: settings.split(" "),
    bulk: bulk.split(" "),
    people: people.split(" "),
  };
}

export const DOMAINS: Domain[] = [
  D("commerce", "ShopFront,Marketly,Cartwise,Bazaar Hub", [
    E("product", "products", "title", "oak lamp ceramic mug linen throw desk chair steel kettle wool rug glass vase", "price=4-480-2 stock=0-90", "active draft archived", "featured onSale", "list"),
    E("order", "orders", "reference", "SO-1042 SO-1187 SO-2203 SO-3310 SO-4471", "amount=10-900-2 items=1-9", "pending paid shipped refunded", "flagged", "place"),
  ], "product listing:title description;store page:headline body", "checkout_rate cart_abandon orders_per_min p95_latency", "orders inventory prices", "currency emailReceipts compactView", "archive export tag", "customer buyer"),
  D("chat", "Chatter,Relay,Huddle,Parley", [
    E("message", "messages", "text", "hey lunch deploy standup review ship it thanks", "reactions=0-12", "sent delivered read", "pinned starred", "send"),
    E("channel", "channels", "name", "general random design backend support launch", "members=2-80", "open archived", "muted", "create"),
  ], "channel topic:topic description;draft:body", "messages_per_min online_users delivery_lag", "messages typing presence", "notifications enterKeySends theme", "archive mute", "member"),
  D("docs", "Scribe,PaperTrail,Quill,DocNest", [
    E("document", "documents", "title", "roadmap spec retro notes proposal budget plan", "words=50-9000", "draft review published", "starred shared", "create"),
    E("comment", "comments", "body", "typo nit question agree rewrite cite", "replies=0-9", "open resolved", "pinned", "add"),
  ], "document:title body;outline:heading summary", "edits_per_min active_editors save_latency", "edits comments cursors", "spellcheck autosave fontSize", "archive move share", "editor author"),
  D("project", "Taskline,Sprintly,Kanbo,TrackPad", [
    E("task", "tasks", "title", "fix login flaky test write docs migrate db design review ship beta", "points=1-13 estimate=1-40", "todo doing review done", "blocked urgent", "create"),
    E("milestone", "milestones", "name", "alpha beta launch q3 freeze", "progress=0-100", "planned active done", "atRisk", "add"),
  ], "task description:title details;sprint goal:goal notes", "throughput wip lead_time open_bugs", "board tasks activity", "showSubtasks weekStart compactCards", "assign close move label", "assignee owner"),
  D("finance", "Ledgerly,FinDash,BudgetBee,Tally", [
    E("transaction", "transactions", "payee", "rent groceries salary coffee utilities transfer refund", "amount=1-4000-2", "pending cleared disputed", "recurring flagged", "record"),
    E("budget", "budgets", "category", "food housing travel fun savings health", "limit=50-3000-2 spent=0-3000-2", "ok over", "pinned", "create"),
  ], "budget note:title memo;report:summary body", "spend_today balance burn_rate", "transactions balances alerts", "currency roundUp monthStart", "categorize export flag", "account holder"),
  D("health", "CareNote,VitalTrack,ClinicOS,MediBoard", [
    E("appointment", "appointments", "reason", "checkup followup vaccine lab consult therapy", "duration=15-90", "booked confirmed done cancelled", "urgent", "book"),
    E("reading", "readings", "kind", "pulse glucose weight bp temperature", "value=40-200-1", "normal high low", "reviewed", "log"),
  ], "visit note:summary plan;care plan:goals notes", "waiting_patients avg_wait bed_occupancy", "vitals appointments alerts", "units reminders shareWithDoctor", "reschedule notify archive", "patient clinician"),
  D("travel", "Wanderly,TripBoard,Roamr,Jetset", [
    E("booking", "bookings", "destination", "lisbon kyoto oslo lima cairo hanoi denver", "price=80-3000-2 nights=1-14", "held confirmed cancelled", "refundable", "book"),
    E("flight", "flights", "number", "LX318 AA102 DL44 BA287 NH9", "seats=0-180 fare=60-1500-2", "scheduled boarding departed delayed", "watched", "add"),
  ], "itinerary:title notes;trip journal:title entry", "searches_per_min fare_index bookings_today", "fares bookings gates", "currency seatAlerts carbonInfo", "cancel share export", "traveler agent"),
  D("iot", "HomeHub,SensorDeck,Thermia,Plugwise", [
    E("device", "devices", "label", "thermostat porch light garage door plug hallway sensor", "battery=0-100 temp=12-32-1", "online offline updating", "locked away", "pair"),
    E("rule", "rules", "name", "night mode away eco morning vacation", "priority=1-9", "enabled disabled", "notify", "create"),
  ], "scene:name description;automation note:title body", "devices_online avg_temp power_draw", "telemetry devices alarms", "units nightMode firmwareAuto", "restart group rename", "owner installer"),
  D("games", "Questline,PlayDeck,ArenaHub,Lootbox", [
    E("match", "matches", "mode", "ranked casual duo squad arena", "score=0-50 players=2-12", "queued live finished", "featured", "start"),
    E("item", "items", "name", "sword shield potion bow helm cloak", "power=1-99 cost=10-900", "owned listed sold", "equipped favorite", "craft"),
  ], "guild page:name motto;loadout note:title notes", "players_online queue_time matches_live", "matches lobby leaderboard", "sound difficulty colorblind", "sell equip discard", "player guildmate"),
  D("media", "Streamo,ReelBox,PodNest,ClipCast", [
    E("video", "videos", "title", "trailer recap tutorial vlog review unboxing", "views=0-90000 likes=0-5000", "processing ready private", "featured watchLater", "upload"),
    E("playlist", "playlists", "name", "chill focus workout roadtrip classics", "tracks=1-80", "public private", "pinned", "create"),
  ], "video description:title description;show notes:title notes", "streams_live buffer_ratio watch_minutes", "comments views uploads", "autoplay quality captions", "publish hide move", "viewer creator"),
  D("crm", "LeadFlow,Pipewise,Clientele,DealDesk", [
    E("lead", "leads", "company", "acme globex initech umbrella hooli vandelay", "value=500-90000 score=0-100", "new contacted qualified lost", "hot", "add"),
    E("deal", "deals", "name", "renewal upsell pilot enterprise starter", "amount=1000-250000 probability=0-100", "open won lost", "atRisk", "create"),
  ], "account note:title body;call summary:summary nextSteps", "pipeline_value win_rate calls_today", "deals leads activity", "currency territory digestEmail", "assign close tag", "rep prospect"),
  D("hr", "PeopleOps,Staffly,HireBoard,TeamRoll", [
    E("candidate", "candidates", "name", "ana li ben okafor chen wu dara singh eli moss", "rating=1-5 years=0-20", "applied screen interview offer hired", "starred", "add"),
    E("leave", "leaves", "type", "vacation sick parental unpaid", "days=1-20", "requested approved rejected", "urgent", "request"),
  ], "job post:title description;review:summary goals", "open_roles time_to_hire headcount", "applications approvals org", "timezone weekStart anonymizeCVs", "reject advance assign", "employee recruiter"),
  D("education", "Classly,LearnLoop,GradeBook,Tutorly", [
    E("assignment", "assignments", "title", "essay quiz lab worksheet project reading", "points=5-100 submissions=0-40", "draft open closed graded", "late", "create"),
    E("course", "courses", "name", "algebra biology history chemistry poetry", "students=5-300", "active archived", "featured", "add"),
  ], "lesson plan:title outline;feedback:summary body", "submissions_today avg_grade active_students", "submissions grades roster", "gradingScale lateSubmissions emailDigest", "grade return archive", "student teacher"),
  D("maps", "Waypoint,MapNest,Routely,GeoBoard", [
    E("place", "places", "name", "cafe museum park station harbor library market", "rating=1-5-1 distance=1-40-1", "open closed", "saved visited", "pin"),
    E("route", "routes", "name", "commute scenic shortest bike walk", "minutes=3-120 km=1-80-1", "planned active", "favorite", "plan"),
  ], "place review:title review;trip plan:title notes", "active_navigations reroutes traffic_index", "traffic places routes", "units avoidTolls voiceGuidance", "save share remove", "driver rider"),
  D("analytics", "Insightly,MetricHub,Chartbase,Trendr", [
    E("report", "reports", "name", "weekly kpis funnel retention cohort revenue", "rows=10-5000", "queued running ready failed", "scheduled", "run"),
    E("dashboard", "dashboards", "title", "growth ops marketing exec sales", "widgets=1-24", "draft shared", "pinned", "create"),
  ], "report note:title summary;query:name sql", "events_per_sec query_latency dau", "events reports alerts", "timezone sampling refreshRate", "export schedule delete", "analyst viewer"),
  D("social", "Circle,Feedly,Chirp,Gather", [
    E("post", "posts", "text", "sunset launch day new job hello world weekend recipe", "likes=0-900 shares=0-90", "published hidden", "pinned bookmarked", "post"),
    E("follower", "followers", "handle", "@ana @leo @kim @raj @zoe @max", "mutuals=0-40", "active blocked", "closeFriend", "follow"),
  ], "profile bio:headline bio;draft post:title body", "posts_per_min active_users report_rate", "feed likes follows", "privateAccount showLikes autoplay", "hide report delete", "follower author"),
  D("support", "HelpDesk,TicketFlow,Supportly,CaseHub", [
    E("ticket", "tickets", "subject", "refund login issue broken link billing error slow page", "priority=1-4 replies=0-30", "open pending solved closed", "escalated", "open"),
    E("macro", "macros", "name", "greeting refund steps escalate close", "uses=0-900", "active disabled", "shared", "create"),
  ], "reply draft:subject body;kb article:title body", "open_tickets first_response csat", "tickets replies queue", "signature autoAssign businessHours", "assign close merge", "agent requester"),
  D("inventory", "StockPilot,Shelfie,BinTrack,WareSmart", [
    E("sku", "skus", "code", "BX-101 TL-220 PK-330 CR-410 MT-501", "onHand=0-900 reorderAt=5-100", "instock low out", "discontinued", "add"),
    E("location", "locations", "name", "aisle 3 bay 12 dock a cold room mezzanine", "capacity=50-5000", "active full", "locked", "create"),
  ], "count sheet:title notes;supplier note:title body", "picks_per_hour stockouts accuracy", "stock moves counts", "units lowStockAlerts barcodeMode", "move recount archive", "picker manager"),
  D("logistics", "Freightly,RouteOps,Shipwise,Dispatchr", [
    E("shipment", "shipments", "tracking", "1Z999 JD014 TBA442 LX77 CP001", "weight=1-900-1 stops=1-12", "created intransit delivered exception", "fragile", "create"),
    E("driver", "drivers", "name", "sam lee rosa diaz omar haddad kai ito", "load=0-100", "available driving offduty", "onBreak", "add"),
  ], "manifest:title notes;delivery note:title body", "on_time_rate shipments_live exceptions", "positions shipments dispatch", "units podRequired autoDispatch", "assign reroute cancel", "dispatcher driver"),
  D("banking", "Vaultly,CoinBank,ClearPay,NorthBank", [
    E("payment", "payments", "payee", "landlord power co phone bill tuition savings", "amount=5-5000-2", "scheduled sent failed", "recurring", "schedule"),
    E("card", "cards", "label", "everyday travel online backup", "limit=200-20000", "active frozen", "contactless", "add"),
  ], "payment memo:title memo;dispute:summary details", "transfers_per_min balance fraud_flags", "payments balances alerts", "currency twoStep travelNotice", "cancel freeze export", "customer payee"),
  D("calendar", "Agenda,TimeBlock,Planr,Daybook", [
    E("event", "events", "title", "standup 1:1 lunch demo offsite review dentist", "duration=15-240 guests=1-30", "tentative confirmed cancelled", "private", "schedule"),
    E("calendar", "calendars", "name", "work personal family team holidays", "events=0-400", "visible hidden", "primary", "add"),
  ], "event notes:title agenda;meeting notes:title body", "events_today busy_ratio invites_pending", "events invites availability", "weekStart timezone declineConflicts", "move cancel duplicate", "attendee organizer"),
  D("food", "Dishly,FeastFast,Plated,GrubHub", [
    E("dish", "dishes", "name", "ramen tacos falafel pad thai poke risotto", "price=4-40-2 spice=0-5", "available soldout", "favorite vegan", "add"),
    E("delivery", "deliveries", "reference", "D-881 D-902 D-1440 D-2071", "eta=5-75 total=8-120-2", "placed cooking enroute delivered", "contactless", "place"),
  ], "recipe:title steps;menu note:title body", "orders_per_min avg_eta kitchen_load", "orders couriers menu", "tipDefault dietaryFilter notifyEta", "cancel reorder rate", "diner courier"),
  D("realestate", "Nestly,HomeFind,Listo,KeyBoard", [
    E("listing", "listings", "address", "12 elm st 4 bay rd 88 hill ave 7 park ln", "price=90000-2500000 beds=1-6", "active pending sold", "saved featured", "list"),
    E("showing", "showings", "slot", "sat 10am sun 2pm mon 6pm", "visitors=1-20", "requested confirmed done", "virtual", "book"),
  ], "listing description:headline description;offer note:title terms", "new_listings median_price showings_today", "listings offers showings", "currency mortgageCalc alerts", "archive share relist", "agent buyer"),
  D("music", "Tunely,Beatbox,Chordify,Soundry", [
    E("track", "tracks", "title", "midnight drive ocean eyes paper planes neon rain", "plays=0-99000 seconds=60-420", "draft released", "liked downloaded", "add"),
    E("album", "albums", "name", "first light blue hour echoes north", "tracks=4-20", "upcoming released", "saved", "release"),
  ], "liner notes:title notes;lyrics:title body", "streams_per_min skip_rate listeners", "plays queue likes", "crossfade normalize explicitFilter", "remove queue share", "listener artist"),
  D("news", "Dispatch,Newsroom,Headline,PressDesk", [
    E("article", "articles", "headline", "election recap storm warning market rally new stadium", "words=200-4000 reads=0-90000", "draft edited published", "breaking pinned", "write"),
    E("source", "sources", "name", "wire agency stringer press office", "trust=1-5", "active muted", "verified", "add"),
  ], "article:headline body;editor note:title notes", "reads_per_min breaking_count edit_lag", "articles edits wire", "region embargoAlerts byline", "publish unpublish tag", "editor reporter"),
  D("email", "Mailbox,Inboxly,PostMark,LetterBox", [
    E("thread", "threads", "subject", "invoice due lunch friday contract draft weekly digest", "messages=1-40", "inbox archived spam", "starred important", "compose"),
    E("label", "labels", "name", "receipts travel clients family later", "threads=0-900", "visible hidden", "color", "create"),
  ], "draft:subject body;signature:title body", "unread new_per_min send_queue", "mail labels drafts", "undoSend readReceipts conversationView", "archive mark label", "sender recipient"),
  D("notes", "Jotter,Notepad+,Memo,Brainbox", [
    E("note", "notes", "title", "ideas groceries quotes meeting books gifts", "words=1-3000", "active archived", "pinned locked", "create"),
    E("folder", "folders", "name", "personal work ideas archive journal", "notes=0-300", "open", "shared", "add"),
  ], "note:title body;journal entry:title entry", "notes_today sync_lag", "notes folders", "spellcheck defaultFolder sortBy", "archive move delete", "writer"),
  D("todo", "Checkit,DoneDeck,Taskly,ListPal", [
    E("todo", "todos", "text", "call mom buy milk renew passport pay rent water plants", "priority=1-3", "open done", "important", "add"),
    E("list", "lists", "name", "home errands work weekend shopping", "open=0-60", "active archived", "shared", "create"),
  ], "list description:title notes;goal:title details", "completed_today overdue streak", "todos lists", "dueReminders sortBy showCompleted", "complete delete move", "owner"),
  D("fitness", "Fitlog,RepCount,StrideBoard,PulseFit", [
    E("workout", "workouts", "name", "leg day 5k run yoga flow hiit swim", "minutes=10-120 calories=50-900", "planned done skipped", "favorite", "log"),
    E("goal", "goals", "name", "weekly runs daily steps protein sleep", "target=1-20000 progress=0-20000", "active met", "pinned", "set"),
  ], "training plan:title plan;journal:title entry", "active_sessions avg_hr steps_today", "workouts heart_rate goals", "units restTimer shareWorkouts", "delete repeat share", "athlete coach"),
  D("weather", "Skycast,Nimbus,Forecastly,StormDesk", [
    E("station", "stations", "name", "north pier airport hilltop downtown harbor", "temp=-20-40-1 wind=0-90", "reporting offline", "favorite", "add"),
    E("alert", "alerts", "kind", "frost wind heat flood storm", "severity=1-5", "watch warning expired", "muted", "create"),
  ], "forecast note:title body;alert text:title body", "stations_online alert_count update_lag", "observations alerts radar", "units alertRadius darkMap", "mute share remove", "forecaster"),
  D("rides", "Ridely,GoCab,Hopin,Shuttle", [
    E("ride", "rides", "pickup", "airport station mall office home campus", "fare=5-90-2 eta=1-30", "requested matched enroute completed cancelled", "shared", "request"),
    E("driver", "drivers", "name", "ali mona tom yuki ivan", "rating=3-5-1", "online busy offline", "favorite", "add"),
  ], "trip note:title notes;feedback:title body", "requests_per_min avg_eta surge", "rides drivers pricing", "paymentDefault shareTrip quietRide", "cancel rate tip", "rider driver"),
  D("events", "Ticketly,Gatehouse,Showtime,Venuo", [
    E("ticket", "tickets", "seat", "A12 B4 C30 GA floor balcony 2", "price=10-400-2 qty=1-8", "held sold scanned refunded", "vip", "buy"),
    E("show", "shows", "name", "jazz night comedy hour indie fest opera gala", "capacity=50-20000 sold=0-20000", "onsale soldout cancelled", "featured", "create"),
  ], "show page:title description;venue note:title notes", "sales_per_min scan_rate capacity_used", "sales scans seats", "currency queueMode waitlist", "refund transfer void", "attendee promoter"),
  D("hotel", "Staybook,Innly,RoomRack,Lodgr", [
    E("reservation", "reservations", "guest", "smith garcia chen patel novak", "nights=1-14 rate=60-900-2", "booked checkedin checkedout cancelled", "vip", "book"),
    E("room", "rooms", "number", "101 204 315 422 508", "beds=1-3 floor=1-12", "clean dirty occupied maintenance", "accessible", "add"),
  ], "guest note:title notes;house rules:title body", "occupancy adr checkins_today", "rooms reservations housekeeping", "currency lateCheckout earlyCheckin", "cancel move upgrade", "guest clerk"),
  D("library", "Shelfmark,Bookly,Libris,ReadRoom", [
    E("book", "books", "title", "dune emma ulysses beloved neuromancer", "copies=0-12 pages=80-1200", "available onloan reserved", "favorite", "add"),
    E("loan", "loans", "patron", "p-1101 p-2290 p-3874 p-4415", "daysLeft=0-30", "active overdue returned", "renewed", "start"),
  ], "book review:title review;reading list:title notes", "loans_today overdue holds", "loans holds catalog", "loanPeriod reminders branch", "renew return reserve", "patron librarian"),
  D("legal", "Clause,CaseFile,Brieflet,LexDesk", [
    E("contract", "contracts", "name", "nda msa sow lease license", "value=1000-900000 pages=2-120", "draft review signed expired", "urgent", "draft"),
    E("matter", "matters", "title", "acme v globex estate plan ip filing", "hours=1-900", "open stayed closed", "billable", "open"),
  ], "contract:title clauses;memo:title body", "matters_open billable_hours sign_rate", "signatures matters deadlines", "redline signatureOrder reminders", "archive assign sign", "counsel client"),
  D("insurance", "Claimly,PolicyPal,Coverly,Underwrite", [
    E("claim", "claims", "reference", "CL-1029 CL-2210 CL-3392 CL-4417", "amount=100-90000-2 photos=0-20", "filed review approved denied paid", "urgent", "file"),
    E("policy", "policies", "number", "PO-77 PO-102 PO-388 PO-901", "premium=20-900-2", "active lapsed", "autopay", "add"),
  ], "claim statement:title statement;adjuster note:title notes", "claims_open payout_time fraud_score", "claims payments reviews", "autopay paperless claimAlerts", "approve deny assign", "adjuster policyholder"),
  D("energy", "GridWise,Wattly,PowerDeck,Meterly", [
    E("meter", "meters", "serial", "MTR-01 MTR-77 MTR-140 MTR-301", "kwh=0-9000 voltage=210-250", "online fault offline", "flagged", "register"),
    E("outage", "outages", "area", "north grid east feeder substation 4", "customers=10-90000", "reported crew restored", "major", "report"),
  ], "maintenance note:title notes;incident report:title body", "load_mw outages_open voltage_dev", "readings outages crews", "units peakAlerts billing", "dispatch close merge", "operator customer"),
  D("farm", "Harvestly,FieldBook,AgriDesk,CropWise", [
    E("field", "fields", "name", "north forty river bottom east orchard plot 7", "acres=1-400 moisture=0-100", "planted growing harvested fallow", "irrigating", "add"),
    E("harvest", "harvests", "crop", "wheat corn soy barley apples", "tons=1-900-1", "planned done", "certified", "log"),
  ], "field log:title notes;crop plan:title plan", "soil_moisture yield_est machines_active", "sensors harvests weather", "units frostAlerts mapLayer", "assign log archive", "grower agronomist"),
  D("fleet", "FleetBoard,AutoTrack,Garagely,Motorly", [
    E("vehicle", "vehicles", "plate", "KJX-114 TRV-882 BNL-301 QPA-776", "miles=0-200000 fuel=0-100", "active service retired", "flagged", "add"),
    E("repair", "repairs", "job", "brakes oil change tires battery", "cost=40-3000-2", "open inprogress done", "warranty", "open"),
  ], "inspection note:title notes;repair order:title details", "vehicles_active fuel_burn incidents", "positions repairs alerts", "units idleAlerts geofence", "assign retire schedule", "mechanic driver"),
  D("pharmacy", "Rxly,PillBox,MedShelf,Dosewise", [
    E("prescription", "prescriptions", "drug", "amoxicillin metformin lisinopril albuterol", "refills=0-6 qty=10-90", "received filling ready pickedup", "urgent", "fill"),
    E("refill", "refills", "reference", "RF-210 RF-388 RF-402 RF-777", "daysSupply=7-90", "requested approved denied", "autoRefill", "request"),
  ], "counsel note:title notes;label text:title body", "queue_length fill_time interactions", "prescriptions refills stock", "pickupReminders genericOk largePrint", "approve hold transfer", "pharmacist patient"),
  D("devops", "Deployr,OpsBoard,Pipeline,Statusly", [
    E("deploy", "deploys", "version", "v1.4.2 v1.5.0 v2.0.0-rc1 v2.0.1", "duration=20-900 errors=0-40", "queued running succeeded failed", "pinned", "trigger"),
    E("incident", "incidents", "title", "api 5xx spike db failover cert expiry disk full", "severity=1-4", "open mitigated resolved", "paging", "declare"),
  ], "runbook:title steps;postmortem:title summary", "error_rate p95_latency cpu", "deploys incidents alerts", "autoRollback pagerHours canary", "rollback ack resolve", "oncall engineer"),
  D("code", "Codehub,Repoly,MergeBox,DiffDesk", [
    E("pull", "pulls", "title", "fix race in cache add retries bump deps refactor auth", "additions=1-900 comments=0-60", "open approved merged closed", "draft", "open"),
    E("issue", "issues", "title", "crash on save slow search typo in docs flaky ci", "votes=0-90", "open triaged closed", "good-first-issue", "file"),
  ], "pr description:title body;readme:title body", "ci_queue merge_rate open_prs", "commits checks reviews", "squashMerge notifyMentions theme", "merge close label", "reviewer contributor"),
  D("marketing", "Campaignly,Reachly,PromoDesk,Funnelr", [
    E("campaign", "campaigns", "name", "spring sale launch week webinar promo winback", "budget=100-90000 ctr=0-12-2", "draft scheduled live ended", "abTest", "create"),
    E("audience", "audiences", "name", "new users lapsed vip trial", "size=100-900000", "building ready", "synced", "build"),
  ], "email copy:subject body;landing page:headline body", "sends_per_min open_rate conversions", "sends clicks audiences", "timezone frequencyCap trackLinks", "pause duplicate archive", "marketer subscriber"),
  D("survey", "Pollster,Formly,AskAround,Feedback+", [
    E("survey", "surveys", "title", "nps onboarding exit event feedback pulse", "responses=0-9000 questions=1-30", "draft open closed", "anonymous", "create"),
    E("response", "responses", "respondent", "r-101 r-207 r-388 r-490", "score=0-10", "partial complete", "flagged", "submit"),
  ], "question text:title body;thank-you page:title body", "responses_per_min completion_rate", "responses surveys", "anonymous oneResponse showProgress", "close export duplicate", "respondent author"),
  D("nonprofit", "Givewell+,DonorDesk,Causely,Fundly", [
    E("donation", "donations", "donor", "j. park m. ruiz a. kahn l. berg", "amount=5-5000-2", "pledged received refunded", "recurring", "record"),
    E("campaign", "campaigns", "name", "winter drive school kits clean water", "goal=1000-500000 raised=0-500000", "active closed", "featured", "launch"),
  ], "appeal letter:title body;impact story:title body", "donations_today raised avg_gift", "donations pledges", "currency receipts anonymousGifts", "thank export tag", "donor volunteer"),
  D("permits", "CivicDesk,PermitPro,CityForms,Clerkly", [
    E("application", "applications", "address", "9 oak st 210 main 45 river rd 3 pine ct", "fee=20-900-2 days=1-90", "submitted review approved rejected", "expedited", "submit"),
    E("inspection", "inspections", "type", "electrical plumbing framing final", "score=0-100", "scheduled passed failed", "reinspect", "schedule"),
  ], "application note:title notes;decision letter:title body", "applications_open avg_days backlog", "applications inspections", "notifyByText language", "approve reject assign", "applicant inspector"),
  D("sports", "LeagueLine,Scoreboard,Fixtur,TeamSheet", [
    E("game", "games", "matchup", "hawks v owls tigers v bears comets v rockets", "homeScore=0-9 awayScore=0-9", "scheduled live final", "featured", "schedule"),
    E("player", "players", "name", "j. silva k. moore t. adeyemi r. novak", "goals=0-40 minutes=0-3000", "active injured", "captain", "add"),
  ], "match report:title body;team note:title notes", "live_games scores_per_min attendance", "scores lineups standings", "favoriteTeam spoilers notify", "trade bench release", "coach fan"),
  D("photos", "Snapvault,Gallerly,Lumen,PicNest", [
    E("photo", "photos", "caption", "beach sunset dog park birthday hike city lights", "likes=0-900 sizeKb=80-9000", "processing ready hidden", "favorite", "upload"),
    E("album", "albums", "name", "summer family trip 2026 pets food", "photos=0-900", "private shared", "pinned", "create"),
  ], "album description:title description;photo story:title body", "uploads_per_min storage_used", "uploads comments", "autoBackup faceGrouping hdOnly", "share hide delete", "photographer"),
  D("jobs", "Hirely,JobBoard+,Gigly,Careerly", [
    E("job", "jobs", "title", "backend dev nurse barista designer driver", "salary=20000-250000 applicants=0-900", "open paused filled", "remote featured", "post"),
    E("application", "applications", "candidate", "a. ito b. mensah c. ruiz d. kowal", "match=0-100", "applied viewed rejected interview", "starred", "apply"),
  ], "cover letter:title body;job description:title body", "applies_per_min views fill_rate", "applications jobs", "jobAlerts salaryVisible remoteOnly", "archive reject shortlist", "applicant employer"),
  D("pets", "Pawly,VetBook,PetPal,Furever", [
    E("pet", "pets", "name", "biscuit luna milo pepper nala", "age=0-18 weight=1-70-1", "healthy treatment adopted", "microchipped", "register"),
    E("visit", "visits", "reason", "vaccine dental checkup grooming", "cost=20-900-2", "booked done missed", "urgent", "book"),
  ], "care note:title notes;adoption profile:headline bio", "visits_today vaccines_due", "visits pets reminders", "reminders shareRecords units", "reschedule remind archive", "owner vet"),
  D("auction", "Bidly,Gavel,LotHouse,Hammer", [
    E("lot", "lots", "title", "vintage clock oil painting coin set signed jersey", "bid=1-90000-2 bids=0-200", "upcoming live sold unsold", "watched", "list"),
    E("bid", "bids", "bidder", "b-114 b-209 b-377 b-581", "amount=1-90000-2", "leading outbid won", "autoBid", "place"),
  ], "lot description:title description;terms:title body", "bids_per_min live_lots sell_through", "bids lots", "currency outbidAlerts proxyBidding", "withdraw relist close", "bidder seller"),
  D("wiki", "Wikiwise,KnowBase,Docuwiki,Lorebook", [
    E("page", "pages", "title", "onboarding style guide api keys faq glossary", "views=0-90000 edits=0-400", "draft published outdated", "locked", "create"),
    E("space", "spaces", "name", "eng sales hr ops design", "pages=0-900", "open restricted", "starred", "add"),
  ], "page:title body;template:title body", "edits_per_min stale_pages searches", "edits pages comments", "watchPages defaultSpace markdown", "move archive lock", "editor reader"),
  D("procurement", "Procura,BuyDesk,POflow,Sourcely", [
    E("purchase", "purchases", "vendor", "office depot cloud co steel works paper mill", "amount=50-90000-2 lines=1-40", "draft submitted approved received", "urgent", "submit"),
    E("vendor", "vendors", "name", "acme supply nordic parts blue ox northwind", "rating=1-5", "active onhold", "preferred", "add"),
  ], "rfq:title details;approval note:title notes", "pos_open spend_mtd approval_time", "approvals invoices", "currency approvalChain autoMatch", "approve reject receive", "buyer approver"),
  D("payroll", "Payday,Wagely,RunPay,Payslip", [
    E("payslip", "payslips", "employee", "e-101 e-204 e-377 e-412", "gross=500-20000-2 hours=0-200", "draft approved paid", "corrected", "run"),
    E("timesheet", "timesheets", "week", "w14 w15 w16 w17", "hours=0-80", "open submitted approved", "overtime", "submit"),
  ], "pay note:title notes;policy:title body", "runs_pending gross_total errors", "timesheets payruns", "payFrequency directDeposit rounding", "approve void export", "employee admin"),
  D("invoicing", "Billfold,InvoiceHub,Paperclip,Dues", [
    E("invoice", "invoices", "number", "INV-1001 INV-1022 INV-2048 INV-3117", "amount=20-90000-2 lines=1-30", "draft sent paid overdue", "disputed", "issue"),
    E("customer", "customers", "name", "acme ltd orbit co delta llc sun mart", "balance=0-90000-2", "active archived", "taxExempt", "add"),
  ], "invoice note:title notes;payment terms:title body", "outstanding dso paid_today", "invoices payments", "currency reminders lateFees", "send void remind", "client accountant"),
];

/** Navigation route names for multi-view apps. */
export const ROUTE_WORDS = ["home", "dashboard", "overview", "browse", "inbox", "board", "settings", "detail", "explore", "library", "activity", "queue", "workspace", "manage"];
