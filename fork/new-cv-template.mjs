#!/usr/bin/env node
// fork/new-cv-template.mjs: scaffold a CV template pack in the data root.
//
//   node fork/new-cv-template.mjs <name> [--from <template>] [--pack <directory>] [--renderer]
//
// Writes <data root>/templates/<name>/ with cv-template.<name>.html, a
// sections/ directory of per-entry partials, an optional render.mjs and a
// README. Nothing registers it: cv-templates.mjs scans <data root>/templates
// on every call, so the pack lists, resolves by name and can be the profile
// default as soon as the files exist. fork/docs/cv-template-packs.md explains
// the pieces and the loop.
//
//   --from <template>   copy a discovered template as the starting point
//                       (default: modern). A flat template brings the shared
//                       templates/sections/ partials with it; a pack brings its
//                       own sections/, fonts/, render.mjs and README.
//   --pack <directory>  start from a pack directory that is not discovered,
//                       such as fork/cv-template-kit/packs/evidence-sidebar
//   --renderer          add a render.mjs stub when the source has none
//   --help

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from '../lib/is-main-module.mjs';
import { isNestedCheckout } from '../lib/mjs-files.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { listTemplates, resolveTemplate, prettify } from '../cv-templates.mjs';

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kitDirectory = join(codeRoot, 'fork', 'cv-template-kit');
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEMPLATE_FILE_PATTERN = /^cv-template(?:\.[a-z0-9-]+)?\.html$/;

function usage() {
  return [
    'Usage: node fork/new-cv-template.mjs <name> [--from <template>] [--pack <directory>] [--renderer]',
    '',
    'Scaffold <data root>/templates/<name>/ as a CV template pack.',
    '  --from <template>   discovered template to copy (default: modern)',
    '  --pack <directory>  pack directory to copy instead, e.g. fork/cv-template-kit/packs/evidence-sidebar',
    '  --renderer          add a render.mjs stub when the source has none',
  ].join('\n');
}

export function parseArguments(argv) {
  const options = { name: null, from: 'modern', pack: null, renderer: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--renderer') options.renderer = true;
    else if (argument === '--from' || argument === '--pack') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} needs a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument.startsWith('-')) throw new Error(`unknown flag ${argument}`);
    else if (options.name === null) options.name = argument;
    else throw new Error(`unexpected argument ${argument}`);
  }
  return options;
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function templateFileIn(directory) {
  const files = readdirSync(directory).filter((file) => TEMPLATE_FILE_PATTERN.test(file));
  if (files.length !== 1) {
    throw new Error(`${directory} must hold exactly one cv-template*.html to be copied as a pack (found ${files.length})`);
  }
  return join(directory, files[0]);
}

// Rewrite the `name:` line of the career-ops-template header so `list cv`
// shows the new pack under its own display name rather than its source's.
export function withDisplayName(templateText, displayName) {
  const header = templateText.match(/<!--\s*career-ops-template\s*([\s\S]*?)-->/);
  if (!header) return `<!-- career-ops-template\nname: ${displayName}\nversion: 1.0.0\n-->\n${templateText}`;
  const lines = header[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const named = lines.some((line) => /^name\s*:/.test(line))
    ? lines.map((line) => (/^name\s*:/.test(line) ? `name: ${displayName}` : line))
    : [`name: ${displayName}`, ...lines];
  return templateText.replace(header[0], `<!-- career-ops-template\n${named.join('\n')}\n-->`);
}

// The files of the new pack, for the summary. A pack copied from somewhere
// could carry a checkout of its own; the shared rule for recursive walks in
// this repository (#3499) is to stop at one rather than list its contents.
function listFiles(directory, prefix = '') {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(directory, entry.name);
    const shown = prefix + entry.name;
    if (entry.isDirectory()) {
      if (isNestedCheckout(full)) continue;
      out.push(...listFiles(full, `${shown}/`));
    } else {
      out.push(shown);
    }
  }
  return out;
}

function readmeFor(name, sourceLabel) {
  return readFileSync(join(kitDirectory, 'pack-readme.md'), 'utf-8')
    .replaceAll('__DISPLAY_NAME__', prettify(name))
    .replaceAll('__NAME__', name)
    .replaceAll('__SOURCE__', sourceLabel)
    .replaceAll('__DATE__', new Date().toISOString().slice(0, 10));
}

/**
 * Create the pack. Returns { target, files, source } or throws with a message
 * fit to print.
 */
export function scaffold({ name, from = 'modern', pack = null, renderer = false }) {
  if (!name) throw new Error(`a pack name is required\n${usage()}`);
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`"${name}" is not a valid template name: lowercase letters, digits and single hyphens, as in "evidence-sidebar"`);
  }

  const dataRoot = getCareerOpsRoot();
  if (canonical(dataRoot) === canonical(codeRoot)) {
    throw new Error(
      'the data root is this checkout, so the pack would land in the code tree\'s templates/ and be committed with it. '
      + 'Point the data root at your personal files first (fork/bootstrap.sh --data-root <path>), then rerun.',
    );
  }

  // listTemplates throws on a name collision anywhere in the roots; that
  // message is the right thing to show, so it is not caught here.
  const discovered = listTemplates('cv');
  const taken = discovered.find((entry) => entry.name === name);
  if (taken) throw new Error(`a template named "${name}" already exists: ${taken.path}`);

  const target = join(dataRoot, 'templates', name);
  if (existsSync(target)) throw new Error(`${target} already exists`);

  let sourceTemplate;
  let sourceDirectory;
  let sourceIsPack;
  if (pack) {
    sourceDirectory = resolve(pack);
    if (!existsSync(sourceDirectory) || !statSync(sourceDirectory).isDirectory()) {
      throw new Error(`--pack ${pack}: not a directory`);
    }
    sourceTemplate = templateFileIn(sourceDirectory);
    sourceIsPack = true;
  } else {
    sourceTemplate = resolveTemplate('cv', from);
    sourceDirectory = dirname(sourceTemplate);
    sourceIsPack = Boolean(discovered.find((entry) => entry.path === sourceTemplate)?.pack);
  }
  const sourceLabel = relative(codeRoot, sourceTemplate).startsWith('..') ? sourceTemplate : relative(codeRoot, sourceTemplate);

  mkdirSync(dirname(target), { recursive: true });
  if (sourceIsPack) {
    // The whole pack comes along: its sections/, fonts/, render.mjs, README.
    // Its template file is replaced by one carrying the new name.
    cpSync(sourceDirectory, target, { recursive: true });
    rmSync(join(target, basename(sourceTemplate)));
  } else {
    mkdirSync(target, { recursive: true });
    // A flat template shares templates/sections/ with its siblings; the pack
    // gets its own copy so its partials can diverge.
    const sharedSections = join(sourceDirectory, 'sections');
    if (existsSync(sharedSections)) cpSync(sharedSections, join(target, 'sections'), { recursive: true });
  }
  writeFileSync(join(target, `cv-template.${name}.html`), withDisplayName(readFileSync(sourceTemplate, 'utf-8'), prettify(name)));
  if (!existsSync(join(target, 'sections'))) mkdirSync(join(target, 'sections'));

  if (renderer && !existsSync(join(target, 'render.mjs'))) {
    writeFileSync(join(target, 'render.mjs'), readFileSync(join(kitDirectory, 'renderer-stub.mjs'), 'utf-8'));
  }
  if (!existsSync(join(target, 'README.md'))) {
    writeFileSync(join(target, 'README.md'), readmeFor(name, sourceLabel));
  }

  return { target, files: listFiles(target), source: sourceLabel };
}

if (isMainModule(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`new-cv-template: ${error.message}\n${usage()}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  try {
    const { target, files, source } = scaffold(options);
    console.log(`created ${target} (from ${source})`);
    for (const file of files) console.log(`  ${file}`);
    console.log('');
    console.log('next:');
    console.log(`  node fork/preview-cv-template.mjs ${options.name}          sample CV to HTML, with an ATS audit`);
    console.log(`  node fork/preview-cv-template.mjs ${options.name} --pdf    and to PDF`);
    console.log(`  cv.template: ${options.name}    in ${join(getCareerOpsRoot(), 'config', 'profile.yml')} to make it the default`);
  } catch (error) {
    console.error(`new-cv-template: ${error.message}`);
    process.exit(1);
  }
}
