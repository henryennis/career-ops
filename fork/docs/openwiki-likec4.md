# LikeC4 views inside an OpenWiki wiki

Two tools, joined by one script. [OpenWiki](https://github.com/langchain-ai/openwiki) writes a Markdown wiki under `openwiki/` and browses it with `openwiki visualize`. [LikeC4](https://likec4.dev) holds the architecture as `.c4` source under `fork/likec4/src` and renders it. `fork/openwiki-likec4.mjs` puts the second inside the first.

Nothing here documents this repository. The model is a placeholder that exists to prove the pipeline runs; writing the real thing is a separate pass.

## Why this needed a script

The obvious approach is to drop `<likec4-view view-id="…">` into a page and load the component bundle. It does not work, and it fails silently, which is worse. Three gates sit between a wiki page and an interactive view, each sufficient on its own.

The visualizer renders a page body as:

```js
DOMPurify.sanitize(marked.parse(stripFrontmatter(n.body)))
```

served under this policy:

```
default-src 'none'; script-src 'self' https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'self'; base-uri 'none'; form-action 'none'
```

from a route table that answers `/`, `/index.html`, `/client.js`, `/client-lib.js`, `/events` and `/c`, and 404s everything else.

1. **DOMPurify drops what it does not know**, and it does not know `likec4-view`. The `<script>` that would define it goes the same way.
2. **The CSP admits scripts from the server's own origin and jsDelivr.** A bundle anywhere else will not load.
3. **The server owns its routes.** There is nowhere to put the bundle for gate 2 to admit.

What the visualizer *does* already carry is Mermaid 11: it loads the library and calls `mermaid.run()` over fenced code blocks. LikeC4 renders any view to Mermaid. That is the opening, and it is the reason there are two lanes instead of one.

## Lane A — Mermaid in the page

The default, and the one to rely on. `gen` renders every view to `.mmd`; `embed` writes it into the page as a fenced ```mermaid block.

It renders in the OpenWiki visualizer, on GitHub, in VS Code, and in any Markdown viewer. It works at every OpenWiki version, including the 0.3.2 currently installed. Nothing is patched, so nothing breaks on upgrade.

The cost is that the diagram is static: no panning, no drilling into a nested element, no view browser.

## Lane B — the interactive component

`openwiki visualize … --export <dir>` writes the visualizer as plain files. That directory is ours, so all three gates become ours to move:

- **Gate 3** — the bundle is written beside `index.html`.
- **Gate 2** — `script-src 'self'` already admits a same-origin sibling. No change needed for the bundle itself; the CSP is widened only for what LikeC4 needs at runtime, below.
- **Gate 1** — a shim, `likec4-bridge.js`, runs after DOMPurify has loaded and before the client module:

  ```js
  DOMPurify.setConfig({
    ADD_TAGS: ['likec4-view'],
    ADD_ATTR: ['view-id', 'browser', 'color-scheme', 'dynamic-variant'],
  });
  ```

`setConfig` is the load-bearing detail. It sets persistent configuration for every later `sanitize()` call, so the client's own bare `sanitize()` inherits permission for the element. **Nothing under `node_modules` is edited.** Patching `client.js` directly would work exactly once and break on the next `npm i -g openwiki`, silently.

The CSP gains three things and keeps everything else:

| Directive | Added | Why |
|---|---|---|
| `script-src` | `'wasm-unsafe-eval'` | LikeC4 lays out graphs with WebAssembly |
| `worker-src` | `'self' blob:` | `default-src` is `'none'`, so a worker needs saying explicitly |
| `font-src` | `data:` | the bundle inlines its fonts |

**Lane B needs OpenWiki 0.6.0 or newer**, which is when `--export` arrived. The installed version is 0.3.2. `doctor` says which lane is available; nothing in the wiki depends on lane B.

## The marker convention

A page claims a view with a marker pair. Everything between the lines belongs to the generator and is rewritten on every `embed`; everything outside belongs to whoever wrote the page.

```markdown
Prose you wrote stays exactly as it is.

<!-- likec4: placeholderContext -->
<!-- /likec4 -->

So does this.
```

After `embed`, the region holds the Mermaid block and the interactive element. Re-running changes nothing, so a no-op commit stays a no-op.

The shape matches the markers already used in this project — `<!-- writing gate: begin -->` in `modes/_custom.md`, `<!-- HEADER -->` in the Work Sans CV template — so a reader meets one convention rather than three.

**A marker naming a view the model no longer defines is an error, not an empty block.** That failure comes from renaming a view, and an empty diagram is exactly how it goes unnoticed. `embed --check` exits non-zero, so it can gate a commit.

## Commands

```bash
node fork/openwiki-likec4.mjs doctor         # versions, generated views, which lane is live
node fork/openwiki-likec4.mjs gen            # validate the model, render Mermaid + the bundle
node fork/openwiki-likec4.mjs embed          # fill the marked regions under openwiki/
node fork/openwiki-likec4.mjs embed --check  # fail if any region is stale
node fork/openwiki-likec4.mjs export <dir>   # lane B: patch an exported visualizer
node fork/openwiki-likec4.mjs --self-test
```

The usual loop after changing the model:

```bash
node fork/openwiki-likec4.mjs gen && node fork/openwiki-likec4.mjs embed
```

Lane B, once OpenWiki is new enough:

```bash
openwiki visualize openwiki --export build/wiki
node fork/openwiki-likec4.mjs export build/wiki
```

## Layout

| Path | What it is | Committed |
|---|---|---|
| `fork/likec4/package.json` | the pinned LikeC4 version | yes |
| `fork/likec4/src/*.c4` | specification, model, views | yes |
| `fork/likec4/generated/` | `.mmd` per view, and the component bundle | no, gitignored |
| `fork/openwiki-likec4.mjs` | the bridge | yes |
| `openwiki/` | the wiki OpenWiki writes | yes, once it exists |

LikeC4 is pinned in its own `package.json` under `fork/likec4/` rather than the repository's. That keeps it at layer 2: taking an upstream release never has to merge a dependency line, and a diagram cannot change because a machine has a different LikeC4 installed. Install it with `npm install --prefix fork/likec4`.

## When it breaks

**`export` refuses with "page shell changed".** OpenWiki moved its client script tag. That is the guard doing its job: read the new shell, confirm the shim can still run between DOMPurify and the client, then update the anchor in `patchExportDir`. Do not reach for a looser regular expression; a patch that matches anything produces a page that loads and renders nothing.

**A view is blank in the visualizer but fine on GitHub.** Mermaid 11 syntax against an older Mermaid. Check which version the page shell pins.

**Lane B renders nothing and the console shows a CSP violation.** LikeC4 needed a directive this script does not widen. Add it to `widenCsp`, with a comment saying which feature needed it, and a test.

**`gen` says the model is invalid.** It stops before rendering on purpose. An invalid model still renders *something*, and a quietly wrong diagram in a wiki is worse than no diagram.

## Upstream

Lane B works within OpenWiki's extension points and patches nothing, so there is no patch to send. If it ever needs one, the shape worth proposing is a documented hook for additional sanitizer tags and static assets — the thing every embedded-diagram tool will want, not a LikeC4 special case.
