import type { NextConfig } from "next";

const RELEASES = "https://github.com/nicolocardozo/ladder-releases/releases/latest/download"

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // I link di download (lib/site.ts DOWNLOADS) rimandano all'ultimo DMG pubblicato nelle release di ladder-releases.
  // GitHub lo serve come allegato, quindi il download parte senza lasciare la pagina.
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
