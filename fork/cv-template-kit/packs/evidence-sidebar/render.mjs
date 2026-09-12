// fork/cv-template-kit/packs/evidence-sidebar/render.mjs
//
// Renderer for the Evidence Sidebar pack. The template is an ordinary
// placeholder template; this file replaces one placeholder, {{SKILLS}}, with
// markup the placeholder fill cannot produce: each skill carries a bar sized
// by how many lines of this CV back it (the summary, the experience bullets,
// the project descriptions and tech lines). Everything else goes through
// helpers.fillTemplate unchanged, so the section markers, the contact row,
// the photo and the empty-section strip behave as in a shipped template.
//
// No number is printed: the bar is the weight, and the count sits in a
// data-evidence attribute for tests and tooling. verify-cv-facts.mjs gates a
// real CV on the numbers in its visible text, and a count this file invents
// would not be in cv.md.
//
// Contract: build-cv-html.mjs, "Pack renderers"; the tour is in
// fork/docs/cv-template-packs.md.

// Four or more mentions fill the track; the bar is a weight, not a chart.
const EVIDENCE_CAP = 4;

function linesOf(payload) {
  const lines = [];
  if (typeof payload.summary === 'string') lines.push(payload.summary);
  for (const entry of payload.experience || []) {
    for (const bullet of entry.bullets || []) lines.push(String(bullet));
  }
  for (const project of payload.projects || []) {
    if (project.description) lines.push(String(project.description));
    for (const bullet of project.bullets || []) lines.push(String(bullet));
    if (project.tech) lines.push(String(project.tech));
  }
  return lines.map((line) => line.toLowerCase());
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word where the skill starts or ends with a word character, so "Go"
// does not match "Django" and "SQL" does not match "PostgreSQL"; a skill with
// punctuation at an edge ("C++", ".NET") is matched as written.
function mentionPattern(skill) {
  const escaped = escapeRegExp(skill.toLowerCase());
  const leading = /^\w/.test(skill) ? '(?<!\\w)' : '';
  const trailing = /\w$/.test(skill) ? '(?!\\w)' : '';
  return new RegExp(`${leading}${escaped}${trailing}`);
}

function itemsOf(group) {
  const raw = Array.isArray(group.items) ? group.items : String(group.items ?? '').split(',');
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

export function render({ payload, template, helpers }) {
  const { escapeHtml, fillTemplate } = helpers;
  const lines = linesOf(payload);
  let backed = 0;
  let total = 0;

  const groups = (payload.skills || []).map((group) => {
    const rows = itemsOf(group).map((skill) => {
      const pattern = mentionPattern(skill);
      const count = lines.filter((line) => pattern.test(line)).length;
      total += 1;
      if (count) backed += 1;
      const width = Math.round((Math.min(count, EVIDENCE_CAP) / EVIDENCE_CAP) * 100);
      const fill = count ? `<span class="evidence-fill" style="width:${width}%"></span>` : '';
      return `<div class="skill${count ? '' : ' skill--unbacked'}" data-evidence="${count}">`
        + `<span class="skill-name">${escapeHtml(skill)}</span>`
        + `<span class="evidence-track">${fill}</span>`
        + '</div>';
    }).join('\n');
    const label = group.category ? `<div class="skill-category">${escapeHtml(group.category)}</div>` : '';
    return `<div class="skill-group">${label}\n${rows}</div>`;
  }).join('\n');

  const legend = total
    ? '<p class="evidence-legend">Bar length: how often the summary, experience and projects on this page mention the skill.</p>'
    : '';

  const html = fillTemplate(template, { SKILLS: groups ? `${groups}\n${legend}` : '' });
  return html.replace(
    '<body>',
    `<body data-rendered-by="evidence-sidebar" data-skills-backed="${backed}" data-skills-total="${total}">`,
  );
}
