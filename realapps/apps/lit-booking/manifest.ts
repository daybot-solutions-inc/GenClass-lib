import type { AppManifest } from "../../src/shared/manifest.js";

const rooms = ["atlas", "borealis", "cygnus"];
const days = ["mon", "tue", "wed", "thu", "fri"];
const times = ["09:00", "11:00", "14:00", "16:00"];
const people = ["Priya", "Marco", "Ines", "Tomás", "Hana"];
const slots: Record<string, unknown>[] = [];
let n = 0;
for (const room of rooms)
  for (const day of days)
    for (const time of times) {
      const taken = (n * 7 + 3) % 5 < 2;
      slots.push({ id: 6000 + n, room, day, time, status: taken ? "booked" : "free", bookedBy: taken ? people[n % people.length] : "", version: 1 });
      n++;
    }

const manifest: AppManifest = {
  name: "lit-booking",
  title: "Room booking",
  framework: "lit",
  libs: ["lit", "fetch", "rt.atom(reactive controller)"],
  domain: "scheduling",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "slots", seed: slots, versioned: true, filters: ["room", "day", "status"], envelope: "bare", pageSize: 60 }],
  },
  variants: {
    booking: ["pessimistic", "optimistic", "optimistic-rollback", "optimistic"],
    bookGuard: [true, false],
    pollMerge: ["keep-pending", "replace"],
    counts: ["derive", "incremental"],
    pollMs: [4000, 2000, 8000],
  },
  affordances: [
    { id: "book", kind: "click", sel: "booking-app >>> slot-grid >>> button.book", nth: 4, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.25, impatientP: 0.3 },
    { id: "day", kind: "click", sel: "booking-app >>> nav.days button.day", nth: 5, weight: 2.2, mode: "replace" },
    { id: "room", kind: "click", sel: "booking-app >>> nav.rooms button.room", text: ["Atlas", "Borealis", "Cygnus"], weight: 1.2, mode: "replace" },
    { id: "cancel", kind: "click", sel: "booking-app >>> button.cancel", nth: 3, weight: 1, mode: "accumulate", intent: "nth", after: ["book"], dblclickP: 0.15 },
    { id: "refresh", kind: "click", sel: "booking-app >>> button.refresh", weight: 0.6, mode: "replace", dblclickP: 0.1 },
  ],
  external: [
    {
      kind: "update",
      target: "slots",
      perMin: 9,
      data: [
        { status: "booked", bookedBy: "Priya" },
        { status: "booked", bookedBy: "Marco" },
        { status: "booked", bookedBy: "Hana" },
        { status: "free", bookedBy: "" },
      ],
    },
  ],
  weights: { "cal.loading": 0.1, "cal.error": 0, "cal.day": 0.3, "cal.room": 0.3 },
  relations: [
    {
      name: "free count per day == free slots that day",
      fields: ["cal.freeByDay", "cal.slots"],
      check: (s) => !s.cal || s.cal.loading || ["mon", "tue", "wed", "thu", "fri"].every((d) => s.cal.freeByDay[d] === s.cal.slots.filter((x: { day: string; status: string }) => x.day === d && x.status === "free").length),
    },
  ],
  sessionMs: [25000, 70000],
};
export default manifest;
