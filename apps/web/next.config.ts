import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile the shared workspace package
  transpilePackages: ["@crucible/shared"],

  // Ensure server-only env vars are never bundled into the client
  // NEXT_PUBLIC_* is the only safe surface for the browser
  serverExternalPackages: [],
};

export default nextConfig;
