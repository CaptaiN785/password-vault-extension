// Entries are matched on the registrable domain, so accounts.google.com and
// mail.google.com share one saved login.
//
// A full Public Suffix List is ~10k entries and overkill for a personal vault. This is
// a pragmatic table of the multi-label suffixes people actually log in to; everything
// else falls back to the last two labels. Swap in a real PSL if this ever misfires.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.za', 'org.za', 'net.za',
  'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
  'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.sa', 'com.eg', 'com.ng',
  'co.kr', 'or.kr', 'ne.kr',
  'co.il', 'org.il', 'net.il',
  'co.id', 'or.id', 'web.id',
  'com.es', 'com.pl', 'com.ua', 'com.ru', 'net.ru', 'org.ru',
]);

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export function baseDomain(hostname) {
  if (!hostname) return '';
  const host = hostname.toLowerCase().replace(/^www\./, '');
  // Bare IP or single-label host: use it as-is.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;

  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

export function domainOfUrl(url) {
  return baseDomain(hostnameOf(url));
}

// Same registrable domain == a match. Exact-host entries score higher so that, when
// several logins exist under one domain, the one saved on this exact host wins.
export function matchEntries(entries, url) {
  const host = hostnameOf(url);
  const domain = baseDomain(host);
  if (!domain) return [];

  return entries
    .filter((e) => e.domain === domain)
    .map((e) => ({
      entry: e,
      score:
        (hostnameOf(e.origin || '') === host ? 2 : 0) +
        (e.lastUsedAt ? 1 : 0),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.entry.lastUsedAt || 0) - (a.entry.lastUsedAt || 0);
    })
    .map((x) => x.entry);
}

// A page URL the extension can actually act on. chrome://, the Web Store and other
// extensions' pages forbid content scripts, so the shortcut can never work there.
export function isSupportedUrl(url) {
  if (!url) return false;
  // Only http/https: the content_scripts matches in manifest.json cover nothing else,
  // and Chrome forbids injection into chrome://, the Web Store and extension pages.
  return /^https?:\/\//i.test(url);
}
