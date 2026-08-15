import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const controlApiOrigin = process.env.CONTROL_API_ORIGIN || "http://127.0.0.1:8080";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: appDirectory,
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${controlApiOrigin}/api/v1/:path*`
      }
    ];
  }
};

export default nextConfig;
