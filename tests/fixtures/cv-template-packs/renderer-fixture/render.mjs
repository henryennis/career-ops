// tests/fixtures/cv-template-packs/renderer-fixture/render.mjs
//
// The smallest pack renderer that exercises the whole contract. It lives in
// the fixtures so tests/template-pack-renderer.test.mjs can copy it into a
// temporary data root and drive build-cv-html.mjs against it.
//
// The contract (build-cv-html.mjs, "Pack renderers"):
//
//   export function render({ payload, template, options, helpers })
//     -> string | Promise<string>, the full HTML document
//
//   payload   the validated CV payload, candidate photo already prepared
//   template  the text of the pack's cv-template.<name>.html
//   options   templatePath, packDirectory, lang, pageFormat, pageWidth,
//             sectionTitles, candidate, partials, substitutions (the complete
//             {{PLACEHOLDER}} map the default fill would apply)
//   helpers   escapeHtml, sanitizeUrl, sanitizeImageSrc, joinItems,
//             fillTemplate(text, overrides), buildContactRow, buildPhoto, the
//             section builders, and stripEmptySections bound to this payload
//
// This one keeps the default fill for everything except Skills, which it
// renders itself with an evidence count: how many experience bullets mention
// each skill. That is a computation the placeholder system cannot express,
// which is the reason a renderer exists at all.

import { writeFileSync } from 'fs';

function mentionCount(skill, bullets) {
  const needle = skill.toLowerCase();
  return bullets.filter((bullet) => String(bullet).toLowerCase().includes(needle)).length;
}

export function render({ payload, template, options, helpers }) {
  // The tests use this to prove the renderer did or did not run: a rejected
  // payload must never reach this line.
  if (process.env.RENDERER_FIXTURE_SENTINEL) writeFileSync(process.env.RENDERER_FIXTURE_SENTINEL, 'ran');

  const { escapeHtml, fillTemplate } = helpers;
  const bullets = (payload.experience || []).flatMap((entry) => entry.bullets || []);

  const groups = (payload.skills || []).map((group) => {
    const items = (Array.isArray(group.items) ? group.items : String(group.items).split(','))
      .map((item) => String(item).trim())
      .filter(Boolean);
    const rows = items.map((item) => {
      const count = mentionCount(item, bullets);
      const bar = count ? ` <span class="evidence-bar" style="width:${count * 12}px"></span>` : '';
      return `<li class="skill" data-evidence="${count}">${escapeHtml(item)}${bar}</li>`;
    }).join('');
    const label = group.category ? `<strong>${escapeHtml(group.category)}</strong>` : '';
    return `<div class="skill-group">${label}<ul>${rows}</ul></div>`;
  }).join('\n');

  const html = fillTemplate(template, { SKILLS: groups });

  // A marker the tests look for, carried on <body> so nothing the payload can
  // put in the document collides with it.
  return html.replace(
    '<body>',
    `<body data-rendered-by="renderer-fixture" data-bullets="${bullets.length}" data-page-format="${escapeHtml(options.pageFormat)}">`,
  );
}
