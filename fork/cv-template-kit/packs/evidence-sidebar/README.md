# Evidence Sidebar

A two-column CV pack with a computed right-hand rail. The narrative (summary, competencies, experience, projects, education, certifications, awards, interests) runs down the left in a single flow. The rail carries the contact details and the Skills list, and beside every skill sits a bar whose length is how many lines of the CV mention it: the summary, the experience bullets, the project descriptions and tech lines. A skill nothing on the page backs is listed in grey with an empty track.

That bar is the reason this is a pack with a renderer rather than a template with different CSS. The placeholder fill can print `skills[].items`; it cannot count how often the bullets say "Kubernetes". `render.mjs` does that count and hands the result back into the ordinary fill, so everything else on the page (markers, contact row, photo, empty sections) behaves as in a shipped template.

Install it under a name of your own and preview it:

```bash
node fork/new-cv-template.mjs my-sidebar --pack fork/cv-template-kit/packs/evidence-sidebar
node fork/preview-cv-template.mjs my-sidebar --pdf
```

## What the renderer computes

For each skill, `render.mjs` builds a whole-word pattern ("Go" does not match "Django", "SQL" does not match "PostgreSQL"; "C++" and ".NET" match as written) and counts the lines that match. Four mentions or more fill the track. The count is kept in a `data-evidence` attribute and never printed: `verify-cv-facts.mjs` gates a real CV on the numbers in its visible text against `cv.md`, and a count this pack invents would not be there. The legend under the list says what the bars mean without a figure.

Read the empty tracks as feedback to yourself as much as to the reader. A skill the rest of the page never mentions is a claim with no evidence on it; either a bullet should carry it, or it does not belong in the list for this application.

## Document order versus visual order

The DOM puts `<main>` before `<aside>`; CSS grid places the rail on the right. Two things depend on that order. A PDF text extractor reads the story first and the skills last, which is the order a recruiter reads it in. And `generate-pdf.mjs`'s section-order guard, which reads `.section-title` headings in document order and compares them with `cv.md` (or with the canonical tailored order), sees summary, competencies, experience, projects, education, certifications, awards, interests, skills: the canonical order, so the guard passes without `--allow-reorder`.

## What the guards see

- Every section keeps its `<!-- WORK EXPERIENCE -->`-style marker. The last section of the main column is followed by `<!-- END MAIN -->` and the rail's Skills section by `<!-- END -->`; both are all-caps comments, so the empty-section strip stops at them instead of running into the column markup. An empty Interests section is removed without taking `</main>` with it.
- `cv.sections` in the profile can permute the main-column sections; each is a balanced block between two markers. Skills can be named too; moving it out of the rail is allowed and looks odd, so leave it where it is.
- Headings carry `class="section-title"`, which the section-order guard and `verify-ats.mjs` both read.
- The style tokens in the profile apply: `accent_color` recolours the rule, the headings and the bars, `font_family` and `font_size` the whole page, `margin` the page margin. `--rail-width` and `--rail-tint` are the pack's own variables at the top of the stylesheet.

## The ATS trade-off, stated plainly

`verify-ats.mjs` scores the sample render 92/100, grade A, with the same two warnings the shipped ATS pack earns: it reads `font-family: var(--font-family)` literally and flags the variable as a non-standard font, and it flags the `display: none` on the contact separators as possible hidden text. Neither is a real parse problem. What the audit cannot measure is the one that matters: this is a two-column page. CSS grid is not a `<table>` and not `column-count`, so the audit does not penalise it, but a parser that works from rendered positions rather than document order can interleave the rail with the main column, and a skills list read mid-sentence is worse than none. Send this pack to people. For a portal that parses the PDF before a person sees it, render the same payload through the shipped `ats` template instead; it is one name in the same command.

## Files

| File | Role |
|---|---|
| `cv-template.evidence-sidebar.html` | Layout and CSS; the filename is the template's name until `new-cv-template.mjs` renames it |
| `sections/experience.html` | Role first, then employer, location and period on one line. The other sections use the builder's default markup |
| `render.mjs` | The evidence count and the skills markup; the rest of the page goes through `helpers.fillTemplate` |
