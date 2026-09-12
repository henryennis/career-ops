# CV template packs

A CV template in career-ops is an HTML file with `{{PLACEHOLDER}}` tokens that `build-cv-html.mjs` fills from a JSON payload, then `generate-pdf.mjs` prints. Upstream ships seven of them, and they all produce the same document with different CSS, because that is all the fill can do. This page is about making one of your own that does more, keeping it out of the checkout, and still passing the checks a real CV has to pass.

Three pieces make that work. Two are patches this fork carries on `patched` and has offered upstream; one is fork tooling under `fork/`.

| Piece | Layer | What it gives you |
|---|---|---|
| Template discovery covers the data root | 3, offered upstream | A pack in `<data root>/templates/<name>/` lists and resolves by name like a shipped one, and `cv.template` in the data root's profile can name it |
| A pack may ship a renderer | 3, offered upstream | A `render.mjs` beside the template produces the document from the validated payload, with the builder's own helpers, when the placeholder fill is not enough |
| The kit: `fork/new-cv-template.mjs`, `fork/preview-cv-template.mjs`, an example pack | 2, fork only | Scaffold a pack, render a fictional sample through the real builder to HTML and PDF, see the ATS score, repeat |

A fourth patch, small and also offered upstream, makes `generate-pdf.mjs` accept input and output paths under the data root; before it, the guard that keeps renders inside the workspace was anchored to the install directory, so a data-root user could not render into their own `output/` at all.

## Where a pack lives, and why

The data root (`.career-ops-data` marker, or `CAREER_OPS_DATA_DIR`) is where this fork keeps everything personal: `cv.md`, the profile, the tracker, reports. A template is personal in the same way. Kept in the checkout it would be either a system file (reverted on update) or a committed file in a public fork. In `<data root>/templates/` it is neither, and `cv-templates.mjs` scans that directory as a second root on every call:

```bash
node cv-templates.mjs list cv              # shipped templates plus yours
node cv-templates.mjs resolve cv <name>    # the absolute path, wherever the pack is
```

Names come from filenames, exactly as for shipped templates: `templates/<anything>/cv-template.<name>.html` is template `<name>`. One name resolves to one file across both roots; a data-root file that claims a shipped name fails discovery with a message naming both files, so a pack can never silently shadow (or be shadowed by) a template upstream ships later.

`node cv-templates.mjs resolve cv` with no name reads `cv.template` from the data root's `config/profile.yml`. Upstream read that default from the checkout's profile, which a data-root user does not have; the patch aligns it with `generate-pdf.mjs`, which already read `style:` and `cv.sections` from the data root.

## Anatomy of a pack

```
<data root>/templates/<name>/
  cv-template.<name>.html   the page: CSS and {{PLACEHOLDER}} layout
  sections/                 per-entry partials; a missing one falls back to the builder's default
  fonts/                    optional, referenced as url('./fonts/<file>') and inlined at build time
  render.mjs                optional, see below
  README.md                 yours
```

The template contract is upstream's and documented in `templates/README.md`: `{{NAME}}`, `{{EXPERIENCE}}` and `{{EDUCATION}}` must be present, and the section markers (`<!-- WORK EXPERIENCE -->`, `<!-- PROJECTS -->`, ...) with the `<!-- END -->` sentinel after the last section are what the empty-section strip and the `cv.sections` reorder key on. Partials use an `<!--ENTRY-->` zone with entry-level placeholders (`COMPANY`, `ROLE`, `BULLETS`) and conditional blocks; copy one from `templates/sections/` and change the markup inside the zone.

Fonts are the one thing that behaves differently outside the checkout. The shipped `resume-template.html` references `url('./fonts/...')` and `generate-pdf.mjs` inlines those from the repo-level `fonts/` at render time. A pack's own `fonts/` is out of that directory's reach, and a relative reference in the built HTML would resolve against `output/`, so `build-cv-html.mjs` inlines a pack's fonts as data URLs while it still knows the template's path. A reference the pack does not ship is left for `generate-pdf.mjs`, as before. The upstream warning applies: a variable woff2 can make PDF text extraction insert spaces inside words, which is why the shipped templates use system font stacks.

## The loop

```bash
node fork/new-cv-template.mjs <name>                 # from the shipped modern template
node fork/new-cv-template.mjs <name> --from ats      # from another shipped one (a pack brings its partials)
node fork/new-cv-template.mjs <name> --renderer      # with a render.mjs stub
node fork/new-cv-template.mjs <name> --pack fork/cv-template-kit/packs/evidence-sidebar

node fork/preview-cv-template.mjs <name>             # sample CV to HTML, plus the ATS audit
node fork/preview-cv-template.mjs <name> --pdf       # and to PDF
```

`new-cv-template.mjs` refuses a name that is taken, a name that is not kebab-case, and a data root that is the checkout itself (the pack would land in the code tree and be committed). `preview-cv-template.mjs` renders `fork/cv-template-kit/sample-cv-payload.json`, a fictional platform engineer with every section populated, into `<data root>/output/cv-template-preview/<name>.html` and `.pdf`, runs `verify-ats.mjs` on the HTML and prints the score with its issues. The PDF step runs with the fact gate off, because the sample's numbers are not in your `cv.md`, and the section-order guard downgraded to a warning; a real CV through the `pdf` mode keeps both. The manifest row the PDF step appends goes to a `pdf-index.tsv` in the preview directory, not to your `data/`.

Then edit the CSS, the partials or the renderer and run the preview again. When the pack is right, make it the default:

```yaml
# <data root>/config/profile.yml
cv:
  template: <name>
```

or ask for it by name in the `pdf` mode ("use the my-sidebar template"), which runs `node cv-templates.mjs resolve cv my-sidebar` and passes the path to the builder.

## Renderers: when the placeholder fill runs out

The fill substitutes what the builder computed: escaped scalars, the section builders' markup, the contact row, the photo. It cannot derive anything new from the payload. A renderer can. `build-cv-html.mjs` looks for `render.mjs` beside the template and, when it finds one in a discovered pack, calls

```js
export function render({ payload, template, options, helpers }) → string | Promise<string>
```

instead of filling the template itself. `payload` is already validated (a payload with the wrong keys never reaches the renderer) and the candidate photo already a data URL. `options` holds what the builder resolved on the way in, including `substitutions`, the complete placeholder map the fill would have applied. `helpers` are the builder's own functions, and the important one is `fillTemplate(text, overrides)`: the default fill, so a renderer can compute one section and let the fill do the rest. `templates/README.md` has the full argument table; `fork/cv-template-kit/renderer-stub.mjs` restates it in comments next to a passthrough implementation.

The builder treats the returned document the way it treats its own: pack fonts are inlined, empty sections are stripped by marker, and a leftover `{{PLACEHOLDER}}` fails the build. The report JSON names the renderer that ran. A renderer that throws prints its stack, since the person reading it wrote the code.

Two boundaries. A renderer runs only for a template that discovery recognises as a pack, in the code tree or the data root; the same `render.mjs` beside a template passed to the builder by arbitrary path is reported on stderr and ignored, so the template argument cannot be turned into a way to run code from anywhere. And inside that boundary a renderer is your code running as you, with your permissions, the same position `plugins/` occupies. There is no sandbox. Cover-letter templates have no renderer hook.

## The guards, and what a pack has to keep

A CV that comes out of the `pdf` mode passes through checks that were written against the shipped templates. None of them knows about renderers; they read markers, a class name and visible text, so a pack keeps them working by keeping those.

| Keep | Which check reads it | If it goes |
|---|---|---|
| The section markers and the `<!-- END -->` sentinel | Empty-section strip in the builder; `cv.sections` reorder in the PDF step | Those sections are neither stripped nor moved. Nothing else breaks; a bare heading may show for an empty section |
| `class="section-title"` on headings | Section-order guard in the PDF step; heading check in `verify-ats.mjs` | The guard compares fewer sections and can pass vacuously; the audit reports missing standard headings |
| `helpers.escapeHtml` on every payload string the renderer places itself | Nothing checks it; it is what keeps payload text from becoming markup | An `&` or `<` in a bullet breaks or injects markup. The fill escapes only what the fill inserts |
| Only payload-sourced numbers in visible text | Fact gate, `verify-cv-facts.mjs`, against `cv.md` | A figure the renderer invents (a count, a percentage) is flagged as an unsupported claim and the render is refused |
| Single-column text flow | `verify-ats.mjs` flags `<table>` and CSS `column-count`; real parsers judge by position | See the example pack's README for what a grid layout costs and when to use it |

The example pack keeps all five and its README states the one trade-off it makes on purpose.

## The example: Evidence Sidebar

`fork/cv-template-kit/packs/evidence-sidebar/` puts the narrative in a left column and a tinted rail on the right holding contact details and Skills, where each skill carries a bar sized by how many lines of the CV mention it. That count is the thing the fill cannot do and the reason the pack has a renderer. The main column comes first in the DOM, so a text extractor and the section-order guard both see the canonical order; the bars carry no printed number, so the fact gate has nothing to question. `verify-ats.mjs` scores the sample 92/100, grade A. Its README explains the design and states honestly that a two-column page is still a two-column page to a parser that reads by position: send it to people, and use the shipped `ats` template for portals that parse first.

## Tests, and what upstream sync will tell you

`tests/template-pack-roots.test.mjs`, `tests/template-pack-renderer.test.mjs` and `tests/generate-pdf-data-root.test.mjs` travel with the three patches and would go upstream with them. `tests/fork-cv-template-kit.test.mjs` is fork-only: it scaffolds into a temporary data root, installs the example pack, previews it and runs the section-order tools over the result. It exists so that an upstream change to the builder, the resolver or the guard that breaks the kit fails `fork/sync-upstream.sh`'s test step rather than your next design session. If one of the three patches conflicts on sync three times, `fork/README.md`'s kill rule applies to it like any other.
