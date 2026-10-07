"""Per-row app instance: names for stores/fields/routes/buttons derived from a vocab.Domain, plus value summaries."""

from __future__ import annotations

import random
import string

from vocab import Domain, plural


def _words(s: str) -> list[str]:
    return s.replace("-", " ").replace("_", " ").split()


class App:
    def __init__(self, rng: random.Random, dom: Domain):
        self.rng = rng
        self.dom = dom
        self.title = rng.choice(dom.titles)
        self.camel = rng.random() < 0.6
        nouns = list(dom.nouns)
        rng.shuffle(nouns)
        self.noun, self.noun2 = nouns[0], nouns[1]
        self.api = rng.choice(("/api", "/api", "/api/v1", "/api/v2", "/v1", "/rest"))
        self.id_style = rng.choice(("num", "num", "uuid", "slug", "prefixed"))
        self.text_field = rng.choice(dom.texts)
        self.num_fields = list(dom.nums)

    # ------------------------------------------------------------------ names
    def ident(self, s: str) -> str:
        w = _words(s)
        if self.camel:
            return w[0].lower() + "".join(x.capitalize() for x in w[1:])
        return "_".join(x.lower() for x in w)

    def url_word(self, s: str) -> str:
        return "-".join(_words(s)).lower()

    @property
    def coll(self) -> str:  # collection store name, e.g. "orders" / "lineItems"
        return self.ident(plural(self.noun))

    @property
    def item(self) -> str:
        return self.ident(self.noun)

    def coll_url(self, noun: str | None = None) -> str:
        return f"{self.api}/{self.url_word(plural(noun or self.noun))}"

    def new_id(self) -> str:
        r = self.rng
        if self.id_style == "num":
            return str(r.randint(2, 99999))
        if self.id_style == "uuid":
            return "".join(r.choice("0123456789abcdef") for _ in range(8)) + "-" + \
                "".join(r.choice("0123456789abcdef") for _ in range(4))
        if self.id_style == "slug":
            return self.url_word(r.choice(self.dom.titles)) + "-" + str(r.randint(2, 999))
        return f"{self.noun[:2].lower()}_{r.randint(100, 99999)}"

    def item_url(self, id_: str, noun: str | None = None) -> tuple[str, str]:
        base = self.coll_url(noun)
        return f"{base}/{id_}", f"{base}/:id"

    def button(self) -> str:
        lab = self.rng.choice(self.dom.buttons)
        r = self.rng.random()
        if r < 0.45:
            return f'button "{lab}"'
        if r < 0.75:
            return "#" + self.url_word(lab)
        return f'"{lab}"'

    def input_target(self) -> str:
        return self.rng.choice(("#search", "#query", "#filter", "input[name=q]", "#find"))

    def route(self) -> str:
        r = self.rng.random()
        if r < 0.4:
            return "/" + self.url_word(plural(self.noun))
        if r < 0.7:
            return f"/{self.url_word(plural(self.noun))}/{self.new_id()}"
        return "/" + self.rng.choice(("dashboard", "home", "app", "workspace", "inbox", "overview"))

    def app_line(self) -> str:
        r = self.rng.random()
        route = self.route()
        if r < 0.5:
            return f"{self.title} — {route}"
        if r < 0.8:
            return f"{self.title} ({self.dom.key}) at {route}"
        return f"{self.title}, route {route}"

    # ------------------------------------------------------------------ values
    def word(self) -> str:
        return self.rng.choice(("alpha", "nova", "delta", "harbor", "maple", "orbit", "summit", "lotus", "cobalt",
                                "ember", "fjord", "garnet", "juniper", "kestrel", "lumen", "meadow", "onyx", "prairie",
                                "quartz", "raven", "sierra", "tundra", "umber", "willow", "zephyr"))

    def query_prefixes(self) -> list[str]:
        w = self.rng.choice(("react", "invoice", "berlin", "summer", "pending", "kitchen", "garden", "march", "laptop",
                             "jazz", "refund", "travel", "python", "coffee", "blue", "urgent", "weekly", "review"))
        k = self.rng.randint(2, 3)
        return [w[:i] for i in range(k, len(w) + 1)]

    def list_summary(self, n: int) -> str:
        if n == 0:
            return "[] (empty)"
        tf = self.ident(self.text_field)
        ex = f'{{id: {self.new_id()}, {tf}: "{self.word().capitalize()}"}}'
        return f"{n} items [{ex}, …]" if n > 1 else f"1 item [{ex}]"

    def num_value(self, spec: tuple) -> float:
        _, lo, hi, dec = spec
        x = self.rng.uniform(lo, hi)
        return round(x, dec) if dec else float(int(x))

    def fmt_num(self, x: float, dec: int) -> str:
        return f"{x:.{dec}f}" if dec else str(int(x))

    def body(self) -> str:
        spec = self.rng.choice(self.num_fields)
        k = self.ident(spec[0])
        v = self.fmt_num(self.num_value(spec), spec[3])
        if self.rng.random() < 0.5:
            return f'{{"{self.item}Id":"{self.new_id()}","{k}":{v}}}'
        return f'{{"{k}":{v}}}'


def rand_token(rng: random.Random, n: int = 8) -> str:
    return "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(n))
