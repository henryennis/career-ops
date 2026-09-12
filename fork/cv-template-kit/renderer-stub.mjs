// render.mjs: this pack's renderer. Delete the file to go back to the plain
// placeholder fill; build-cv-html.mjs only looks for it, never requires it.
//
// The contract (build-cv-html.mjs, "Pack renderers"; fork/docs/cv-template-packs.md):
//
//   export function render({ payload, template, options, helpers })
//     -> string | Promise<string>, the full HTML document
//
//   payload    the CV payload, already validated against lib/cv-payload-schema.mjs
//              (a payload with the wrong keys never reaches this function) and
//              with candidate.photo turned into a data URL when one was given
//   template   the text of cv-template.<name>.html beside this file
//   options    templatePath, packDirectory, lang, pageFormat ('a4' | 'letter'),
//              pageWidth ('210mm' | '8.5in'), sectionTitles (defaults merged
//              with payload.sections), candidate, partials (the parsed files
//              of this pack's sections/), and substitutions: the complete
//              {{PLACEHOLDER}} -> markup map the plain fill would apply
//   helpers    escapeHtml(text)                 escape before putting any payload text in markup
//              sanitizeUrl(url)                 mailto:/tel:/http(s): only, escaped for an href
//              sanitizeImageSrc(src)            data: image or http(s) only
//              joinItems(items)                 skills[].items as one comma-joined string
//              fillTemplate(text, overrides)    the plain fill: contact row, photo, empty-section
//                                               strip, every placeholder; `overrides` replaces
//                                               entries of options.substitutions by key
//              buildContactRow, buildPhoto, buildCompetencies, buildExperience,
//              buildProjects, buildEducation, buildCertifications, buildAwards,
//              buildInterests, buildSkills      the builders behind those substitutions,
//                                               each taking (entries, partial)
//              stripEmptySections(html)         the marker-based strip, bound to this payload
//
// What happens to what you return: pack fonts under ./fonts/ are inlined, the
// empty-section strip runs once more by marker, and any {{PLACEHOLDER}} left in
// the document fails the build. Keep the `<!-- WORK EXPERIENCE -->`-style
// markers, the `<!-- END -->` sentinel after the last section, and the
// `.section-title` class on headings: the strip, the profile's cv.sections
// order, the section-order guard and the ATS heading audit all key off them.
// The fact gate reads visible text, so any number you print must come from
// the payload.
//
// This file runs as you, with your permissions, the same as a plugin.

export function render({ template, helpers }) {
  // The plain fill, unchanged. Replace a placeholder to start:
  //
  //   const skills = myOwnSkillsMarkup(payload, helpers);   // escape every string
  //   return helpers.fillTemplate(template, { SKILLS: skills });
  //
  // or post-process the finished document:
  //
  //   return helpers.fillTemplate(template).replace('<body>', '<body data-pack="mine">');
  return helpers.fillTemplate(template);
}
