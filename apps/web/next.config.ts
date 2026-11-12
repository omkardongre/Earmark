import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server for the container image (apps/web/Dockerfile); tracing starts at the
  // workspace root so pnpm's linked packages are included.
  output: "standalone",
  // Firestore's gRPC client doesn't bundle; load it from node_modules (lib/store.ts).
  serverExternalPackages: ["@google-cloud/firestore"],
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};

export default nextConfig;
