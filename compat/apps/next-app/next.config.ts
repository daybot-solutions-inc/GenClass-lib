import type { NextConfig } from "next";

// create-next-app 16.4 also turns on cacheComponents / partialPrefetching; this page renders per request from
// ?layer=&s= (dynamic searchParams), so they are left off. Type errors are not what this matrix measures.
const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
