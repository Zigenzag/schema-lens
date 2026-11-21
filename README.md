# Schema Lens – JSON-LD Inspector (Firefox)

Shows the structured data on the current page: JSON-LD, Microdata and RDFa. Every schema object gets its own accordion with a collapsible tree inside.

Source and issue tracker: <https://github.com/Zigenzag/schema-lens>

"Schema Lens" is a working name. To rename it, change `name`, `short_name` and the sidebar title in `extension/manifest.json`.

## Install

**To try it (lasts until Firefox restarts)**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.

**To keep it installed**

Release Firefox only keeps add-ons that Mozilla has signed. For a private (unlisted) build:

1. Pick your own add-on ID in `extension/manifest.json` (`browser_specific_settings.gecko.id`). It is permanent once signed.
2. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
3. Run `npx web-ext sign --source-dir extension --channel unlisted --api-key <issuer> --api-secret <secret>`.
4. Open the resulting `.xpi` in Firefox.

`npm run build` produces the unsigned zip in `dist/` if you would rather upload it by hand.

## Use

- Click the toolbar button, or press `Alt+Shift+J`. New add-ons start in the Extensions (puzzle piece) menu; pin it to the toolbar from there.
- Each `<script type="application/ld+json">` is a **block**. Each object in it, including every node of an `@graph` and every item of a top-level array, is an accordion.
- The badge on a JSON-LD block says whether it was **in the page source** or **added by JavaScript** after load.
- Search filters to matching objects, opens them and highlights the matches. `Enter` and `Shift+Enter` step through them.
- Buttons copy one object as JSON, copy a block as a `<script>` tag, copy everything, or download everything as `.json`.
- An `@type` value links to its schema.org page. A `{"@id": …}` reference to another object on the page becomes a jump button.
- Invalid JSON is shown with the parser's message and the offending lines.
- Microdata and RDFa items are converted to the same object form as JSON-LD and listed under their own headings. Copying or downloading them gives JSON-LD.
- RDFa support covers RDFa Lite (`vocab`, `prefix`, `typeof`, `property`, `resource`). Properties outside a typed item, such as Open Graph tags, are left out.
- The sidebar button keeps the inspector open beside the page. It follows you from tab to tab once you allow site access.

## Permissions and privacy

| Permission | Why |
| --- | --- |
| `activeTab`, `scripting` | Read the page you are on when you click the button. |
| Access to all sites (optional) | Only requested from the sidebar, so it can update as you switch tabs. |

Nothing is collected or sent anywhere, and there is no background script. Two things do touch the network:

- To tell server-rendered blocks from injected ones, the add-on re-requests the current page from its own server (the browser cache is used when it can be). This is skipped on pages with no JSON-LD.
- The validator links open Google's Rich Results Test or the Schema.org validator with the page's address, when you click them.

## Develop

```
npm install
npm test               # unit tests for the parsing logic
npm run test:firefox   # drives the real popup and sidebar in headless Firefox
npm run lint           # Mozilla's add-on linter
npm run build          # zip into dist/
npm run serve          # UI harness at http://localhost:8765/test/harness.html
```

| Path | What |
| --- | --- |
| `extension/lib/collect.js` | The two functions injected into the page. |
| `extension/lib/core.js` | Parsing, flattening, source comparison, search and export. No DOM. |
| `extension/panel/` | The UI, shared by the popup and the sidebar. |
| `test/` | Unit tests, fixture pages, the browser harness and the Firefox smoke test. |

Requires desktop Firefox 140 or later. Firefox for Android is not supported.

## Licence

MIT. See [LICENSE](LICENSE); a copy ships inside the add-on package.
