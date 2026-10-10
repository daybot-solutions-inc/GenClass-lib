"use client";
// A search box written the way a lot of code is: every keystroke fetches, and whichever answer arrives last wins.
// The API route answers in a random 50-900 ms, so type quickly and an older answer can overwrite a newer one.
// GenClass watches this with no code here: open the overlay (bottom right, development only) to see what it finds.
import { useEffect, useState } from "react";

export default function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<string[]>([]);

  useEffect(() => {
    if (!q) return setResults([]);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((r: { results: string[] }) => setResults(r.results));
  }, [q]);

  return (
    <>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cities" autoFocus style={{ width: "100%", padding: 8, fontSize: 16 }} />
      <ul>
        {results.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </>
  );
}
