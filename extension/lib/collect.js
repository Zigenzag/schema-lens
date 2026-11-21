// Functions injected into the inspected tab with scripting.executeScript.
// They are serialised with toString(), so each one must be fully
// self-contained: no imports, no references to anything outside its body.

/**
 * Reads the live DOM: the raw text of every JSON-LD block, plus Microdata and
 * RDFa items converted to the same shape as JSON-LD objects ("@type", "@id",
 * nested objects, arrays for repeated properties). Synchronous, so the panel
 * can render at once.
 */
export function collectPage() {
  const SCHEMA_ORG = /^https?:\/\/(www\.)?schema\.org\//i;
  const tokens = (text) => (text || '').split(/\s+/).filter(Boolean);
  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const absolute = (el, attr) => {
    const value = el.getAttribute(attr) || '';
    try {
      return new URL(value, document.baseURI).href;
    } catch {
      return value;
    }
  };

  // schema.org names are shortened ("http://schema.org/Person" → "Person") and
  // the item then gets an "@context", exactly as it would be written in JSON-LD.
  let usesSchemaOrg = false;
  const short = (iri) => {
    if (!SCHEMA_ORG.test(iri)) return iri;
    usesSchemaOrg = true;
    return iri.replace(SCHEMA_ORG, '');
  };
  const typed = (item, types) => {
    if (types.length) item['@type'] = types.length === 1 ? types[0] : types;
  };
  const add = (item, name, value) => {
    if (!(name in item)) item[name] = value;
    else if (Array.isArray(item[name])) item[name].push(value);
    else item[name] = [item[name], value];
  };
  const withContext = (item) => (usesSchemaOrg ? { '@context': 'https://schema.org', ...item } : item);

  // ------------------------------------------------------------- JSON-LD
  const blocks = [];
  for (const el of document.querySelectorAll('script[type*="ld+json" i]')) {
    const type = (el.getAttribute('type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'application/ld+json') blocks.push(el.textContent);
  }

  // ----------------------------------------------------------- Microdata
  // Follows the HTML specification: an item's properties are the itemprop
  // elements beneath it (and beneath anything it names in itemref), stopping
  // at nested items, which become property values themselves.
  const microValue = (el) => {
    switch (el.localName) {
      case 'meta':
        return el.getAttribute('content') || '';
      case 'audio':
      case 'embed':
      case 'iframe':
      case 'img':
      case 'source':
      case 'track':
      case 'video':
        return absolute(el, 'src');
      case 'a':
      case 'area':
      case 'link':
        return absolute(el, 'href');
      case 'object':
        return absolute(el, 'data');
      case 'data':
      case 'meter':
        return el.getAttribute('value') || '';
      case 'time':
        return el.getAttribute('datetime') || clean(el.textContent);
      default:
        return clean(el.textContent);
    }
  };
  const microItem = (root, open) => {
    const item = {};
    typed(item, tokens(root.getAttribute('itemtype')).map(short));
    if (root.hasAttribute('itemid')) item['@id'] = absolute(root, 'itemid');
    const seen = new Set();
    const visit = (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const nested = el.hasAttribute('itemscope');
      const names = tokens(el.getAttribute('itemprop'));
      if (names.length && !(nested && open.has(el))) {
        const value = nested ? microItem(el, new Set(open).add(el)) : microValue(el);
        for (const name of names) add(item, short(name), value);
      }
      if (!nested) for (const child of el.children) visit(child);
    };
    for (const child of root.children) visit(child);
    for (const id of tokens(root.getAttribute('itemref'))) {
      const target = document.getElementById(id);
      if (target) visit(target);
    }
    return item;
  };
  const referenced = new Set();
  for (const el of document.querySelectorAll('[itemref]')) {
    for (const id of tokens(el.getAttribute('itemref'))) referenced.add(id);
  }
  const isReferenced = (el) => {
    for (let node = el; node; node = node.parentElement) if (node.id && referenced.has(node.id)) return true;
    return false;
  };
  const microdata = [];
  for (const el of document.querySelectorAll('[itemscope]')) {
    // An item that is the value of another item's property is not top-level.
    if (el.hasAttribute('itemprop') && (el.parentElement?.closest('[itemscope]') || isReferenced(el))) continue;
    usesSchemaOrg = false;
    const item = microItem(el, new Set([el]));
    microdata.push(withContext(item));
  }

  // ---------------------------------------------------------------- RDFa
  // RDFa Lite: vocab, prefix, typeof, property and resource. Properties that
  // are not inside a typed item (Open Graph <meta> tags, for instance) are
  // left out, as they describe the page rather than a schema object.
  const PREFIXES = {
    schema: 'http://schema.org/',
    og: 'http://ogp.me/ns#',
    foaf: 'http://xmlns.com/foaf/0.1/',
    dc: 'http://purl.org/dc/terms/',
    dcterms: 'http://purl.org/dc/terms/',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    v: 'http://rdf.data-vocabulary.org/#',
  };
  const extend = (ctx, el) => {
    if (!el.hasAttribute('vocab') && !el.hasAttribute('prefix')) return ctx;
    const next = { vocab: ctx.vocab, prefixes: ctx.prefixes };
    if (el.hasAttribute('vocab')) {
      const vocab = el.getAttribute('vocab').trim();
      next.vocab = /^https?:\/\/(www\.)?schema\.org$/i.test(vocab) ? `${vocab}/` : vocab;
    }
    if (el.hasAttribute('prefix')) {
      const parts = tokens(el.getAttribute('prefix'));
      next.prefixes = { ...ctx.prefixes };
      for (let i = 0; i + 1 < parts.length; i += 2) next.prefixes[parts[i].replace(/:$/, '')] = parts[i + 1];
    }
    return next;
  };
  const resolve = (term, ctx) => {
    if (/^https?:\/\//i.test(term)) return short(term);
    const colon = term.indexOf(':');
    if (colon > 0) {
      const base = ctx.prefixes[term.slice(0, colon)];
      return base ? short(base + term.slice(colon + 1)) : term;
    }
    return ctx.vocab ? short(ctx.vocab + term) : term;
  };
  const rdfaValue = (el) => {
    if (el.hasAttribute('content')) return el.getAttribute('content');
    for (const attr of ['resource', 'href', 'src']) if (el.hasAttribute(attr)) return absolute(el, attr);
    return el.getAttribute('datetime') || clean(el.textContent);
  };
  const rdfaWalk = (el, inherited, subject, top) => {
    const ctx = extend(inherited, el);
    const names = tokens(el.getAttribute('property')).map((name) => resolve(name, ctx));
    let current = subject;
    if (el.hasAttribute('typeof')) {
      current = {};
      typed(current, tokens(el.getAttribute('typeof')).map((type) => resolve(type, ctx)));
      const id = el.hasAttribute('resource') ? 'resource' : el.hasAttribute('about') ? 'about' : '';
      if (id) current['@id'] = absolute(el, id);
      // With a property on the same element, the new item is that property's value.
      if (names.length && subject) for (const name of names) add(subject, name, current);
      else top.push(current);
    } else if (names.length && subject) {
      const value = rdfaValue(el);
      for (const name of names) add(subject, name, value);
    }
    for (const child of el.children) rdfaWalk(child, ctx, current, top);
  };
  const rdfa = [];
  for (const el of document.querySelectorAll('[typeof]')) {
    if (el.parentElement?.closest('[typeof]')) continue; // reached from its ancestor's walk
    const ancestors = [];
    for (let node = el.parentElement; node; node = node.parentElement) ancestors.unshift(node);
    const ctx = ancestors.reduce(extend, { vocab: '', prefixes: PREFIXES });
    usesSchemaOrg = false;
    const top = [];
    rdfaWalk(el, ctx, null, top);
    rdfa.push(...top.map(withContext));
  }

  return { url: location.href, title: document.title, blocks, microdata, rdfa };
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
