// Functions injected into the inspected tab with scripting.executeScript.
// They are serialised with toString(), so each one must be fully
// self-contained: no imports, no references to anything outside its body.

/** Reads the live DOM. Synchronous and cheap so the panel can render at once. */
export function collectPage() {
  const blocks = [];
  for (const el of document.querySelectorAll('script[type*="ld+json" i]')) {
    const type = (el.getAttribute('type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'application/ld+json') blocks.push(el.textContent);
  }

  // Microdata and RDFa are detected and counted, not parsed.
  const tally = (selector, attr) => {
    const els = document.querySelectorAll(selector);
    const seen = new Map();
    for (const el of els) {
      for (const t of (el.getAttribute(attr) || '').split(/\s+/)) {
        if (t) seen.set(t, (seen.get(t) || 0) + 1);
      }
    }
    const types = [...seen].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    return { count: els.length, types };
  };

  return {
    url: location.href,
    title: document.title,
    blocks,
    microdata: tally('[itemscope]', 'itemtype'),
    rdfa: tally('[typeof]', 'typeof'),
  };
}

/**
 * Re-reads the HTML the server sent (from the HTTP cache when possible) so the
 * panel can tell server-rendered JSON-LD from blocks added by JavaScript.
 */
export async function collectSource() {
  if (!/^https?:$/.test(location.protocol)) return { error: 'this is not a web page' };
  const ctrl = new AbortController();
  // Generous: nothing waits on this, and uncached pages (signed-in sessions) can be slow.
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(location.href, {
      credentials: 'include',
      cache: 'force-cache',
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `the server answered ${res.status}` };
    const contentType = res.headers.get('content-type') || '';
    if (contentType && !/html|xml/i.test(contentType)) return { error: 'the source is not HTML' };

    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const blocks = [];
    for (const el of doc.querySelectorAll('script[type*="ld+json" i]')) {
      const type = (el.getAttribute('type') || '').split(';')[0].trim().toLowerCase();
      if (type === 'application/ld+json') blocks.push(el.textContent);
    }
    return { blocks };
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'the server took over 15 seconds' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}
