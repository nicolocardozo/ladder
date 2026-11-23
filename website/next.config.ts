import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Il pulsante Download punta qui: rimanda all'ultimo DMG pubblicato nelle release di ladder-releases.
  // GitHub lo serve come allegato, quindi il download parte senza lasciare la pagina.
  async redirects() {
    return [
      {
        source: "/download",
        destination: "https://github.com/nicolocardozo/ladder-releases/releases/latest/download/Ladder-arm64.dmg",
        permanent: false,
      },
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
