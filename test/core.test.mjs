import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlocks,
  exportValue,
  fileName,
  flatten,
  hasMatch,
  indexIds,
  labelOf,
  markOrigins,
  parseBlock,
  scriptTag,
  shortType,
  typeDocUrl,
  typesOf,
  validatorUrls,
} from '../extension/lib/core.js';

test('types are read as short names, whatever form they take', () => {
  assert.equal(shortType('https://schema.org/Product'), 'Product');
  assert.equal(shortType('http://www.schema.org/Product'), 'Product');
  assert.equal(shortType('schema:Product'), 'Product');
  assert.deepEqual(typesOf({ '@type': ['WebPage', 'https://schema.org/ItemPage'] }), ['WebPage', 'ItemPage']);
  assert.deepEqual(typesOf({ '@type': 42 }), []);
  assert.deepEqual(typesOf({}), []);
});

test('type documentation links only for things that look like types', () => {
  assert.equal(typeDocUrl('Product'), 'https://schema.org/Product');
  assert.equal(typeDocUrl('schema:Offer'), 'https://schema.org/Offer');
  assert.equal(typeDocUrl('https://example.com/vocab/Thing'), 'https://example.com/vocab/Thing');
  assert.equal(typeDocUrl('javascript:alert(1)'), null);
  assert.equal(typeDocUrl('not a type'), null);
  assert.equal(typeDocUrl(7), null);
});

test('labels prefer a name and fall back to an identifier', () => {
  assert.equal(labelOf({ name: ' Wallet ', '@id': '#x' }), 'Wallet');
  assert.equal(labelOf({ headline: 'News' }), 'News');
  assert.equal(labelOf({ name: [{ '@value': 'Localised' }] }), 'Localised');
  assert.equal(labelOf({ '@id': 'https://example.com/#org' }), 'https://example.com/#org');
  assert.equal(labelOf({ price: 3 }), '');
});

test('flatten unrolls arrays and @graph wrappers into individual objects', () => {
  assert.deepEqual(flatten({ '@type': 'A' }), [{ value: { '@type': 'A' }, graph: false }]);
  assert.equal(flatten([{ a: 1 }, [{ b: 2 }], 'stray', null]).length, 2);

  const graph = flatten({ '@context': 'https://schema.org', '@graph': [{ '@type': 'A' }, { '@type': 'B' }] });
  assert.deepEqual(graph.map((o) => o.value['@type']), ['A', 'B']);
  assert.ok(graph.every((o) => o.graph));

  // A typed node that happens to carry @graph is a node in its own right.
  assert.equal(flatten({ '@type': 'Dataset', '@graph': [{ '@type': 'A' }] }).length, 1);
  assert.equal(flatten({ '@graph': { '@type': 'Solo' } }).length, 1);
  assert.deepEqual(flatten('text'), []);
});

test('parse errors carry a location and a snippet', () => {
  const src = '{\n  "@type": "Event",\n  "name": "Workshop",\n}';
  const res = parseBlock(src);
  assert.equal(res.ok, false);
  assert.ok(res.error.message.length > 0);
  assert.equal(res.error.line, 4);
  assert.equal(res.error.column, 1);
  assert.deepEqual(res.error.snippet.rows.map((r) => r.n), [2, 3, 4]);
  assert.equal(res.error.snippet.caret, 0);
});

test('parse error locations work for both engine message styles', () => {
  const cases = [
    ['JSON.parse: expected property name or \'}\' at line 3 column 5 of the JSON data', 3, 5, 'Expected property name or \'}\''],
    ['Expected double-quoted property name in JSON at position 7 (line 3 column 5)', 3, 5, 'Expected double-quoted property name'],
    ['Unexpected token } in JSON at position 7', 3, 5, 'Unexpected token }'],
  ];
  const realParse = JSON.parse;
  try {
    for (const [message, line, column, cleaned] of cases) {
      JSON.parse = () => {
        throw new SyntaxError(message);
      };
      const { error } = parseBlock('{\n\n    }x');
      assert.deepEqual([error.line, error.column, error.message], [line, column, cleaned]);
    }
  } finally {
    JSON.parse = realParse;
  }
});

test('snippets of minified JSON are windowed around the error', () => {
  const src = `{"a":"${'x'.repeat(500)}",}`;
  const { error } = parseBlock(src);
  assert.equal(error.line, 1);
  assert.ok(error.snippet.rows[0].text.length <= 120);
  assert.equal(error.snippet.rows[0].text[error.snippet.caret], src[error.column - 1]);
});

test('empty and object-less blocks are reported, not dropped', () => {
  assert.match(parseBlock('  \n ').error.message, /empty/);
  const [block] = buildBlocks(['"just a string"']);
  assert.match(block.error.message, /no object/);
  assert.equal(block.objects.length, 0);
});

test('buildBlocks produces one object per schema node', () => {
  const blocks = buildBlocks([
    '{"@type":"Product","name":"Wallet","offers":{"@type":"Offer"}}',
    '{"@graph":[{"@type":"Organization","@id":"#org","name":"Acme"},{"@type":"WebSite","publisher":{"@id":"#org"}}]}',
    '{"@type": "Event",}',
  ]);
  assert.deepEqual(blocks.map((b) => b.objects.length), [1, 2, 0]);
  assert.deepEqual(blocks.map((b) => b.index), [0, 1, 2]);
  assert.ok(blocks[2].error);
  const [product] = blocks[0].objects;
  assert.deepEqual([product.types, product.label, product.size, product.graph], [['Product'], 'Wallet', 3, false]);
  assert.equal(blocks[1].objects[1].graph, true);
  assert.equal(new Set(blocks.flatMap((b) => b.objects.map((o) => o.id))).size, 3);

  const ids = indexIds(blocks);
  assert.equal(ids.get('#org'), blocks[1].objects[0]);
  assert.equal(ids.size, 1);
});

test('origins: formatting is ignored, duplicates match one for one', () => {
  const live = buildBlocks(['{"@type":"A"}', '{ "@type" : "A" }', '{"@type":"B"}', '{"@type": bad}']);
  const removed = markOrigins(live, ['{\n  "@type": "A"\n}', '{"@type": bad}', '{"@type":"Gone"}']);
  assert.deepEqual(live.map((b) => b.origin), ['source', 'injected', 'injected', 'source']);
  assert.deepEqual(removed, ['{"@type":"Gone"}']);
});

test('search looks at keys and values at any depth, case-insensitively', () => {
  const value = { '@type': 'Product', offers: [{ price: 49.99, seller: { name: 'Northfold' } }], inStock: true, gtin: null };
  for (const q of ['product', 'north', '49.9', 'seller', 'true', 'null', 'instock']) assert.ok(hasMatch(value, q), q);
  assert.equal(hasMatch(value, 'missing'), false);
  assert.equal(hasMatch(value, '0'), false, 'array positions are not searchable');
});

test('export helpers', () => {
  const blocks = buildBlocks(['{"@type":"A"}', 'broken', '[{"@type":"B"}]']);
  assert.deepEqual(exportValue(blocks), [{ '@type': 'A' }, [{ '@type': 'B' }]]);
  assert.deepEqual(exportValue(blocks.slice(0, 2)), { '@type': 'A' });

  const tag = scriptTag({ text: '</script><script>alert(1)</script>' });
  assert.equal(tag.match(/<\/script>/g).length, 1);
  assert.deepEqual(JSON.parse(tag.split('\n').slice(1, -1).join('\n')), { text: '</script><script>alert(1)</script>' });

  assert.equal(fileName('https://www.example.com/shop/wallets/?x=1'), 'www.example.com-shop-wallets-schema.json');
  assert.equal(fileName('not a url'), 'page-schema.json');

  assert.equal(validatorUrls('about:blank'), null);
  assert.equal(
    validatorUrls('https://example.com/a?b=c').richResults,
    'https://search.google.com/test/rich-results?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc',
  );
});
