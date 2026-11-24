/**
 * One table for both sides of the url keys (ENGINE-GET-ASK-1123): the unit suite checks the JS
 * (`companyDomainOf`, `pageKeyOf`, `normalizeUrl`), the integration suite checks the SQL twins
 * (`companyDomainSql`, `pageKeySql`) return the same values in Postgres.
 */
export const URL_KEY_CASES: { url: string; domain: string | null; pageKey: string }[] = [
  { url: "https://acme.com", domain: "acme.com", pageKey: "acme.com" },
  { url: "https://acme.com/", domain: "acme.com", pageKey: "acme.com" },
  { url: "https://www.Acme.com/About/", domain: "acme.com", pageKey: "acme.com/about" },
  { url: "http://acme.com/pricing?utm=x#top", domain: "acme.com", pageKey: "acme.com/pricing" },
  { url: "https://acme.com:8443/pricing", domain: "acme.com", pageKey: "acme.com/pricing" },
  { url: "https://acme.com:8443", domain: "acme.com", pageKey: "acme.com" },
  { url: "https://blog.acme.co.uk/a/b", domain: "blog.acme.co.uk", pageKey: "blog.acme.co.uk/a/b" },
  { url: "https://acme.com?ref=1", domain: "acme.com", pageKey: "acme.com" },
  { url: "https://acme.com/#team", domain: "acme.com", pageKey: "acme.com" },
  { url: "https://wwwacme.com/www.x", domain: "wwwacme.com", pageKey: "wwwacme.com/www.x" },
  { url: "https://my-site.io/a:1/b", domain: "my-site.io", pageKey: "my-site.io/a:1/b" },
  // no usable company domain: an IP, a bare host
  { url: "http://127.0.0.1:3000/health", domain: null, pageKey: "127.0.0.1/health" },
  { url: "http://localhost/x", domain: null, pageKey: "localhost/x" },
];
