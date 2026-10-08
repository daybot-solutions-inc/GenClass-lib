// Additional domain vocabularies (60 more industries), same compact format as vocab.ts. Kept separate so the
// original list stays stable; consumers can concatenate DOMAINS and DOMAINS2.

import { D, E, type Domain } from "./vocab.js";

export const DOMAINS2: Domain[] = [
  // ---- health & science ----
  D("dental", "SmileChart,ToothBook,MolarDesk,BrightBite", [
    E("appointment", "appointments", "procedure", "cleaning filling crown xray whitening rootcanal extraction checkup", "duration=15-120 chair=1-8", "booked confirmed seated done noshow", "urgent", "book"),
    E("treatment", "treatments", "code", "D0120 D1110 D2391 D2740 D3330 D7140", "fee=40-2400-2 tooth=1-32", "planned accepted completed declined", "insured", "plan"),
  ], "chart note:summary findings;treatment plan:title notes", "chairs_busy avg_wait recall_due", "appointments charts recalls", "recallInterval smsReminders xrayUnits", "reschedule remind archive", "patient hygienist"),
  D("triage", "TriageBoard,ERFlow,AcuityDesk,Waitwatch", [
    E("arrival", "arrivals", "complaint", "chest pain fracture fever laceration asthma dizziness burn", "acuity=1-5 waitMin=0-240", "waiting triaged treating admitted discharged", "isolation", "register"),
    E("bed", "beds", "label", "resus1 resus2 bay3 bay4 hall5 peds6 obs7", "turnMin=10-600", "free occupied cleaning blocked", "monitored", "assign"),
  ], "triage note:summary assessment;handoff note:title notes", "waiting_count door_to_doc beds_free lwbs_rate", "arrivals beds vitals", "acuityScale autoRefresh soundAlerts", "assign discharge transfer", "nurse physician"),
  D("lims", "SampleTrack,BenchLog,AssayHub,LabLedger", [
    E("sample", "samples", "barcode", "S-10421 S-10588 S-11032 S-11790 S-12044 S-12513", "volumeUl=10-5000 tempC=2-40", "received queued testing reported rejected", "hazardous", "accession"),
    E("assay", "assays", "name", "elisa pcr panel culture hplc titration cbc", "runtimeMin=10-720 wells=8-384", "draft validated retired", "automated", "define"),
  ], "test report:title findings;sop:title steps", "samples_in_queue turnaround_hrs instrument_uptime", "samples results instruments", "barcodeFormat autoRelease units", "release rerun archive", "technician reviewer"),
  D("trials", "TrialDesk,CohortCore,StudyPath,ProtoLog", [
    E("participant", "participants", "subjectId", "SUBJ-001 SUBJ-014 SUBJ-027 SUBJ-033 SUBJ-048 SUBJ-052", "visits=0-24 ageYears=18-85", "screening enrolled active withdrawn completed", "consented", "enroll"),
    E("site", "sites", "name", "boston lyon osaka toronto madrid perth", "enrolled=0-300 target=10-400", "pending activated closed", "paused", "activate"),
  ], "protocol amendment:title rationale;adverse event:summary details", "enrollment_rate screen_fail_rate queries_open", "enrollment visits queries", "blinding reminderDays dateFormat", "lock export notify", "investigator coordinator"),
  D("genomics", "SeqBench,GenoPipe,ReadDepth,VariantVault", [
    E("run", "runs", "flowcell", "FC-A17 FC-B22 FC-C09 FC-D41 FC-E03 FC-F58", "readsK=1000-900000 qScore=20-40", "queued sequencing demuxing done failed", "rerun", "start"),
    E("variant", "variants", "gene", "brca1 tp53 egfr kras apoe cftr", "depth=5-900 alleleFreq=0-100-1", "unreviewed benign uncertain pathogenic", "reportable", "annotate"),
  ], "variant note:title interpretation;run summary:title notes", "runs_active reads_per_sec align_rate", "runs variants coverage", "referenceBuild minDepth autoAnnotate", "requeue export tag", "bioinformatician reviewer"),
  D("journaling", "MoodLeaf,Calmpage,DailyMind,InnerLog", [
    E("entry", "entries", "title", "gratitude morning pages rough day small wins walk sleep", "mood=1-10 minutes=1-60", "draft saved archived", "private favorite", "write"),
    E("habit", "habits", "name", "breathing walk hydration reading stretch sleep", "streak=0-120", "active paused archived", "remind", "add"),
  ], "journal entry:title entry;reflection:prompt response", "entries_this_week avg_mood streak_days", "entries moods reminders", "dailyReminder passcodeLock moodScale", "archive tag export", "writer"),

  // ---- industry & built environment ----
  D("construction", "SiteBoard,BuildLog,CrewPlan,Groundwork", [
    E("rfi", "rfis", "subject", "beam spacing rebar detail door hardware slab elevation duct clash", "daysOpen=0-60 costImpact=0-90000", "open answered closed", "urgent", "submit"),
    E("punch", "punches", "item", "drywall crack paint touchup outlet cover loose rail tile chip", "floor=1-30", "open fixed verified", "safety", "add"),
  ], "daily log:summary weather;change order:title scope", "open_rfis crew_on_site schedule_slip", "rfis inspections deliveries", "units photoRequired weekStart", "assign close export", "superintendent subcontractor"),
  D("architecture", "DraftRoom,PlanSheet,Elevate,Blueline", [
    E("drawing", "drawings", "sheet", "A101 A201 S301 M401 E501 L601", "revision=0-20 scale=10-500", "wip review issued superseded", "locked", "add"),
    E("markup", "markups", "note", "dimension clash door swing window head stair rise grid line", "page=1-80", "open addressed closed", "client", "add"),
  ], "design brief:title brief;transmittal:title notes", "sheets_issued markups_open review_days", "drawings markups issues", "units titleBlock autoNumber", "issue supersede archive", "architect consultant"),
  D("manufacturing", "LineView,ShopFloor,WorkCell,Takt", [
    E("workorder", "workorders", "part", "bracket housing gear shaft flange spacer", "qty=10-5000 scrap=0-200", "released running paused complete", "rush", "release"),
    E("machine", "machines", "asset", "cnc1 cnc2 press4 lathe7 robot3 oven2", "oee=0-100 cycleSec=5-600", "running idle down setup", "maintenanceDue", "add"),
  ], "work instruction:title steps;shift report:summary issues", "oee units_per_hour scrap_rate downtime_min", "machines workorders alarms", "shiftLength units andonSound", "release hold close", "operator supervisor"),
  D("quality", "QualiCheck,DefectLog,AuditPath,Conformly", [
    E("inspection", "inspections", "lot", "LOT-2201 LOT-2210 LOT-2234 LOT-2251 LOT-2276 LOT-2290", "sampled=5-500 defects=0-40", "pending passed failed onhold", "critical", "start"),
    E("ncr", "ncrs", "title", "burr scratch misdrill porosity wrong label dent", "costUsd=0-50000", "open investigating dispositioned closed", "customerFacing", "raise"),
  ], "capa:title rootCause;audit finding:title details", "first_pass_yield ncr_open dppm", "inspections ncrs audits", "aqlLevel autoHold signatureRequired", "close escalate assign", "inspector engineer"),
  D("mining", "PitView,OreTrack,ShaftLog,HaulBoard", [
    E("haul", "hauls", "truck", "HT-01 HT-07 HT-12 HT-19 HT-23 HT-31", "tonnes=50-400 cycleMin=8-90", "loading hauling dumping returning", "overload", "dispatch"),
    E("blast", "blasts", "pattern", "bench4 north wall ramp pit east stope", "holes=10-400 depthM=5-30", "planned charged fired cleared", "misfire", "plan"),
  ], "shift handover:summary hazards;geology note:title notes", "tonnes_per_hour trucks_active grade_pct", "hauls blasts sensors", "units shiftStart exclusionAlerts", "dispatch hold close", "geologist operator"),
  D("oilgas", "Wellhead,FlowDesk,RigLog,Barrelwise", [
    E("well", "wells", "name", "eagle north delta basin ridge mesa canyon", "bopd=0-3000 pressurePsi=100-5000", "drilling producing shutin abandoned", "flagged", "add"),
    E("tank", "tanks", "label", "tk101 tk102 tk205 tk310 tk412 tk518", "levelPct=0-100 bbl=0-1000", "normal high low offline", "hauled", "add"),
  ], "well report:summary notes;job safety:title hazards", "bopd_total uptime_pct flare_mcf", "wells tanks alarms", "units alarmThreshold shiftStart", "shutin assign export", "pumper engineer"),

  // ---- transport ----
  D("ports", "Quayside,BerthBoard,DockMaster,HarborOps", [
    E("vessel", "vessels", "name", "aurora tide cape mercy blue heron pacific dawn iron gull", "teu=100-24000 draftM=5-17", "expected berthed working departed", "hazmat", "schedule"),
    E("container", "containers", "number", "ABCU1234 KLMU5520 QRSU7781 XYZU0042 PDTU3391 HNXU8820", "weightKg=2000-30000", "onvessel yard gated released", "reefer customsHold", "register"),
  ], "berth plan:title notes;stowage note:title details", "crane_moves_per_hour berth_util dwell_days", "vessels gates yard", "units tideAlerts gateHours", "release hold relocate", "stevedore planner"),
  D("airline", "FlightDeck Ops,CrewRoster,GateBoard,SkyOps", [
    E("flight", "flights", "number", "XA101 XA214 XA330 XA452 XA519 XA608", "pax=0-300 delayMin=0-240", "scheduled boarding departed arrived cancelled", "diverted", "add"),
    E("pairing", "pairings", "code", "P1021 P1188 P2045 P2310 P3002 P3471", "dutyHrs=2-14 legs=1-6", "draft published flown", "reserve", "build"),
  ], "ops note:title notes;delay report:summary cause", "on_time_pct load_factor delays_open", "flights gates crews", "timezone delayThreshold showCodeshare", "cancel delay swap", "dispatcher crew"),
  D("railways", "Trackside,RailGrid,SignalBox,Platformly", [
    E("train", "trains", "service", "1A04 2B17 3C22 4D09 5E31 6F45", "cars=2-16 lateMin=0-90", "scheduled running terminated cancelled", "diverted", "schedule"),
    E("defect", "defects", "location", "junction north tunnel bridge yard east crossing siding", "severity=1-5", "reported assessed repaired", "speedRestriction", "report"),
  ], "timetable note:title notes;incident log:summary actions", "ppm_punctuality trains_running speed_restrictions", "trains signals defects", "timezone platformAlerts timeFormat", "cancel reroute close", "signaller conductor"),
  D("transit", "TransitBoard,BusLine,FareFlow,StopWatch", [
    E("route", "routes", "name", "crosstown express harbor loop airport link north shuttle owl", "headwayMin=3-60 riders=0-9000", "active detour suspended", "accessible", "add"),
    E("stop", "stops", "code", "ST-101 ST-204 ST-318 ST-427 ST-552 ST-689", "waiting=0-80", "active relocated closed", "shelter", "add"),
  ], "service alert:title message;detour plan:title details", "on_time_rate buses_in_service ridership", "vehicles arrivals alerts", "timeFormat favoriteStop alertRadius", "detour suspend notify", "rider operator"),
  D("parking", "ParkSpot,LotLogic,MeterMate,Garagio", [
    E("session", "sessions", "plate", "ABC123 XKT442 LMN908 PRQ771 TUV305 JHD614", "minutes=5-720 fee=1-60-2", "active expired paid", "permit", "start"),
    E("zone", "zones", "name", "level north lot curbside visitor staff rooftop", "spaces=10-900 occupied=0-900", "open full closed", "evOnly", "add"),
  ], "citation note:title notes;rate card:title body", "occupancy_pct sessions_active revenue_today", "sessions zones citations", "currency graceMinutes plateReminders", "extend cite close", "driver attendant"),
  D("evcharging", "ChargeGrid,PlugPoint,VoltStop,AmpWay", [
    E("charger", "chargers", "label", "bay a1 a2 lot dc fast garage curb", "kw=7-350 queue=0-8", "available charging faulted offline", "reserved", "add"),
    E("session", "sessions", "vehicle", "sedan hatch suv van pickup coupe", "kwh=1-120-1 cost=1-80-2", "started charging finished interrupted", "idleFee", "start"),
  ], "site note:title notes;tariff:title body", "kw_delivered uptime_pct sessions_live", "chargers sessions faults", "currency maxKw idleAlerts", "reboot disable reset", "driver technician"),

  // ---- utilities & civic ----
  D("solar", "SunTrack,PanelPro,Irradia,RoofWatt", [
    E("install", "installs", "address", "14 birch ln 220 ocean dr 9 quarry rd 77 aspen way", "kw=3-40-1 panels=8-100", "survey design permitted installed active", "battery", "schedule"),
    E("inverter", "inverters", "serial", "INV-4401 INV-4415 INV-5520 INV-5602 INV-6718 INV-7033", "outputW=0-12000 tempC=10-70", "producing standby fault", "monitored", "register"),
  ], "site survey:title findings;proposal:title summary", "kwh_today fleet_output faults_open", "production inverters installs", "units exportLimit alertEmail", "assign schedule archive", "installer homeowner"),
  D("water", "AquaGrid,HydroDesk,MainLine,Wellspring", [
    E("leak", "leaks", "location", "elm main river crossing pump reservoir hill valve school", "lossLpm=1-900", "reported located repaired", "boilNotice", "report"),
    E("pump", "pumps", "station", "ps1 ps2 north booster west well river intake", "flowLps=0-500 pressureKpa=100-900", "running standby fault", "remote", "add"),
  ], "boil advisory:title message;work order:title details", "flow_mld pressure_avg nrw_pct", "pumps leaks quality", "units alarmLevel smsAlerts", "dispatch close notify", "operator crew"),
  D("waste", "BinRoute,TrashTrack,CleanCycle,Haulr", [
    E("pickup", "pickups", "address", "3 maple ct 18 lake rd 90 king st 41 fern ave", "bins=1-6 weightKg=5-900", "scheduled collected missed", "bulky", "schedule"),
    E("truck", "trucks", "unit", "rt01 rt04 rt09 rt12 rt17 rt22", "fillPct=0-100 stops=0-900", "onroute dumping garage", "recycling", "add"),
  ], "route sheet:title notes;missed report:summary details", "tonnes_today missed_pickups diversion_rate", "routes pickups trucks", "units pickupReminders holidayShift", "reschedule assign close", "driver resident"),
  D("city311", "CityFix,BlockFix,CivicLine,StreetDesk", [
    E("request", "requests", "issue", "pothole streetlight graffiti noise missed trash fallen tree", "upvotes=0-200 daysOpen=0-90", "new assigned inprogress closed", "duplicate", "submit"),
    E("crew", "crews", "name", "roads parks forestry lighting sanitation signals", "openJobs=0-60", "available busy offduty", "onCall", "add"),
  ], "request note:title notes;public update:title message", "requests_today median_close sla_breaches", "requests crews map", "language notifyByText ward", "assign close merge", "resident crew"),
  D("elections", "BallotBoard,PollBook,PrecinctPro,TallySheet", [
    E("precinct", "precincts", "name", "ward east hall library gym north annex center", "registered=200-9000 turnoutPct=0-100", "setup open closed certified", "reporting", "add"),
    E("ballot", "ballots", "batch", "B-001 B-014 B-027 B-033 B-046 B-058", "count=0-500", "received scanned verified adjudicated", "provisional", "log"),
  ], "procedure:title steps;canvass report:title summary", "turnout_pct ballots_scanned precincts_reporting", "precincts ballots results", "timezone language auditMode", "certify reconcile export", "clerk pollworker"),
  D("courts", "Docketly,CourtFile,BenchDesk,CaseCalendar", [
    E("filing", "filings", "caption", "motion to dismiss answer brief summons notice order", "pages=1-200 exhibits=0-40", "received accepted rejected docketed", "sealed", "file"),
    E("hearing", "hearings", "docket", "CV-2201 CR-1834 FM-0921 PR-4410 SC-7765 TR-3302", "durationMin=10-240 courtroom=1-20", "scheduled continued held vacated", "remote", "schedule"),
  ], "minute order:title body;judgment:title findings", "filings_today hearings_today backlog_days", "docket hearings filings", "timezone eFileNotices calendarView", "continue assign seal", "clerk attorney"),
  D("dispatch", "CallBoard,UnitTrack,DispatchDesk,ResponseGrid", [
    E("call", "calls", "type", "medical alarm fire traffic welfare check smoke", "priority=1-5 elapsedMin=0-120", "pending dispatched onscene cleared", "hazard", "create"),
    E("unit", "units", "callsign", "engine medic ladder rescue squad tanker", "etaMin=1-30", "available enroute onscene outofservice", "advancedLife", "add"),
  ], "incident narrative:summary narrative;shift brief:title notes", "calls_pending response_time units_available", "calls units map", "mapLayer soundAlerts autoRecommend", "assign clear close", "dispatcher responder"),

  // ---- education ----
  D("childcare", "Kidtrack,NapLog,DaycareDesk,TinySteps", [
    E("child", "children", "name", "ava noah mia leo zara theo", "ageMonths=6-72 naps=0-3", "absent checkedin checkedout", "allergy", "enroll"),
    E("activity", "activities", "kind", "snack nap diaper art outdoor reading", "minutes=5-120", "draft logged shared", "photo", "log"),
  ], "daily report:summary notes;incident form:title details", "children_present ratio_ok checkins_today", "checkins activities messages", "pickupCodes photoSharing quietHours", "checkout share notify", "parent teacher"),
  D("schooladmin", "SchoolDesk,Rollcall,Homeroom,CampusOps", [
    E("student", "students", "name", "kai lena omar priya sofia tomas", "grade=1-12 absences=0-30", "enrolled withdrawn graduated", "iep", "enroll"),
    E("absence", "absences", "reason", "sick appointment family travel unexcused late", "periods=1-8", "reported excused unexcused", "parentNotified", "record"),
  ], "newsletter:title body;behavior note:title details", "attendance_rate absences_today enrollment", "attendance roster bus", "termStart notifyParents gradingPeriod", "excuse notify export", "student guardian"),
  D("admissions", "AdmitFlow,ApplyHub,Gatekeeper,AdmitDesk", [
    E("applicant", "applicants", "name", "ortiz mensah fischer rao dubois kimura", "gpa=2-4-2 testScore=400-1600", "submitted reading admitted waitlisted denied", "firstGen", "add"),
    E("program", "programs", "name", "nursing physics economics design history engineering", "seats=10-600 applicants=0-9000", "draft open closed", "rolling", "create"),
  ], "reader comment:title comments;decision letter:title body", "apps_received admit_rate yield_pct", "applications decisions reviews", "decisionRelease readerBlind cycleYear", "admit deny waitlist", "reader applicant"),
  D("language", "LinguaLoop,WordWise,FluentPath,PhraseUp", [
    E("lesson", "lessons", "topic", "greetings food travel numbers family weather shopping", "xp=5-200 minutes=3-30", "locked available completed", "review", "start"),
    E("card", "cards", "word", "hola merci danke grazie obrigado arigato", "ease=1-5 dueDays=0-60", "new learning mature", "starred", "add"),
  ], "phrasebook:title phrases;essay:title body", "streak_days xp_today cards_due", "lessons reviews leaderboard", "targetLanguage dailyGoal speakingExercises", "reset suspend tag", "learner tutor"),

  // ---- work, services & retail ----
  D("recruiting", "TalentTrack,HireLoop,Shortlist,Candidly", [
    E("requisition", "requisitions", "title", "staff engineer account exec data analyst nurse manager warehouse lead", "openings=1-20 applicants=0-900", "draft open onhold filled", "confidential", "open"),
    E("interview", "interviews", "slot", "mon 9am tue 1pm wed 3pm thu 10am fri 2pm", "rating=1-5 panel=1-6", "scheduled done noshow cancelled", "onsite", "schedule"),
  ], "scorecard:summary notes;offer letter:title body", "time_to_fill pass_through offers_out", "pipeline interviews offers", "timezone anonymizeResumes calendarSync", "advance reject schedule", "recruiter candidate"),
  D("salon", "ChairTime,GlowBook,ShearDesk,Polished", [
    E("booking", "bookings", "service", "haircut color blowout manicure pedicure facial massage", "minutes=15-180 price=15-300-2", "booked confirmed checkedin done noshow", "firstVisit", "book"),
    E("stylist", "stylists", "name", "jade marco nia felix rosa yuki", "rating=3-5-1 chairs=1-3", "working break off", "acceptsWalkins", "add"),
  ], "client note:title notes;service menu:title body", "bookings_today utilization_pct avg_ticket", "bookings stylists waitlist", "depositRequired smsReminders bufferMinutes", "reschedule cancel remind", "client stylist"),
  D("pos", "TableTurn,TabRunner,OrderPad,Ticketline", [
    E("check", "checks", "table", "t1 t2 t5 t8 bar3 patio4 booth6", "guests=1-12 total=5-600-2", "open sent paid voided", "split", "open"),
    E("menuitem", "menuitems", "name", "burger fries caesar salmon tiramisu lemonade espresso", "price=2-60-2 prepMin=2-40", "available low eightysixed", "spicy", "add"),
  ], "kitchen note:title notes;daily special:title description", "covers_today ticket_time table_turns", "orders tables kitchen", "currency tipPresets autoGratuity", "void comp fire", "server cook"),
  D("printfarm", "LayerLab,PrintQueue,Filamently,NozzleNet", [
    E("job", "jobs", "file", "bracket gear vase enclosure hinge figurine clip", "grams=5-900 hours=1-48", "queued printing done failed", "priority", "queue"),
    E("printer", "printers", "name", "p01 p02 p03 large1 resin2 fast4", "nozzleC=180-300 progress=0-100", "idle printing paused error", "enclosed", "add"),
  ], "print profile:title params;failure note:title details", "printers_busy grams_today fail_rate", "jobs printers cameras", "units autoEject filamentAlerts", "cancel requeue archive", "operator maker"),
  D("dealership", "LotLine,DealerHub,Showroomly,DriveDeal", [
    E("vehicle", "vehicles", "model", "sedan coupe hatchback crossover pickup minivan", "price=8000-90000 miles=0-120000", "instock hold sold delivered", "certified", "add"),
    E("testdrive", "testdrives", "customer", "garcia nguyen schmidt okoro patel lambert", "minutes=10-60", "requested scheduled done cancelled", "trade", "book"),
  ], "deal sheet:title terms;vehicle description:headline description", "units_sold gross_per_unit days_on_lot", "inventory leads deals", "currency taxRate leadRouting", "markdown hold transfer", "salesperson buyer"),

  // ---- personal finance ----
  D("portfolio", "Holdings,StockLens,AssetView,Tickerboard", [
    E("holding", "holdings", "symbol", "abcx defy ghix jklm nopq rstu", "shares=1-900 costBasis=5-900-2", "open trimmed closed", "watch", "add"),
    E("alert", "alerts", "condition", "price above below drop volume spike earnings", "threshold=1-900-2", "armed triggered expired", "push", "create"),
  ], "thesis:title notes;quarter review:title summary", "day_change total_value unrealized_pl", "quotes holdings alerts", "currency darkChart showPercent", "export tag remove", "investor"),
  D("taxes", "TaxTrail,FileRight,ReturnDesk,Deductly", [
    E("deduction", "deductions", "category", "charity mortgage tuition medical childcare homeoffice", "amount=10-30000-2", "draft verified rejected", "receiptAttached", "add"),
    E("taxform", "taxforms", "name", "w2 1099 k1 schedulec schedulee form8949", "boxes=1-40", "missing uploaded reviewed", "corrected", "upload"),
  ], "return summary:title notes;cpa question:title body", "refund_estimate forms_missing days_to_deadline", "forms deductions estimates", "filingStatus taxYear stateReturn", "verify attach export", "filer preparer"),
  D("mortgage", "LoanPath,RateLock,ClosingTable,Escrowly", [
    E("application", "applications", "borrower", "rivera chen okafor muller singh blake", "loanAmount=50000-1500000 ratePct=2-9-2", "started submitted underwriting approved closed", "jumbo", "start"),
    E("condition", "conditions", "item", "paystub bank statement appraisal title insurance gift letter", "daysOpen=0-45", "outstanding received cleared", "priorToDoc", "add"),
  ], "underwriting note:title notes;explanation letter:title body", "pipeline_volume pull_through days_to_close", "applications conditions rates", "currency rateLockDays docReminders", "assign clear request", "borrower underwriter"),

  // ---- leisure & venues ----
  D("marina", "SlipBook,DockLine,Harborly,Moorage", [
    E("slip", "slips", "number", "a1 a2 b7 c12 d3 thead", "lengthFt=20-120 powerAmp=30-100", "vacant occupied reserved maintenance", "liveaboard", "assign"),
    E("boat", "boats", "name", "sea breeze blue moon wanderer osprey windfall second wind", "loaFt=15-110", "moored outbound haulout", "insured", "register"),
  ], "dockmaster log:title notes;rules:title body", "occupancy_pct transients_tonight fuel_gallons", "slips arrivals weather", "units tideAlerts fuelDockHours", "assign invoice notify", "boater dockhand"),
  D("skiresort", "SlopeSide,LiftLine,PowderDesk,Summitly", [
    E("lift", "lifts", "name", "eagle chair summit quad gondola magic carpet north tbar ridge express", "waitMin=0-45 windKph=0-90", "open hold closed", "heated", "add"),
    E("trail", "trails", "name", "bunny hill ridge run glade chute moguls cruiser", "groomedPct=0-100 lengthM=200-5000", "open groomed closed", "night", "add"),
  ], "snow report:title body;patrol log:title notes", "skier_visits lift_wait_avg base_depth", "lifts trails snow", "units webcamAutoplay powderAlerts", "open close groom", "skier patroller"),
  D("themepark", "ParkPulse,QueueQuest,FunGate,RideBoard", [
    E("attraction", "attractions", "name", "coaster log flume carousel dark ride drop tower teacups", "waitMin=0-180 capacity=10-2400", "operating delayed closed", "heightLimit", "add"),
    E("pass", "passes", "code", "GP-1101 GP-1189 GP-2250 GP-3307 GP-4412 GP-5520", "rides=0-30 price=20-300-2", "active scanned expired", "express", "buy"),
  ], "show schedule:title body;guest feedback:title comments", "attendance avg_wait rides_down", "waits shows passes", "parkHours mapView singleRider", "close reopen notify", "guest operator"),
  D("museum", "Gallerywise,ExhibitHub,CuratorDesk,TicketHall", [
    E("admission", "admissions", "slot", "10am 11am noon 2pm 3pm 4pm", "visitors=1-10 price=0-40-2", "reserved scanned refunded", "member", "book"),
    E("artwork", "artworks", "title", "harbor at dusk blue vessel study in red torso still life", "year=1500-2025 valueK=1-90000", "ondisplay storage onloan conservation", "featured", "catalog"),
  ], "wall label:title text;exhibit plan:title outline", "visitors_today capacity_used memberships_sold", "admissions galleries tours", "language accessibilityMode timedEntry", "move loan archive", "visitor curator"),
  D("cinema", "ReelSeat,Showreel,MarqueeBox,Projectr", [
    E("screening", "screenings", "film", "night heist lost orbit paper moon tidal city ember", "seatsSold=0-400 price=5-25-2", "scheduled onsale soldout cancelled", "premium", "schedule"),
    E("concession", "concessions", "item", "popcorn nachos soda candy pretzel hotdog", "price=2-20-2 stock=0-500", "available low soldout", "combo", "add"),
  ], "showtime note:title notes;film synopsis:title synopsis", "tickets_per_min occupancy_pct concession_sales", "showtimes seats concessions", "currency seatHold reclinerOnly", "cancel move refund", "moviegoer usher"),
  D("podcast", "CastHost,EpisodeKit,MicCheck,Airwave", [
    E("episode", "episodes", "title", "pilot interview deep dive listener mail roundtable bonus", "minutes=5-180 downloads=0-90000", "draft scheduled published unlisted", "explicit", "upload"),
    E("guest", "guests", "name", "ames kai rivers lin park omar fey june bell", "episodes=0-12", "invited confirmed recorded", "returning", "invite"),
  ], "show notes:title notes;episode script:title body", "downloads_today listeners avg_completion", "downloads episodes reviews", "rssPublic autoChapters introMusic", "publish unpublish schedule", "host listener"),
  D("esports", "BracketBoss,ClutchHQ,ScrimDesk,Arenaline", [
    E("tournament", "tournaments", "name", "spring open winter cup community clash pro invitational qualifiers", "teams=4-128 prizePool=0-90000", "registration live completed", "online", "create"),
    E("team", "teams", "tag", "nova apex ember drift titan vortex", "seed=1-64 wins=0-40", "registered checkedin eliminated", "verified", "register"),
  ], "rulebook:title rules;match recap:title body", "viewers_live matches_live checkins_pending", "brackets matches chat", "region bestOf spoilerMode", "advance disqualify seed", "player caster"),
  D("wedding", "VowBoard,AislePlan,GuestNest,DayOf", [
    E("guest", "guests", "name", "aunt rosa uncle li cousin max grandma jo friend sam", "partySize=1-6 table=1-40", "invited attending declined", "plusOne", "invite"),
    E("vendor", "vendors", "service", "florist caterer photographer band baker officiant", "quote=100-20000", "inquired booked paid", "depositPaid", "add"),
  ], "vows:title body;day timeline:title schedule", "rsvps_in budget_used days_left", "rsvps vendors tasks", "currency mealChoices rsvpDeadline", "remind seat export", "couple planner"),

  // ---- community & home ----
  D("volunteer", "ShiftHelp,GiveTime,PitchIn,RosterKind", [
    E("shift", "shifts", "role", "food bank park cleanup tutoring front desk driver sorting", "slots=1-40 filled=0-40", "open full cancelled", "remote", "post"),
    E("volunteer", "volunteers", "name", "abby chris dev ella femi gus", "hours=0-900", "applied active inactive", "backgroundCheck", "add"),
  ], "shift brief:title instructions;thank you note:title body", "hours_this_month fill_rate signups_today", "shifts signups checkins", "reminderHours waitlist minAge", "confirm remind cancel", "volunteer coordinator"),
  D("hoa", "HomeCourt,NeighborDesk,CommonsHQ,Covenant", [
    E("request", "requests", "subject", "pool gate fence approval parking tag lights out landscaping", "unit=1-400", "submitted review approved denied", "urgent", "submit"),
    E("assessment", "assessments", "unit", "u101 u102 u203 u305 u410 u512", "amount=50-2000-2 lateDays=0-90", "due paid late waived", "autopay", "issue"),
  ], "board minutes:title body;community notice:title message", "dues_collected open_requests reserve_pct", "requests dues notices", "currency lateFee voteReminders", "approve deny remind", "homeowner manager"),
  D("homeservices", "FixFlow,TruckRoll,HouseCall,Callout", [
    E("job", "jobs", "issue", "leaky faucet clogged drain pest inspection deep clean water heater move out", "estimate=50-3000-2 hours=1-12", "requested scheduled enroute onsite complete", "emergency", "book"),
    E("tech", "techs", "name", "andre bea carlos dina emre fatima", "jobsToday=0-8 rating=3-5-1", "available enroute busy off", "certified", "add"),
  ], "job notes:summary materials;quote:title scope", "jobs_today first_time_fix avg_drive_min", "jobs techs map", "serviceArea arrivalWindow smsUpdates", "dispatch reschedule invoice", "technician homeowner"),

  // ---- IT, security & data ----
  D("mdm", "DeviceFleet,EnrollPoint,Endpointly,KioskCtl", [
    E("device", "devices", "hostname", "mbp-ana ipad-lab3 win-fin02 pixel-qa kiosk-lobby mbp-ops7", "batteryPct=0-100 diskFreeGb=1-900", "enrolled pending noncompliant retired", "lost", "enroll"),
    E("profile", "profiles", "name", "wifi corp vpn baseline kiosk mode encryption passcode", "devices=0-9000", "draft deployed retired", "required", "create"),
  ], "policy:title rules;onboarding guide:title steps", "compliant_pct checkins_per_min os_outdated", "devices compliance commands", "osUpdateWindow autoLock remoteWipe", "lock restart retire", "admin employee"),
  D("secops", "Watchfloor,ThreatDesk,TriageSec,Bastion", [
    E("alert", "alerts", "rule", "impossible travel brute force malware hash new admin port scan data exfil", "severity=1-5 hosts=1-90", "new investigating escalated closed", "falsePositive", "create"),
    E("investigation", "investigations", "title", "phish wave vpn anomaly rogue device token leak", "alerts=1-200", "open contained resolved", "legalHold", "open"),
  ], "incident report:summary timeline;playbook:title steps", "alerts_per_min mttd mttr open_cases", "alerts cases intel", "severityFloor autoClose pagerHours", "assign close suppress", "analyst responder"),
  D("observability", "TraceView,LogLens,SpanScope,Metricly", [
    E("monitor", "monitors", "name", "checkout latency api errors queue depth disk usage cert expiry", "threshold=1-5000 evalSec=10-600", "ok warn alert nodata", "muted", "create"),
    E("trace", "traces", "operation", "get users post order auth login search query cache miss", "durationMs=1-9000 spans=1-400", "ok slow error", "sampled", "capture"),
  ], "slo doc:title objective;alert runbook:title steps", "error_budget p99_latency log_volume active_alerts", "logs traces alerts", "retentionDays timezone liveTail", "mute unmute delete", "sre developer"),
  D("featureflags", "FlagPole,ToggleBox,Rollout,Switchboard", [
    E("flag", "flags", "flagKey", "new checkout dark mode beta search fast path api", "rolloutPct=0-100 rules=0-12", "off rolling on archived", "permanent", "create"),
    E("segment", "segments", "name", "internal staff beta testers enterprise eu users mobile", "size=1-900000", "active stale archived", "dynamic", "create"),
  ], "flag description:title description;release note:title body", "evaluations_per_sec stale_flags rollouts_active", "flags rollouts audit", "environment requireApproval staleDays", "enable disable archive", "developer approver"),
  D("datawarehouse", "QueryForge,TableYard,ETLine,LakeDesk", [
    E("job", "jobs", "name", "nightly orders sync clicks rollup user dim revenue mart", "rowsK=1-90000 runtimeMin=1-240", "queued running succeeded failed", "critical", "schedule"),
    E("table", "tables", "name", "fact orders dim users events raw stg payments", "sizeGb=1-9000 freshnessHr=0-72", "fresh stale broken", "pii", "register"),
  ], "model doc:title description;sql snippet:name sql", "credits_used queue_depth failed_jobs freshness_sla", "jobs tables lineage", "warehouseSize timezone autoSuspend", "rerun pause tag", "engineer analyst"),
  D("mlops", "ExperimentHub,ModelYard,TrainTrack,EvalDesk", [
    E("experiment", "experiments", "name", "baseline sweep bigger batch dropout ablation distill", "accuracy=40-99-2 epochs=1-200", "queued running finished crashed", "starred", "launch"),
    E("model", "models", "version", "classifier ranker embedder detector tagger scorer", "paramsM=1-900 latencyMs=1-900", "staging production archived", "approved", "register"),
  ], "experiment note:title findings;model card:title description", "gpus_busy runs_active eval_loss", "runs metrics artifacts", "defaultProject smoothing autoCompare", "tag archive compare", "researcher reviewer"),
  D("labeling", "LabelDesk,TagForge,Annotato,BoxDraw", [
    E("batch", "batches", "name", "street scenes receipts tweets xrays support chats product photos", "items=10-90000 donePct=0-100", "draft active review done", "goldSet", "create"),
    E("annotation", "annotations", "label", "car person sign positive negative spam invoice", "confidence=0-100 seconds=1-300", "pending accepted rejected", "disputed", "submit"),
  ], "guidelines:title rules;reviewer note:title notes", "labels_per_hour agreement_pct backlog", "queue labels reviews", "hotkeys autoAdvance consensusN", "accept reject reassign", "annotator reviewer"),

  // ---- language, legal & IP ----
  D("translation", "LinguaDesk,WordBridge,LocalizeHub,ParaText", [
    E("job", "jobs", "file", "app strings help center legal terms marketing site release notes", "words=50-90000 dueDays=0-30", "new translating review delivered", "rush", "order"),
    E("segment", "segments", "source", "welcome back save changes sign out try again cancel", "matchPct=0-100", "untranslated draft approved", "locked", "add"),
  ], "glossary:term definition;style guide:title body", "words_per_day tm_leverage jobs_late", "jobs segments comments", "targetLocales machineDraft qaChecks", "assign approve export", "translator reviewer"),
  D("ediscovery", "DocReview,Custodia,PrivLog,HoldFast", [
    E("custodian", "custodians", "name", "finance vp sales lead it admin cfo office hr director ops manager", "itemsK=1-900", "identified notified collected released", "legalHold", "add"),
    E("document", "documents", "control", "DOC-00011 DOC-00342 DOC-01020 DOC-02210 DOC-05519 DOC-09001", "pages=1-400 relevance=0-100", "unreviewed responsive nonresponsive privileged", "hot", "tag"),
  ], "privilege log:title entries;review protocol:title steps", "docs_reviewed_per_hour responsive_rate backlog", "review holds productions", "batchSize redactionColor dedupe", "tag produce redact", "reviewer counsel"),
  D("patents", "ClaimDraft,PriorArt,PatentPath,IPDocket", [
    E("application", "applications", "title", "folding hinge battery cell sensor array gripper valve lens", "claims=1-60 monthsPending=0-60", "drafting filed examination allowed abandoned", "foreign", "file"),
    E("deadline", "deadlines", "action", "office response annuity ids filing continuation appeal brief", "daysLeft=0-180", "upcoming done missed", "extendable", "docket"),
  ], "claim set:title claims;office action response:title arguments", "apps_pending deadlines_week allowance_rate", "docket filings citations", "jurisdiction reminderDays feeCurrency", "assign extend close", "attorney inventor"),

  // ---- hobbies ----
  D("gardening", "Plotline,SeedBook,BedPlan,Sproutly", [
    E("plant", "plants", "variety", "tomato basil kale pepper zucchini lavender carrot", "daysToHarvest=30-120 heightCm=5-200", "seeded sprouted growing harvested", "perennial", "plant"),
    E("chore", "chores", "task", "water weed prune mulch fertilize harvest compost", "minutes=5-120", "due done skipped", "recurring", "add"),
  ], "garden journal:title entry;bed plan:title layout", "tasks_due rain_mm harvest_kg", "plants tasks weather", "units frostDate hardinessZone", "complete snooze delete", "gardener"),
  D("genealogy", "RootBook,KinTree,LineageLab,FamilyLines", [
    E("person", "people", "name", "eliza hart thomas reed mary quinn john ashby ruth lowe", "birthYear=1700-2020 sources=0-30", "living deceased unknown", "private", "add"),
    E("record", "records", "title", "census baptism ship manifest marriage will obituary", "year=1700-2000", "unreviewed attached rejected", "verified", "attach"),
  ], "biography:title body;research log:title notes", "people_count sources_attached hints_new", "tree hints records", "dateFormat livingPrivacy nameOrder", "merge attach export", "researcher relative"),
];
