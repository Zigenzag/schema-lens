// Pure logic shared by the panel and the tests: no DOM, no extension APIs.

const SCHEMA_ORG = /^https?:\/\/(www\.)?schema\.org\//i;
const SCHEMA_PREFIX = /^schema:/i;

/** "https://schema.org/Product" and "schema:Product" both read as "Product". */
export function shortType(type) {
  return String(type).replace(SCHEMA_ORG, '').replace(SCHEMA_PREFIX, '');
}

export function typesOf(obj) {
  const t = obj?.['@type'];
  if (t == null) return [];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string' && x).map(shortType);
}

/** Documentation link for an @type value, or null when it isn't a schema.org-style name. */
export function typeDocUrl(type) {
  if (typeof type !== 'string') return null;
  if (/^https?:\/\/\S+$/i.test(type)) return type;
  const name = type.replace(SCHEMA_PREFIX, '');
  return /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? `https://schema.org/${name}` : null;
}

function firstText(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = firstText(item);
      if (s) return s;
    }
    return '';
  }
  if (v && typeof v === 'object') return firstText(v['@value']);
  return '';
}

/** A short human label for an object: its name, else whatever identifies it. */
export function labelOf(obj) {
  for (const key of ['name', 'headline', 'alternateName', 'title', '@id', 'url']) {
    const s = firstText(obj?.[key]);
    if (s) return s;
  }
  return '';
}

// ---------------------------------------------------------------- parsing

const SNIPPET_WIDTH = 120;

function describeError(src, err) {
  const raw = String(err?.message || err);
  // Firefox: "JSON.parse: <what> at line 3 column 5 of the JSON data"
  // Chromium: "<what> in JSON at position 42 (line 3 column 5)"
  const message = raw
    .replace(/^JSON\.parse:\s*/, '')
    .replace(/\s+at line \d+ column \d+ of the JSON data$/, '')
    .replace(/\s+(in JSON )?at position \d+( \(line \d+ column \d+\))?$/, '')
    .replace(/^./, (c) => c.toUpperCase());

  let line = 0;
  let column = 0;
  const lc = raw.match(/line (\d+) column (\d+)/);
  const pos = raw.match(/position (\d+)/);
  if (lc) {
    line = Number(lc[1]);
    column = Number(lc[2]);
  } else if (pos) {
    const before = src.slice(0, Number(pos[1]));
    line = before.split('\n').length;
    column = before.length - before.lastIndexOf('\n');
  }
  const error = { message };
  if (line) Object.assign(error, { line, column, snippet: snippetAt(src, line, column) });
  return error;
}

/** A few lines around the error, windowed horizontally so minified JSON stays readable. */
function snippetAt(src, line, column) {
  const lines = src.split(/\r\n|\r|\n/);
  const start = Math.max(0, column - 1 - SNIPPET_WIDTH / 2);
  const rows = [];
  for (let n = Math.max(1, line - 2); n <= Math.min(lines.length, line + 1); n++) {
    rows.push({ n, text: lines[n - 1].slice(start, start + SNIPPET_WIDTH).replace(/\t/g, ' ') });
  }
  return { rows, caret: Math.max(0, column - 1 - start) };
}

export function parseBlock(text) {
  const src = text ?? '';
  if (!src.trim()) return { ok: false, error: { message: 'This script block is empty' } };
  try {
    return { ok: true, value: JSON.parse(src) };
  } catch (err) {
    return { ok: false, error: describeError(src, err) };
  }
}

/**
 * Splits a parsed block into its schema objects: arrays are unrolled and a
 * wrapper that only carries @graph is replaced by the nodes inside it.
 */
export function flatten(value) {
  const out = [];
  const walk = (v, graph) => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, graph);
    } else if (v && typeof v === 'object') {
      const g = v['@graph'];
      if (g && typeof g === 'object' && v['@type'] == null) walk(g, true);
      else out.push({ value: v, graph });
    }
  };
  walk(value, false);
  return out;
}

let uid = 0;

function makeObject(block, value, graph) {
  return {
    id: `obj-${uid++}`,
    block,
    value,
    graph,
    types: typesOf(value),
    label: labelOf(value),
    size: Object.keys(value).length,
  };
}

/** Turns raw JSON-LD script texts into the block/object model the panel renders. */
export function buildBlocks(texts, startIndex = 0) {
  return texts.map((text, i) => {
    const block = { index: startIndex + i, format: 'jsonld', text, origin: 'unknown', error: null, objects: [] };
    const parsed = parseBlock(text);
    if (!parsed.ok) {
      block.error = parsed.error;
      return block;
    }
    block.value = parsed.value;
    block.objects = flatten(parsed.value).map((item) => makeObject(block, item.value, item.graph));
    if (!block.objects.length) {
      block.error = { message: 'Valid JSON, but there is no object in it to describe' };
    }
    return block;
  });
}

/**
 * One block holding every Microdata (or RDFa) item on the page, already
 * converted to JSON-LD-shaped objects by the collector. Null when there are none.
 */
export function buildFormatBlock(format, items) {
  if (!items?.length) return null;
  const block = { index: 0, format, text: '', origin: 'unknown', error: null, value: items, objects: [] };
  block.objects = items.map((value) => makeObject(block, value, false));
  return block;
}

// ------------------------------------------------- source vs. live DOM

function fingerprint(text) {
  try {
    return `j${JSON.stringify(JSON.parse(text))}`;
  } catch {
    return `t${String(text).replace(/\s+/g, ' ').trim()}`;
  }
}

/**
 * Labels each live JSON-LD block as present in the server HTML ("source") or not
 * ("injected"), and returns the source texts that no longer exist in the DOM.
 * Formatting differences are ignored; duplicates are matched one for one.
 */
export function markOrigins(blocks, sourceTexts) {
  const pool = new Map();
  const prints = sourceTexts.map(fingerprint);
  for (const p of prints) pool.set(p, (pool.get(p) || 0) + 1);
  const take = (p) => {
    const n = pool.get(p) || 0;
    if (n) pool.set(p, n - 1);
    return n > 0;
  };
  for (const block of blocks) block.origin = take(fingerprint(block.text)) ? 'source' : 'injected';
  return sourceTexts.filter((_, i) => take(prints[i]));
}

// ------------------------------------------------------------- search

/** True when `query` (already lower-cased) occurs in a key or value under `value`. */
export function hasMatch(value, query, key) {
  if (key != null && String(key).toLowerCase().includes(query)) return true;
  if (value === null || typeof value !== 'object') return String(value).toLowerCase().includes(query);
  if (Array.isArray(value)) return value.some((item) => hasMatch(item, query));
  for (const k in value) if (hasMatch(value[k], query, k)) return true;
  return false;
}

/** Maps @id to the top-level object that defines it, so references can link to it. */
export function indexIds(blocks) {
  const index = new Map();
  for (const block of blocks) {
    for (const obj of block.objects) {
      const id = obj.value['@id'];
      if (typeof id === 'string' && obj.size > 1 && !index.has(id)) index.set(id, obj);
    }
  }
  return index;
}

// ------------------------------------------------------------- export

/**
 * Everything that parsed: each JSON-LD block as written, then each Microdata
 * and RDFa item. One value on its own, otherwise an array.
 */
export function exportValue(blocks) {
  const values = [];
  for (const block of blocks) {
    if (block.value === undefined) continue;
    if (block.format === 'jsonld') values.push(block.value);
    else values.push(...block.value);
  }
  return values.length === 1 ? values[0] : values;
}

/** A paste-ready script tag. "</" is escaped so a string can't close the tag early. */
export function scriptTag(value) {
  const json = JSON.stringify(value, null, 2).replace(/<\//g, '<\\/');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

export function fileName(pageUrl) {
  let stem = 'page';
  try {
    const u = new URL(pageUrl);
    stem = `${u.hostname}${u.pathname}`.replace(/[^a-z0-9.]+/gi, '-').replace(/^[-.]+|[-.]+$/g, '');
  } catch {
    // keep the fallback
  }
  return `${stem.slice(0, 80) || 'page'}-schema.json`;
}

/** Validator links for a public page, or null for pages a validator can't fetch. */
export function validatorUrls(pageUrl) {
  if (!/^https?:\/\//i.test(pageUrl || '')) return null;
  const u = encodeURIComponent(pageUrl);
  return {
    richResults: `https://search.google.com/test/rich-results?url=${u}`,
    schemaOrg: `https://validator.schema.org/#url=${u}`,
  };
}
