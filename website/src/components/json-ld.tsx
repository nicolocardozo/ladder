import { SITE } from "@/lib/site"

// Dati strutturati SoftwareApplication + Organization, resi sul server
export function JsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE.url}/#organization`,
        name: SITE.name,
        url: SITE.url,
        logo: `${SITE.url}/brand/ladder-mark-black.svg`,
        sameAs: [SITE.githubUrl],
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE.url}/#app`,
        name: SITE.name,
        description: SITE.description,
        url: SITE.url,
        downloadUrl: SITE.downloadUrl,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS",
        // TODO: prezzo segnaposto, da confermare
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": `${SITE.url}/#organization` },
      },
    ],
  }

  return (
    <script
      type="application/ld+json"
      // Il JSON è costruito da costanti nostre, nessun input utente
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  )
}
