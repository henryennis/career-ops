# __DISPLAY_NAME__

A CV template pack, scaffolded from __SOURCE__ on __DATE__. It lives in the data root, so the checkout never sees it and an upstream sync cannot touch it.

## Files

| File | Role |
|---|---|
| `cv-template.__NAME__.html` | The page: CSS and the `{{PLACEHOLDER}}` layout. Its filename is the template's name. |
| `sections/*.html` | Per-entry markup for experience, projects, education, certifications, awards, competencies, skills. A missing file falls back to the builder's default markup for that section. |
| `render.mjs` | Optional. When present, its `render` function produces the document instead of the plain fill; the comments inside state the contract. |

## The loop

```bash
node fork/preview-cv-template.mjs __NAME__          # sample CV to HTML, plus an ATS audit
node fork/preview-cv-template.mjs __NAME__ --pdf    # and to PDF
```

Output lands in `output/cv-template-preview/` under the data root. The sample candidate is fictional (`fork/cv-template-kit/sample-cv-payload.json`); pass `--payload <file>` to preview a real payload.

Select the pack for one CV by asking for it by name, or make it the default:

```yaml
# <data root>/config/profile.yml
cv:
  template: __NAME__
```

## What must stay

- `{{NAME}}`, `{{EXPERIENCE}}` and `{{EDUCATION}}`: the resolver refuses a template without them.
- The section markers (`<!-- WORK EXPERIENCE -->`, `<!-- PROJECTS -->`, ...) and the `<!-- END -->` sentinel after the last section: they bound the empty-section strip and the `cv.sections` reorder. A section that loses its marker is never stripped or moved; nothing else breaks.
- The `section-title` class on section headings: the ATS audit and the section-order guard read headings through it.
- Escaping: any payload text that reaches markup through `render.mjs` goes through `helpers.escapeHtml` first.

`fork/docs/cv-template-packs.md` has the longer version.
