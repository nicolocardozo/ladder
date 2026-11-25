import type { NextConfig } from "next";

const RELEASES = "https://github.com/nicolocardozo/ladder-releases/releases/latest/download"

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The download links (lib/site.ts DOWNLOADS) point to the latest DMG published in the ladder-releases releases.
  // GitHub serves it as an attachment, so the download starts without leaving the page.
  async redirects() {
    return [
      { source: "/download", destination: `${RELEASES}/Ladder-arm64.dmg`, permanent: false },
      { source: "/download/apple-silicon", destination: `${RELEASES}/Ladder-arm64.dmg`, permanent: false },
      { source: "/download/intel", destination: `${RELEASES}/Ladder-x64.dmg`, permanent: false },
    ]
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
