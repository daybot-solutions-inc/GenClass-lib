import type { AppManifest } from "../../src/shared/manifest.js";

const refs: [string, string, string, number, string, string, string[]][] = [
  ["Attention Is All You Need", "Vaswani, Shazeer, Parmar", "NeurIPS", 2017, "10.5555/3295222.3295349", "mlsys", ["classic"]],
  ["Designing Calm Technology", "Weiser, Brown", "PowerGrid Journal", 1996, "10.1000/calm.1996.01", "hci", []],
  ["Efficient Memory Management for LLM Serving", "Kwon, Li, Zhuang", "SOSP", 2023, "10.1145/3600006.3613165", "mlsys", ["serving"]],
  ["The Tail at Scale", "Dean, Barroso", "CACM", 2013, "10.1145/2408776.2408794", "thesis", ["latency", "classic"]],
  ["Flaky Tests in Continuous Integration", "Luo, Hariri, Eloussi", "FSE", 2014, "10.1145/2635868.2635920", "thesis", []],
  ["Notifications and Interruptions on Phones", "Pielot, Church, de Oliveira", "MobileHCI", 2014, "10.1145/2628363.2628364", "hci", ["survey"]],
  ["Spanner: Globally Distributed Database", "Corbett, Dean, Epstein", "OSDI", 2012, "10.5555/2387880.2387905", "reading", ["databases"]],
  ["Retrieval-Augmented Generation", "Lewis, Perez, Piktus", "NeurIPS", 2020, "10.5555/3495724.3496517", "mlsys", []],
  ["Time, Clocks, and the Ordering of Events", "Lamport", "CACM", 1978, "10.1145/359545.359563", "thesis", ["classic"]],
  ["Dark Patterns at Scale", "Mathur, Acar, Friedman", "CSCW", 2019, "10.1145/3359183", "hci", []],
  ["Raft: Understandable Consensus", "Ongaro, Ousterhout", "USENIX ATC", 2014, "10.5555/2643634.2643666", "reading", ["consensus"]],
  ["Optimistic Replication", "Saito, Shapiro", "ACM Computing Surveys", 2005, "10.1145/1057977.1057980", "thesis", ["survey"]],
  ["Scaling Laws for Neural Language Models", "Kaplan, McCandlish, Henighan", "arXiv", 2020, "10.48550/arXiv.2001.08361", "mlsys", []],
  ["What Makes a Good Commit Message", "Tian, Zhang, Stol", "ICSE", 2022, "10.1145/3510003.3510205", "reading", []],
  ["Conflict-free Replicated Data Types", "Shapiro, Preguiça, Baquero", "SSS", 2011, "10.1007/978-3-642-24550-3_29", "thesis", ["crdt"]],
  ["Accessible Web Forms in Practice", "Lazar, Allen, Kleinman", "ASSETS", 2007, "10.1145/1296843.1296870", "hci", []],
  ["Kafka: a Distributed Messaging System", "Kreps, Narkhede, Rao", "NetDB", 2011, "10.1000/netdb.2011.kafka", "reading", ["streaming"]],
  ["Mixture of Experts Revisited", "Fedus, Zoph, Shazeer", "JMLR", 2022, "10.5555/3586589.3586709", "mlsys", []],
  ["Why Do Computers Stop", "Gray", "Tandem TR", 1985, "10.1000/tandem.85.7", "reading", ["classic"]],
  ["Usability of Error Messages", "Becker, Denny, Pettit", "CHI", 2019, "10.1145/3290605.3300300", "hci", []],
];
const papers = refs.map(([title, authors, venue, year, doi, collection, tags], i) => ({
  id: 3100 + i,
  title,
  authors,
  venue,
  year,
  doi,
  collection,
  tags,
  starred: i % 4 === 1,
  createdAt: new Date(Date.UTC(2026, 2, 30, 18, 0) - i * 3 * 3600000).toISOString(),
}));

const manifest: AppManifest = {
  name: "vue-citations",
  title: "Lab library",
  framework: "vue",
  libs: ["vue", "@tanstack/vue-query", "useInfiniteQuery(cursor)", "axios", "rt.guard", "rt.atom"],
  domain: "reference-manager",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: {
    base: "/api",
    collections: [
      { name: "papers", seed: papers, versioned: true, envelope: "items", pageSize: 6, unique: ["doi"], required: ["doi", "title"], actions: { star: { toggle: "starred" } } },
    ],
  },
  variants: {
    star: ["pending-lock", "none"],
    pages: ["reset-on-filter", "keep"],
    tags: ["if-match", "force"],
    addGuard: ["pending", "none"],
    afterAdd: ["set-query-data", "refetch-all"],
  },
  affordances: [
    { id: "star", kind: "click", sel: "article.paper button.star", nth: 6, intent: "nth", weight: 3.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.15, requires: "article.paper button.star:not([disabled])" },
    { id: "more", kind: "click", sel: "button.more", weight: 1.8, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "button.more:not([disabled])" },
    { id: "collection", kind: "check", sel: "fieldset.collections input[type=checkbox]", nth: 4, intent: "nth", weight: 1.5, mode: "accumulate" },
    { id: "editTags", kind: "click", sel: "article.paper button.edit-tags", nth: 6, intent: "nth", weight: 1.4, mode: "replace", key: "editTags" },
    { id: "tag", kind: "type", sel: "form.tags input[name=tag]", values: ["to-read", "survey", "replication", "baseline", "chapter-3"], clear: true, weight: 2, mode: "replace", after: ["editTags"], requires: "form.tags input[name=tag]", then: ["addTag"] },
    { id: "addTag", kind: "click", sel: "form.tags button.add-tag", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.1 },
    { id: "removeTag", kind: "click", sel: "form.tags button.remove-tag", nth: 2, intent: "nth", weight: 0.7, mode: "accumulate", after: ["editTags"], requires: "form.tags button.remove-tag" },
    { id: "doi", kind: "type", sel: "form.add input[name=doi]", values: ["10.48550/2310.06825", "10.1145/3613904", "10.1145/3359183", "10.1109/MS.2024.3", "10.1145/3620665"], clear: true, weight: 0.7, mode: "replace", then: ["title", "addPaper"] },
    { id: "title", kind: "type", sel: "form.add input[name=title]", values: ["Mistral 7B", "Calm Alerts", "Flaky CI", "Sparse MoE"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "addPaper", kind: "click", sel: "form.add button.add-paper", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.25 },
  ],
  external: [
    // lab mates curating the same library
    { kind: "update", target: "papers", perMin: 2, data: [{ tags: ["survey", "classic"] }, { tags: ["to-read"] }, { tags: ["baseline", "replication"] }, { tags: [] }] },
    { kind: "action", target: "papers", perMin: 0.8, verb: "star" },
    {
      kind: "create",
      target: "papers",
      perMin: 0.8,
      data: [
        { title: "Llama 2: Open Foundation Models", authors: "Touvron, Martin, Stone", venue: "arXiv", year: 2023, doi: "10.48550/arXiv.2307.09288", collection: "mlsys", tags: [], starred: false },
        { title: "Local-First Software", authors: "Kleppmann, Wiggins, van Hardenberg", venue: "Onward!", year: 2019, doi: "10.1145/3359591.3359737", collection: "thesis", tags: ["crdt"], starred: false },
        { title: "Interruptions at Work", authors: "Mark, Gudith, Klocke", venue: "CHI", year: 2008, doi: "10.1145/1357054.1357072", collection: "hci", tags: [], starred: false },
      ],
    },
  ],
  weights: { "ui.error": 0, "ui.notice": 0, "ui.doi": 0.3, "ui.title": 0.3, "ui.tag": 0.3, "ui.collection": 0.3, "ui.editing": 0.5, "ui.collections": 0.5, "library.pageParams": 0 },
  relations: [
    {
      name: "no paper listed twice",
      fields: ["library.pages"],
      check: (s) => {
        const ids = (s.library?.pages ?? []).flatMap((p: { items: { id: number }[] }) => p.items.map((x) => x.id));
        return new Set(ids).size === ids.length;
      },
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
