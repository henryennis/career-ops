#!/usr/bin/env node
// cv-templates.mjs — discover, resolve, and validate CV / cover-letter templates.
// Single source of truth for "which template file, and is it usable?".
// Backward-compatible: with no config and no named files, resolves the base
// templates/cv-template.html (name "standard"), identical to prior behavior.
//
// Templates are discovered in two roots (see templateRoots): the code tree's
// templates/ and, when a data root is configured, the data root's templates/.
// A pack kept in the data root lists and resolves exactly like a shipped one.

import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = resolve(__dirname, 'templates');

// config/profile.yml is a user-layer file, so it lives in the data root: every
// other reader of it (scan.mjs, company-history.mjs, followup-cadence.mjs)
// resolves it from getCareerOpsRoot(). Anchoring it to the code directory meant
// a `cv.template` default in a data root's profile was silently ignored while
// generate-pdf.mjs read `style:` and `cv.sections` from the very same file.
// Computed per call rather than at import so the environment is read when the
// resolver runs, which is what lets a test point it at a fixture.
function defaultProfilePath() {
  return process.env.CAREER_OPS_PROFILE || resolve(getCareerOpsRoot(), 'config', 'profile.yml');
}

// One canonical spelling for "is this the same path?". A path that does not
// exist yet keeps its lexical form, which is the right answer for a data root
// whose templates/ has not been created.
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The directories templates are discovered in, in order: the code tree's
 * templates/, then the data root's templates/ when the data root is a
 * different directory.
 *
 * The second root is what lets a user keep a template pack with their personal
 * files: it survives `update-system.mjs apply`, it is never committed to a
 * public fork, and the pack still lists and resolves by name like a shipped
 * one. With no data root configured both spell the same directory and it is
 * scanned once, so a checkout with no marker sees exactly the templates it saw
 * before.
 *
 * @returns {string[]} Absolute directories; a missing one is skipped by discovery.
 */
export function templateRoots() {
  const roots = [DEFAULT_TEMPLATES_DIR];
  const userRoot = resolve(getCareerOpsRoot(), 'templates');
  if (canonicalPath(userRoot) !== canonicalPath(DEFAULT_TEMPLATES_DIR)) roots.push(userRoot);
  return roots;
}

export const KINDS = {
  cv: {
    prefix: 'cv-template',
    profileKey: ['cv', 'template'],
    required: ['NAME', 'EXPERIENCE', 'EDUCATION'],
  },
  cover: {
    prefix: 'cover-letter-template',
    profileKey: ['cover_letter', 'template'],
    required: ['NAME', 'ROLE_TITLE', 'OPENING'],
  },
};

export function prettify(name) {
  return name
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function kebab(display) {
  return String(display)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The only template formats the resolver recognizes. `format` reaches path
// construction (fileFor) unmodified, so it must be allowlisted or a value like
// `--format=../../etc/passwd` would traverse out of the templates dir.
const VALID_FORMATS = new Set(['html', 'tex']);
function assertFormat(format) {
  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Unsupported template format: ${format} (expected html or tex)`);
  }
}

// filename → {name, format} | null. Base "cv-template.html" → name "standard";
// "cv-template.<name>.html" → that name. Only html/tex are recognized.
function parseFilename(prefix, file) {
  const m = file.match(new RegExp(`^${prefix}(?:\\.([a-z0-9-]+))?\\.(html|tex)$`));
  if (!m) return null;
  return { name: m[1] || 'standard', format: m[2] };
}

export function parseMeta(path) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return {};
  }
  const block = text.match(/<!--\s*career-ops-template\s*([\s\S]*?)-->/);
  if (!block) return {};
  const meta = {};
  for (const line of block[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+?)\s*$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2];
  }
  return meta;
}

// Build the entry a discovered template file contributes. `root` is the
// templates directory the file was found under (one of templateRoots()).
function entryFor(parsed, path, pack, root) {
  const meta = parseMeta(path);
  return {
    name: parsed.name,
    displayName: meta.name || prettify(parsed.name),
    path,
    format: parsed.format,
    meta,
    pack,
    root,
  };
}

// Discover every template of `kind`/`format` under `dir`: the flat files that
// have always lived there, plus one level of *template packs* (#3202).
//
// A pack is a subdirectory holding its own `<prefix>.<name>.<format>` next to
// its own `sections/`. That co-location is the whole point: build-cv-html.mjs
// resolves partials relative to the template file, so a pack gets its own DOM
// without touching the `sections/` every flat template shares.
//
// The template name comes from the *filename*, exactly as it does for a flat
// template — never from the directory name. `templates/ats/cv-template.ats.html`
// is template "ats" because of the file, and the directory could be called
// anything. That keeps one naming rule instead of two.
//
// Packs are one level deep only. Nothing here recurses: a pack's `sections/`
// must not be mistaken for a nested pack, and an arbitrarily deep walk over a
// user-writable directory is a cost (and a surface) with no use case behind it.
//
// Symlinked directories are followed, which needs an explicit stat because
// `Dirent.isDirectory()` is false for a symlink.
//
// Refusing them looks like the safer default and isn't. A symlink grants no
// capability its creator lacked: anyone who can drop `templates/mine` as a link
// can drop it as a real directory holding the same file, so skipping buys no
// protection against a hostile template — it only makes a legitimate one
// vanish. The repo's actual symlink guards are on a different axis, and both
// stay intact: resolveInsideRepo() in reconcile-pipeline.mjs resolves
// user-supplied path *arguments* before a boundary check, and contacts.mjs
// refuses to *write* through a link escaping the project. Discovery does
// neither — it enumerates a directory the project owns and only ever reads.
//
// Cycles are not a concern precisely because this walk is one level and never
// recurses; a link pointing at its own ancestor is read once as a directory
// and contributes whatever template files sit at its top level.
//
// The deciding cost is silent invisibility. career-ops sanctions a symlinked
// user layer (#524), so a pack maintained outside the repo is a supported
// setup, and skipping it would drop the template from the registry with
// nothing said — the same failure this file refuses to accept for name
// collisions.
//
// Returns Map<name, entry>. A name claimed twice throws — see assertNoCollision.
//
// `dirs` is the list of roots to scan, in order. The same collision rule spans
// them: a name present in the code tree and again in the data root is an
// error naming both files, never a precedence decision.
function discover(kind, { dirs, format }) {
  const cfg = KINDS[kind];
  const found = new Map();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    const claim = (parsed, path, pack) => {
      if (parsed.format !== format) return;
      const prior = found.get(parsed.name);
      if (prior) assertNoCollision(parsed.name, prior, { path, root: dir });
      found.set(parsed.name, entryFor(parsed, path, pack, dir));
    };

    // One listing serves both passes. Reading twice would let the flat pass and
    // the pack pass see different directory states, and the collision check spans
    // them: a file present for one read and gone for the other decides whether a
    // name is ambiguous. A single snapshot makes that verdict reproducible.
    const top = readdirSync(dir, { withFileTypes: true });

    // Flat templates. Unchanged from before packs existed, including the fact
    // that a symlinked file is read through like any other.
    for (const d of top) {
      const parsed = parseFilename(cfg.prefix, d.name);
      if (parsed) claim(parsed, resolve(dir, d.name), null);
    }

    // Packs, one level down.
    for (const d of top) {
      const packDir = resolve(dir, d.name);
      if (!d.isDirectory()) {
        // statSync follows the link; it throws on a broken one, which is not a pack.
        if (!d.isSymbolicLink()) continue;
        try {
          if (!statSync(packDir).isDirectory()) continue;
        } catch {
          continue;
        }
      }
      let inner;
      try {
        inner = readdirSync(packDir);
      } catch {
        continue; // unreadable directory is not a pack
      }
      for (const file of inner) {
        const parsed = parseFilename(cfg.prefix, file);
        if (parsed) claim(parsed, resolve(packDir, file), d.name);
      }
    }
  }

  return found;
}

// A template name resolves to exactly one file, enforced when it is discovered
// rather than settled by a precedence rule.
//
// Precedence would have to pick a winner while both files exist and both look
// correct — during a migration from a flat template to a pack, say — and the
// loser would simply stop being rendered, silently, with nothing in the output
// naming the file that won. Failing at discovery costs one clear error and
// makes the ambiguity impossible to ship past.
//
// Two files under one root are named relative to it. Across roots (a shipped
// template and a data-root pack claiming one name) both paths are shown in
// full, because a name relative to one root points at nothing in the other.
function assertNoCollision(name, a, b) {
  const sameRoot = a.root === b.root;
  const shown = (entry) => (sameRoot ? entry.path.slice(entry.root.length + 1) || entry.path : entry.path);
  const [x, y] = [shown(a), shown(b)].sort();
  throw new Error(
    `Template name "${name}" is claimed by two files: ${x} and ${y}. `
      + `A name must resolve to one template — rename one, or remove the one you no longer use.`
  );
}

// An explicit `dir` scans that directory alone, which is what every caller
// that passes one (the test fixtures) means by it. Without one, discovery
// covers every root.
function rootsFor(dir) {
  return dir ? [dir] : templateRoots();
}

export function listTemplates(kind, { dir, format = 'html' } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  assertFormat(format);
  return [...discover(kind, { dirs: rootsFor(dir), format }).values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The discovered entry whose file is `templatePath`, or null when that path is
 * not a discovered template — a file handed over by arbitrary path, say.
 *
 * Paths are compared canonically, so a symlinked spelling still matches.
 * build-cv-html.mjs asks this before running a pack's renderer: code beside a
 * template runs only when discovery, not the command line, vouches for where
 * the template lives.
 */
export function findTemplateEntry(kind, templatePath, { format = 'html' } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  assertFormat(format);
  const wanted = canonicalPath(templatePath);
  for (const entry of discover(kind, { dirs: templateRoots(), format }).values()) {
    if (canonicalPath(entry.path) === wanted) return entry;
  }
  return null;
}

export function validateTemplate(path, kind) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  const text = readFileSync(path, 'utf-8');
  const missing = cfg.required.filter((ph) => !text.includes(`{{${ph}}}`));
  return { ok: missing.length === 0, missing };
}

export function loadProfileDefault(kind, { profilePath = defaultProfilePath() } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  if (!existsSync(profilePath)) return null;
  let doc;
  try {
    doc = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return null;
  }
  let node = doc;
  for (const key of cfg.profileKey) node = node?.[key];
  return typeof node === 'string' && node.trim() ? node.trim() : null;
}

export function resolveTemplate(kind, name, opts = {}) {
  const cfg = KINDS[kind];
  if (!cfg) throw new Error(`Unknown template kind: ${kind}`);
  const {
    dir,
    format = 'html',
    profilePath = defaultProfilePath(),
    fallback = false,
  } = opts;
  assertFormat(format);

  const explicit = Boolean(name && String(name).trim());
  let chosen = kebab(explicit ? name : loadProfileDefault(kind, { profilePath }) || 'standard');
  const fileFor = (n) => (n === 'standard' ? `${cfg.prefix}.${format}` : `${cfg.prefix}.${n}.${format}`);

  // Resolution goes through the same discovery as listTemplates, so a name that
  // lists is a name that resolves. Constructing `dir/fileFor(chosen)` directly
  // would find flat templates only: a pack would list fine and then throw here,
  // which is the failure mode that passes review because the demo path works.
  // Every by-name caller lands here — build-cv-latex.mjs, generate-cover-letter.mjs.
  const found = discover(kind, { dirs: rootsFor(dir), format });

  let entry = found.get(chosen);
  if (!entry && fallback && chosen !== 'standard') {
    chosen = 'standard';
    entry = found.get(chosen);
  }
  if (!entry) {
    throw new Error(`Template not found for kind=${kind} name=${chosen} (${fileFor(chosen)})`);
  }
  const path = entry.path;
  if (format === 'html') {
    const v = validateTemplate(path, kind);
    if (!v.ok) {
      // Name the file that is actually short, not the flat filename it would
      // have had. For a pack these differ, and the flat name points at nothing.
      const where = entry.pack ? `${entry.pack}/${fileFor(chosen)}` : fileFor(chosen);
      throw new Error(
        `Template ${where} missing required placeholders: ${v.missing.map((m) => `{{${m}}}`).join(', ')}`
      );
    }
  }
  return path;
}

// ---- CLI ----
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const kind = argv[1];
  const flags = Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
  );
  const positionals = argv.slice(2).filter((a) => !a.startsWith('--'));
  const format = flags.format || 'html';
  try {
    if (cmd === 'list') {
      const items = listTemplates(kind, { format }).map(({ name, displayName }) => ({ name, displayName }));
      process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    } else if (cmd === 'resolve') {
      const name = positionals[0];
      process.stdout.write(resolveTemplate(kind, name, { format, fallback: Boolean(flags.fallback) }) + '\n');
    } else {
      process.stderr.write('Usage: node cv-templates.mjs <list|resolve> <cv|cover> [name] [--format=html|tex] [--fallback]\n');
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
