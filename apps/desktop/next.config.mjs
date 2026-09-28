import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const nextConfig = {
  output: "export",
  trailingSlash: true,
  turbopack: { root: workspaceRoot },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
