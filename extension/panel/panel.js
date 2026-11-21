// The inspector UI. The same page is used for the toolbar popup and the
// sidebar; the sidebar additionally follows the active tab.

import {
  buildBlocks,
  exportValue,
  fileName,
  hasMatch,
  indexIds,
  labelOf,
  markOrigins,
  scriptTag,
  typeDocUrl,
  typesOf,
  validatorUrls,
} from '../lib/core.js';
import { collectPage, collectSource } from '../lib/collect.js';

const api = globalThis.browser ?? globalThis.chrome;

const view = detectView();
document.documentElement.dataset.view = view;

const $ = (id) => document.getElementById(id);
const ui = {
  q: $('q'),
  hits: $('hits'),
  list: $('list'),
  summary: $('summary'),
  foot: $('foot'),
  toast: $('toast'),
  toggle: $('btn-toggle'),
  copy: $('btn-copy'),
  download: $('btn-download'),
  refresh: $('btn-refresh'),
  sidebar: $('btn-sidebar'),
  rrt: $('link-rrt'),
  sov: $('link-sov'),
};

const state = {
  scan: 0, // bumped on every scan so late results from an older one are dropped
  windowId: null,
  page: null,
  blocks: [],
  sourceNote: '',
  ids: new Map(),
  query: '',
  marks: [],
  markAt: -1,
};

const MIN_QUERY = 2;
const AUTO_OPEN_MAX = 12; // nested nodes with more entries than this start collapsed
const ORIGINS = {
  source: ['In page source', 'This block is in the HTML the server sent.'],
  injected: ['Added by JavaScript', 'Not in the HTML the server sent: a script added or changed it after load.'],
  removed: ['Source only', 'In the HTML the server sent, but no longer in the live page.'],
};

// ------------------------------------------------------------- helpers

function detectView() {
  const fromUrl = new URLSearchParams(location.search).get('view');
  if (fromUrl === 'popup' || fromUrl === 'sidebar') return fromUrl;
  try {
    if (api.extension.getViews({ type: 'sidebar' }).includes(window)) return 'sidebar';
  } catch {
    // fall through
  }
  return 'popup';
}

/** Tiny element builder. Text only ever goes in through textContent/append. */
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...kids.flat().filter((kid) => kid != null && kid !== false));
  return node;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** A small button for use inside a <summary>; clicking it must not toggle the accordion. */
function miniButton(iconName, title, action) {
  return h(
    'button',
    {
      class: 'mini',
      type: 'button',
      title,
      'aria-label': title,
      onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      },
    },
    icon(iconName),
  );
}

function link(href, text, className, title) {
  return h('a', { class: className, href, title, target: '_blank', rel: 'noopener noreferrer' }, highlight(text));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Text with the current search query wrapped in <mark>. */
function highlight(value) {
  const text = String(value);
  const q = state.query;
  if (!q) return text;
  const lower = text.toLowerCase();
  let at = lower.indexOf(q);
  if (at < 0 || lower.length !== text.length) return text;
  const frag = document.createDocumentFragment();
  let from = 0;
  while (at >= 0) {
    frag.append(text.slice(from, at), h('mark', { text: text.slice(at, at + q.length) }));
    from = at + q.length;
    at = lower.indexOf(q, from);
  }
  frag.append(text.slice(from));
  return frag;
}

let toastTimer;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1600);
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    // Older, synchronous route for when the async clipboard is refused.
    const area = h('textarea', { 'aria-hidden': 'true' });
    area.value = text;
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    toast(copied ? done : 'Couldn’t copy to the clipboard');
  }
}

// ---------------------------------------------------------------- tree

/** Renders the entries of an object or array. Nested nodes fill in when first opened. */
function renderEntries(container, value, depth, parentKey) {
  const isArray = Array.isArray(value);
  const frag = document.createDocumentFragment();
  for (const key of Object.keys(value)) {
    frag.append(renderEntry(key, value[key], depth, isArray, isArray ? parentKey : key));
  }
  container.append(frag);
}

function renderEntry(key, value, depth, isIndex, meaning) {
  const keyEl = h('span', { class: isIndex ? 'k idx' : 'k' }, isIndex ? key : highlight(key));

  if (value === null || typeof value !== 'object') {
    return h('div', { class: 'row' }, keyEl, renderValue(value, meaning));
  }

  const isArray = Array.isArray(value);
  const size = Object.keys(value).length;
  if (!size) {
    return h('div', { class: 'row' }, keyEl, h('span', { class: 'v nil', text: isArray ? '[ ]' : '{ }' }));
  }

  // A bare {"@id": …} that points at another object on the page becomes a jump link.
  const target = !isArray && size === 1 ? state.ids.get(value['@id']) : null;
  if (target) {
    const name = target.types.join(', ') || 'object';
    return h(
      'div',
      { class: 'row' },
      keyEl,
      h('button', { class: 'ref', type: 'button', title: 'Jump to this object', onclick: () => jumpTo(target) }, `→ ${name}`),
      h('span', { class: 'v nil' }, highlight(value['@id'])),
    );
  }

  const q = state.query;
  const kids = h('div', { class: 'kids' });
  const node = h('details', { class: 'node' }, h('summary', null, keyEl, describe(value, isArray, size)), kids);
  const fill = () => {
    if (!kids.firstChild) renderEntries(kids, value, depth + 1, meaning);
  };
  if (q ? hasMatch(value, q) : depth < 1 && size <= AUTO_OPEN_MAX) {
    node.open = true;
    fill();
  }
  node.addEventListener('toggle', () => node.open && fill());
  return node;
}

/** What a collapsed node says about itself: its type and name, or just its size. */
function describe(value, isArray, size) {
  if (isArray) return h('span', { class: 'meta', text: `[${size}]` });
  const types = typesOf(value);
  const label = labelOf(value);
  if (!types.length && !label) return h('span', { class: 'meta', text: `{${size}}` });
  return [
    types.length ? h('span', { class: 't', text: types.join(', ') }) : null,
    label ? h('span', { class: 'hint', text: clip(label, 80) }) : null,
  ];
}

function renderValue(value, meaning) {
  if (typeof value === 'string') {
    if (meaning === '@type') {
      const docs = typeDocUrl(value);
      if (docs) return link(docs, value, 'v', 'Open the documentation for this type');
    }
    if (/^https?:\/\/\S+$/i.test(value)) return link(value, value, 'v');
    return h('span', { class: 'v' }, highlight(value));
  }
  return h('span', { class: `v ${value === null ? 'nil' : typeof value}` }, highlight(value));
}

// ---------------------------------------------------- blocks and objects

function renderObject(obj) {
  obj.body = h('div', { class: 'body' });
  const typed = obj.types.length > 0;
  obj.el = h(
    'details',
    { class: 'obj', id: obj.id },
    h(
      'summary',
      null,
      h('span', { class: typed ? 'type' : 'type none', text: typed ? obj.types.join(', ') : 'No @type' }),
      h('span', { class: 'label', text: obj.label }),
      h('span', { class: 'count', text: obj.size, title: plural(obj.size, 'property', 'properties') }),
      miniButton('copy', 'Copy this object as JSON', () => copyText(JSON.stringify(obj.value, null, 2), 'Object copied')),
    ),
    obj.body,
  );
  obj.el.addEventListener('toggle', () => {
    if (obj.el.open) fillObject(obj);
    syncToggleButton();
  });
  return obj.el;
}

function fillObject(obj) {
  if (!obj.body.firstChild) renderEntries(obj.body, obj.value, 0);
}

function renderError(block) {
  const { message, line, column, snippet } = block.error;
  const body = h('div', { class: 'body' });
  if (line) body.append(h('p', { class: 'err-where', text: `Line ${line}, column ${column} of this block` }));
  if (snippet) {
    const pre = h('pre', { class: 'snippet' });
    for (const row of snippet.rows) {
      const bad = row.n === line;
      pre.append(h('div', { class: bad ? 'sl bad' : 'sl' }, h('span', { class: 'ln', text: row.n }), h('span', { text: row.text })));
      if (bad) pre.append(h('div', { class: 'sl caret' }, h('span', { class: 'ln' }), h('span', { text: `${' '.repeat(snippet.caret)}^` })));
    }
    body.append(pre);
  }
  block.errorEl = h(
    'details',
    { class: 'obj error', open: true },
    h('summary', null, h('span', { class: 'type', text: 'Invalid JSON' }), h('span', { class: 'label', text: message, title: message })),
    body,
  );
  return block.errorEl;
}

function setOrigin(block) {
  const info = ORIGINS[block.origin];
  block.badge.hidden = !info;
  if (!info) return;
  block.badge.dataset.origin = block.origin;
  block.badge.textContent = info[0];
  block.badge.title = info[1];
}

function renderBlock(block) {
  const count = block.objects.length;
  const meta = block.error ? '' : plural(count, 'object') + (block.objects[0].graph ? ' in @graph' : '');
  block.badge = h('span', { class: 'origin' });
  setOrigin(block);
  const copyButton = block.error
    ? miniButton('copy', 'Copy the raw text of this block', () => copyText(block.text, 'Raw block copied'))
    : miniButton('code', 'Copy this block as a <script> tag', () => copyText(scriptTag(block.value), 'Script tag copied'));
  block.el = h(
    'section',
    { class: 'block' },
    h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: `Block ${block.index + 1}` }), meta && h('span', { text: meta }), block.badge, copyButton),
    block.error ? renderError(block) : block.objects.map(renderObject),
  );
  return block.el;
}

function stateCard(title, ...lines) {
  return h('div', { class: 'state' }, h('h2', { text: title }), lines);
}

function emptyState() {
  const { microdata, rdfa } = state.page;
  const other = [microdata.count && 'Microdata', rdfa.count && 'RDFa'].filter(Boolean).join(' and ');
  return stateCard(
    'No JSON-LD on this page',
    h('p', null, 'There are no ', h('code', { text: 'application/ld+json' }), ' script blocks in the page.'),
    other && h('p', { text: `It does use ${other}, which this inspector detects but doesn’t display.` }),
  );
}

function renderSummary() {
  const { blocks, page } = state;
  const objects = blocks.reduce((n, b) => n + b.objects.length, 0);
  const errors = blocks.filter((b) => b.error).length;
  const parts = [];
  if (blocks.length) {
    parts.push(h('span', null, h('strong', { text: plural(objects, 'object') }), ` in ${plural(blocks.length, 'block')}`));
  }
  if (errors) parts.push(h('span', { class: 'bad', text: plural(errors, 'error') }));
  for (const [name, found] of [['Microdata', page.microdata], ['RDFa', page.rdfa]]) {
    if (!found.count) continue;
    const types = found.types.map((t) => t.replace(/^https?:\/\/(www\.)?schema\.org\//i, '')).join(', ');
    parts.push(h('span', { class: 'chip', text: `${name} · ${found.count}`, title: `${name} is also on this page (detected, not shown).${types ? ` Types: ${types}` : ''}` }));
  }
  if (state.sourceNote) {
    parts.push(
      h('span', {
        text: `Source check unavailable: ${state.sourceNote}`,
        title: 'The page’s HTML couldn’t be re-read, so blocks aren’t labelled as server-rendered or added by JavaScript.',
      }),
    );
  }
  ui.summary.replaceChildren(...parts);
  ui.summary.hidden = !parts.length;
}

function render() {
  const { blocks, page } = state;
  state.ids = indexIds(blocks);
  ui.list.replaceChildren(...(blocks.length ? blocks.map(renderBlock) : [emptyState()]));

  const objects = blocks.flatMap((b) => b.objects);
  if (objects.length === 1) objects[0].el.open = true;

  const links = validatorUrls(page.url);
  ui.foot.hidden = !links;
  if (links) {
    ui.rrt.href = links.richResults;
    ui.sov.href = links.schemaOrg;
  }
  const exportable = blocks.some((b) => b.value !== undefined);
  ui.copy.disabled = ui.download.disabled = !exportable;
  ui.toggle.disabled = !objects.length;

  renderSummary();
  applySearch(true);
  syncToggleButton();
}

// -------------------------------------------------------------- search

function applySearch(force = false) {
  const typed = ui.q.value.trim().toLowerCase();
  const q = typed.length >= MIN_QUERY ? typed : '';
  if (q === state.query && !force) return;
  state.query = q;

  let anything = false;
  for (const block of state.blocks) {
    let visible = false;
    if (block.error) visible = !q || block.text.toLowerCase().includes(q);
    for (const obj of block.objects) {
      const match = !q || hasMatch(obj.value, q);
      obj.el.hidden = !match;
      visible ||= match;
      if (q && match) {
        // Redraw with every branch that holds a match opened and highlighted.
        obj.searched = true;
        obj.openedBySearch ||= !obj.el.open;
        obj.body.replaceChildren();
        renderEntries(obj.body, obj.value, 0);
        obj.el.open = true;
      } else if (obj.searched) {
        obj.searched = false;
        obj.body.replaceChildren();
        if (obj.openedBySearch) obj.el.open = false;
        else if (obj.el.open) fillObject(obj);
        obj.openedBySearch = false;
      }
    }
    block.el.hidden = !visible;
    anything ||= visible;
  }

  ui.list.querySelector('.no-match')?.remove();
  if (q && state.blocks.length && !anything) {
    ui.list.append(h('div', { class: 'state no-match' }, h('p', { text: `Nothing matches “${typed}”.` })));
  }

  state.marks = q ? [...ui.list.querySelectorAll('mark')] : [];
  state.markAt = -1;
  ui.hits.textContent = q ? plural(state.marks.length, 'match', 'matches') : '';
  syncToggleButton();
}

function stepMatch(direction) {
  const total = state.marks.length;
  if (!total) return;
  state.marks[state.markAt]?.classList.remove('current');
  state.markAt = (state.markAt + direction + total) % total;
  const mark = state.marks[state.markAt];
  mark.classList.add('current');
  mark.scrollIntoView({ block: 'center' });
  ui.hits.textContent = `${state.markAt + 1} of ${total}`;
}

function jumpTo(obj) {
  if (obj.el.hidden) {
    ui.q.value = '';
    applySearch();
  }
  obj.el.open = true;
  fillObject(obj);
  obj.el.scrollIntoView({ block: 'start' });
  obj.el.classList.add('flash');
  setTimeout(() => obj.el.classList.remove('flash'), 1200);
}

// ------------------------------------------------------------- toolbar

const visibleObjects = () => state.blocks.flatMap((b) => b.objects).filter((o) => !o.el.hidden);

function syncToggleButton() {
  const objects = visibleObjects();
  const collapse = objects.length > 0 && objects.every((o) => o.el.open);
  const label = collapse ? 'Collapse all' : 'Expand all';
  ui.toggle.title = label;
  ui.toggle.setAttribute('aria-label', label);
  ui.toggle.querySelector('use').setAttribute('href', collapse ? '#i-fold' : '#i-unfold');
}

function toggleAll() {
  const objects = visibleObjects();
  const open = objects.some((o) => !o.el.open);
  for (const obj of objects) {
    if (open) fillObject(obj);
    obj.el.open = open;
  }
}

function download() {
  const json = JSON.stringify(exportValue(state.blocks), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = h('a', { href: url, download: fileName(state.page.url) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ------------------------------------------------------- reading the tab

async function inject(tabId, func) {
  const [frame] = await api.scripting.executeScript({ target: { tabId }, func });
  if (!frame || frame.error || frame.result == null) {
    throw new Error(frame?.error?.message || 'The page returned nothing');
  }
  return frame.result;
}

async function activeTab() {
  const query = state.windowId == null ? { active: true, currentWindow: true } : { active: true, windowId: state.windowId };
  const [tab] = await api.tabs.query(query);
  if (!tab) throw new Error('No active tab');
  return tab;
}

async function scan() {
  const id = ++state.scan;
  ui.refresh.classList.add('busy');
  ui.list.setAttribute('aria-busy', 'true');
  try {
    let tab;
    let page;
    try {
      tab = await activeTab();
      page = await inject(tab.id, collectPage);
    } catch {
      if (id === state.scan) await showUnavailable();
      return;
    }
    if (id !== state.scan) return;
    state.page = page;
    state.sourceNote = '';
    state.blocks = buildBlocks(page.blocks);
    render();

    // Second, slower pass: compare against the HTML the server sent. Skipped
    // when there is nothing to label, so schema-less pages cost no request.
    if (!page.blocks.length) return;
    const source = await inject(tab.id, collectSource).catch((err) => ({ error: err.message }));
    if (id !== state.scan) return;
    if (!source.blocks) {
      state.sourceNote = String(source.error).replace(/\.$/, '');
      renderSummary();
      return;
    }
    const removed = buildBlocks(markOrigins(state.blocks, source.blocks), state.blocks.length);
    for (const block of removed) block.origin = 'removed';
    for (const block of state.blocks) setOrigin(block);
    if (removed.length) {
      state.blocks.push(...removed);
      render();
    }
  } finally {
    if (id === state.scan) {
      ui.refresh.classList.remove('busy');
      ui.list.removeAttribute('aria-busy');
    }
  }
}

const ALL_SITES = { origins: ['<all_urls>'] };

async function showUnavailable() {
  state.page = null;
  state.blocks = [];
  state.marks = [];
  ui.summary.hidden = ui.foot.hidden = true;
  ui.toggle.disabled = ui.copy.disabled = ui.download.disabled = true;
  ui.hits.textContent = '';

  // In the sidebar the usual reason is that site access hasn't been granted yet.
  const canAsk = view === 'sidebar' && !(await api.permissions.contains(ALL_SITES).catch(() => true));
  if (canAsk) {
    ui.list.replaceChildren(
      stateCard(
        'Follow along as you browse',
        h('p', { text: 'To update as you switch tabs, the sidebar needs permission to read the pages you visit. Pages are read on this device only.' }),
        h('button', { class: 'btn', type: 'button', text: 'Allow on all sites', onclick: requestAllSites }),
        h('p', { text: 'Or use the toolbar button to inspect one page at a time.' }),
      ),
    );
  } else {
    ui.list.replaceChildren(
      stateCard('This page can’t be inspected', h('p', { text: 'Browser pages, the add-ons site and built-in viewers are off limits to extensions.' })),
    );
  }
}

async function requestAllSites() {
  const granted = await api.permissions.request(ALL_SITES).catch(() => false);
  if (granted) scan();
}

// ---------------------------------------------------------------- wiring

let searchTimer;
ui.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applySearch, 120);
});
ui.q.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  clearTimeout(searchTimer);
  applySearch();
  stepMatch(event.shiftKey ? -1 : 1);
});
ui.toggle.addEventListener('click', toggleAll);
ui.copy.addEventListener('click', () => copyText(JSON.stringify(exportValue(state.blocks), null, 2), 'All structured data copied'));
ui.download.addEventListener('click', download);
ui.refresh.addEventListener('click', scan);

if (view === 'popup') {
  ui.sidebar.hidden = !api.sidebarAction;
  ui.sidebar.addEventListener('click', () => {
    // Must be called straight from the click for Firefox to allow it.
    api.sidebarAction.open();
    window.close();
  });
  ui.q.focus();
  scan();
} else {
  let scanTimer;
  const scanSoon = (delay) => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  };
  api.windows.getCurrent().then((win) => {
    state.windowId = win.id;
    api.tabs.onActivated.addListener((info) => info.windowId === state.windowId && scanSoon(0));
    api.tabs.onUpdated.addListener((tabId, change, tab) => {
      if (tab.windowId !== state.windowId || !tab.active) return;
      // A finished load, or an in-page (history API) navigation on a loaded page.
      if (change.status === 'complete' || (change.url && tab.status === 'complete')) scanSoon(250);
    });
    api.permissions.onAdded.addListener(() => scanSoon(0));
    scan();
  });
}
