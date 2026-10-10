import Search from "./search";

export default function Page() {
  return (
    <main style={{ maxWidth: 520, margin: "48px auto", padding: "0 16px" }}>
      <h1>GenClass + Next.js</h1>
      <p>Type a city quickly, for example “san”, then look at the GenClass overlay.</p>
      <Search />
    </main>
  );
}
