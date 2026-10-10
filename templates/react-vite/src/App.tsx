// A search box written the way a lot of code is: every keystroke fetches, and whichever answer arrives last wins.
// The mock API answers in a random 50-900 ms, so type quickly and an older answer can overwrite a newer one.
// GenClass watches this with no code here: open the overlay (bottom right, development only) to see what it finds.
import { useEffect, useState } from "react";

export default function App() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<string[]>([]);

  useEffect(() => {
    if (!q) return setResults([]);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((r: { results: string[] }) => setResults(r.results));
  }, [q]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 520, margin: "48px auto", padding: "0 16px" }}>
      <h1>GenClass + React</h1>
      <p>Type a city quickly, for example “san”, then look at the GenClass overlay.</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cities" autoFocus style={{ width: "100%", padding: 8, fontSize: 16 }} />
      <ul>
        {results.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </main>
  );
}
