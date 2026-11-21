// What collectPage() should make of formats.html, for a page served from `origin`.
// Shared by the browser harness check and the Firefox smoke test.
export function expectedFormats(origin) {
  const page = `${origin}/test/fixtures/formats.html`;
  return {
    microdata: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', item: `${origin}/`, name: 'Home', position: '1' },
          { '@type': 'ListItem', item: `${origin}/news/`, name: 'News', position: '2' },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Product',
        '@id': `${page}#wallet`,
        name: 'Classic Wallet',
        image: [`${origin}/img/a.jpg`, `${origin}/img/b.jpg`],
        logo: `${origin}/extension/icons/icon.svg`,
        offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'GBP', availability: 'https://schema.org/InStock' },
        releaseDate: '2026-01-05',
        brand: 'Northfold',
      },
    ],
    rdfa: [
      {
        '@context': 'https://schema.org',
        '@type': 'Person',
        '@id': `${page}#sam`,
        name: 'Sam Field',
        url: `${origin}/people/sam`,
        birthDate: '1990-04-02',
        address: { '@type': 'PostalAddress', addressLocality: 'Leeds', addressCountry: 'GB' },
        knowsLanguage: ['English', 'French'],
      },
      {
        '@context': 'https://schema.org',
        '@type': ['Event', 'http://example.com/ns#Gig'],
        name: 'Launch night',
        startDate: '2026-12-04T18:00',
      },
    ],
  };
}
