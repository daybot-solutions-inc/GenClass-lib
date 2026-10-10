// Server component: renders the compat page for ?layer=&s= on the server (SSR), then the client components hydrate.
import Compat from "./_compat/compat";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined, d: string) => (typeof v === "string" ? v : d);
  return <Compat layer={one(sp.layer, "state")} s={one(sp.s, "h")} />;
}
