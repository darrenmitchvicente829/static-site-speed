// A faster drop-in for makefun-site 1.0.0: run(input) returns the output tree makefun-site's build returns.
//
// Two ways through it, one answer. A case handed over as its bytes (cases() reads cases.json once and hands each
// case's input as a span of that read) is answered bytes to bytes: front matter, Markdown and templates are read
// from the JSON text as it stands and the answer is written as JSON text, so nothing is parsed into strings and
// stringified again. A case handed over as a parsed object, or one whose bytes hold something the byte path does not
// read, is answered by build(), a plain reading of the same rules. Each case is answered alone.

import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// ---------------------------------------------------------------- text rules (strings)

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML = /[&<>"']/g;
const HTML_ANY = /[&<>"']/;
const escapeHtml = (t) => (HTML_ANY.test(t) ? t.replace(HTML, (c) => ESCAPES[c]) : t);
/** A string as it stands inside a JSON string. */
const jsonText = (t) => JSON.stringify(t).slice(1, -1);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const NOT_ASCII = /[^\x00-\x7f]/;

function slugify(text) {
  const plain = NOT_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A front matter string value: quoted with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

const BAD_DATE = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
const BAD_TAGS = 'key "tags": an empty tag, or one holding " [ or ]';
const TAG_OK = /^[^"[\]]+$/;

/** A tag list's names, or null when it does not read. */
function tagsOf(raw) {
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return [];
  const tags = inner.split(',').map((t) => t.trim());
  for (const t of tags) if (t === '' || !TAG_OK.test(t)) return null;
  return tags;
}

// ---------------------------------------------------------------- templates (parsed from strings; a site has a few)

class TemplateError extends Error {}
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const SPACES = /^[ \t]*$/;
const TEXT = 0;
const VAR = 1;
const RAW = 2;
const IF = 3;
const FOR = 4;
const INCLUDE = 5;

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** A template's tree of nodes, or a TemplateError. Tokens first, then the tree, so the first error is the reference's. */
function parseTemplate(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') toks.push({ t: TEXT, s: text, j: null });
      text = '';
      toks.push({ t: raw ? RAW : VAR, p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = SPACES.test(src.slice(lineStart, open)) && SPACES.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') toks.push({ t: TEXT, s: text, j: null });
    text = '';
    toks.push({ t: -1, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push({ t: TEXT, s: text, j: null });

  const root = [];
  const stack = [];
  let body = root;
  for (const tok of toks) {
    if (tok.t !== -1) {
      body.push(tok);
      continue;
    }
    const tag = tok.tag;
    const top = stack.length === 0 ? null : stack[stack.length - 1];
    let m;
    if ((m = T_FOR.exec(tag)) !== null) {
      const node = { t: FOR, name: m[1], p: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = T_IF.exec(tag)) !== null) {
      const node = { t: IF, not: m[1] !== undefined, p: pathOf(name, m[2]), a: [], b: null };
      body.push(node);
      stack.push(node);
      body = node.a;
    } else if (tag === 'else') {
      if (top === null || top.t !== IF || top.b !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.b = [];
      body = top.b;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top === null || top.t !== (tag === 'endfor' ? FOR : IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack.length === 0 ? null : stack[stack.length - 1];
      body = parent === null ? root : parent.t === FOR ? parent.body : parent.b ?? parent.a;
    } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ t: INCLUDE, name: m[1] });
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].t === FOR ? 'for' : 'if'} is not closed`);
  return root;
}

/** Every template that parses, by name, and a report line for each that does not. */
function parseTemplates(sources, report) {
  const templates = new Map();
  for (const name of Object.keys(sources).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, sources[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  return templates;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---------------------------------------------------------------- build(input): the rules read plainly, on strings

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, scope, templates, depth, out) {
  for (const n of nodes) {
    switch (n.t) {
      case TEXT:
        out.push(n.s);
        break;
      case VAR:
        out.push(escapeHtml(textOf(lookup(scope, n.p))));
        break;
      case RAW:
        out.push(textOf(lookup(scope, n.p)));
        break;
      case IF: {
        const branch = truthy(lookup(scope, n.p)) !== n.not ? n.a : n.b;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case FOR: {
        const xs = lookup(scope, n.p);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, templates, depth, out);
        }
        break;
      }
      default: {
        const t = templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, templates, depth + 1, out);
      }
    }
  }
}

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function frontMatterOf(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (SPACES.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    let value;
    if (key === 'title' || key === 'summary') {
      const s = stringOf(raw);
      if ('error' in s) return { error: `key "${key}": ${s.error}` };
      value = s.value;
    } else if (key === 'date') {
      const d = FM_DATE.exec(raw);
      const y = d ? Number(d[1]) : 0;
      const mo = d ? Number(d[2]) : 0;
      const day = d ? Number(d[3]) : 0;
      if (!d || y < 1970 || y > 2099 || mo < 1 || mo > 12 || day < 1 || day > daysIn(y, mo)) return { error: BAD_DATE };
      value = raw;
    } else if (key === 'tags') {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      value = tagsOf(raw);
      if (value === null) return { error: BAD_TAGS };
    } else if (key === 'draft') {
      if (raw !== 'true' && raw !== 'false') return { error: 'key "draft": true or false' };
      value = raw === 'true';
    } else if (key === 'layout') {
      if (!FM_NAME.test(raw)) return { error: 'key "layout": not a template name' };
      value = raw;
    } else {
      if (!FM_SLUG.test(raw) || raw.length > 64) return { error: 'key "slug": not a slug' };
      value = raw;
    }
    data[key] = value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WS = /\s/;
const trimLine = (line) => line.replace(/^[ \t]+|[ \t]+$/g, '');
const ESCAPABLE = '\\`*_[]()#+-.!>';

function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : m;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.includes(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.includes(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function inlineOf(s, link) {
  let out = '';
  let i = 0;
  let from = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
        out += escapeHtml(s.slice(from, i)) + escapeHtml(s[i + 1]);
        i += 2;
        from = i;
      } else i++;
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `${escapeHtml(s.slice(from, i))}<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        from = i;
      } else i++;
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `${escapeHtml(s.slice(from, i))}<strong>${inlineOf(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
          from = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `${escapeHtml(s.slice(from, i))}<em>${inlineOf(s.slice(i + 1, j), link)}</em>`;
          i = j + 1;
          from = i;
        } else i++;
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS.test(target)) {
        const before = escapeHtml(s.slice(from, i));
        const href = escapeHtml(link(target));
        out += `${before}<a href="${href}">${inlineOf(s.slice(i + 1, k), link)}</a>`;
        i = m + 1;
        from = i;
      } else i++;
    } else i++;
  }
  return out + escapeHtml(s.slice(from));
}

function markdownOf(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let html = '';
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (SPACES.test(line)) {
      i++;
      continue;
    }
    const fence = MD_FENCE_OPEN.exec(line);
    if (fence !== null) {
      let code = '';
      i++;
      while (i < lines.length && !MD_FENCE_CLOSE.test(lines[i])) code += `${escapeHtml(lines[i++])}\n`;
      i++;
      html += `<pre><code${fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`}>${code}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const depth = heading[1].length;
      const id = uniqueSlug(slugify(heading[2]), ids);
      const inner = inlineOf(heading[2], link);
      html += `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: inner });
      i++;
      continue;
    }
    if (MD_HR.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        const l = trimLine(lines[i++].replace(/^> ?/, ''));
        if (l !== '') body.push(l);
      }
      html += body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineOf(body.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = MD_BULLET.exec(line);
    const ordered = bullet === null ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push(trimLine(isOrdered ? m[2] : m[1]));
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1] += `\n${trimLine(lines[i])}`;
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      html += isOrdered && start !== 1 ? `<ol start="${start}">\n` : isOrdered ? '<ol>\n' : '<ul>\n';
      for (const item of items) html += `<li>${inlineOf(item, link)}</li>\n`;
      html += isOrdered ? '</ol>\n' : '</ul>\n';
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (SPACES.test(l) || MD_FENCE_OPEN.test(l) || headingOf(l) !== null || MD_HR.test(l)) break;
      text += `\n${trimLine(l)}`;
      i++;
    }
    const inner = inlineOf(text, link);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

let everyTier = false;

/** One site's output tree, path to text: makefun-site's rules in the order its README gives them. */
export function build(input) {
  if (!everyTier) {
    // The driver lets V8 optimize the byte path's kernels alone; this path is long work, so here it may optimize all.
    everyTier = true;
    try {
      setFlagsFromString('--turbo-filter=*');
    } catch {
      // as it was
    }
  }
  const report = [];
  const templates = parseTemplates(input.templates, report);
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const statics = [];
  const sources = [];
  for (const f of files) {
    if (!f.path.endsWith('.md')) {
      statics.push(f);
      continue;
    }
    const path = f.path;
    const fm = frontMatterOf(f.content.replace(/\r\n?/g, '\n'));
    if ('error' in fm) {
      report.push(`refused ${path}: ${fm.error}`);
      continue;
    }
    const post = path.startsWith('posts/');
    if (path.startsWith('tags/') || path.startsWith('page/')) {
      report.push(`refused ${path}: ${path.slice(0, 4)}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(fm.data, 'date')) {
      report.push(`refused ${path}: a post needs a date`);
      continue;
    }
    const layout = fm.data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (fm.data.draft === true) {
      report.push(`draft ${path}`);
      continue;
    }
    sources.push({ path, data: fm.data, body: fm.body, post, layout });
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) taken.set(dir, (set = new Set(dir === '' ? RESERVED : [])));
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const md = markdownOf(s.body, (target) => {
      if (MD_SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push([name, slug]);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) bySlug.set(slug, (tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }));
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };

  const output = {};
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  for (const s of sources) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${sources.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

// ---------------------------------------------------------------- the byte path: one store for every byte

/** Thrown where the bytes hold something this path does not read; the case is then answered by build(). */
const BAIL = new Error('not read by the byte path');
const DEBUG = process.env.MAKEFUN_SITE_DEBUG === '1';

// [ input | the answer being written (flushed to the file as it fills) | kept bytes | path workspace | the page being rendered ]
let BUF = Buffer.alloc(16);
let B = new Uint8Array(BUF.buffer, BUF.byteOffset, 16);
let IN = BUF; // the input alone: a search that finds nothing ends with it
let SIZE = 0;
let OUT0 = 0;
let OUT1 = 0;
let OUT_FLUSH = 0; // past this, the answer written so far goes to the file
let outFd = -1;
let outFile = '';
let failed = false; // a case the byte path did not answer: answers() then answers them all with build()
let SCR0 = 0;
let SCR1 = 0;
let TMP0 = 0;
let TMP1 = 0;
let HT0 = 0;
let HT1 = 0;
let op = 0; // where the answer is written
let sp = 0; // where kept bytes are written: escaped titles, urls, template text, excerpts
let hp = 0; // where Markdown's HTML is written
let words = 0; // the words of the body being rendered

const bytes = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
const K_PRE = bytes('<pre><code');
const K_LANG = bytes(' class=\\"language-');
const K_PRE_END = bytes('</code></pre>\\n');
const K_HR = bytes('<hr>\\n');
const K_BQ = bytes('<blockquote>\\n');
const K_BQ_END = bytes('</blockquote>\\n');
const K_P = bytes('<p>');
const K_P_END = bytes('</p>\\n');
const K_UL = bytes('<ul>\\n');
const K_OL = bytes('<ol>\\n');
const K_OL_START = bytes('<ol start=\\"');
const K_QUOTE_GT_NL = bytes('\\">\\n');
const K_LI = bytes('<li>');
const K_LI_END = bytes('</li>\\n');
const K_UL_END = bytes('</ul>\\n');
const K_OL_END = bytes('</ol>\\n');
const K_ID = bytes(' id=\\"');
const K_CODE = bytes('<code>');
const K_CODE_END = bytes('</code>');
const K_STRONG = bytes('<strong>');
const K_STRONG_END = bytes('</strong>');
const K_EM = bytes('<em>');
const K_EM_END = bytes('</em>');
const K_A = bytes('<a href=\\"');
const K_A_END = bytes('</a>');
const K_INDEX_KEY = bytes('/index.html":"');
const K_INDEX_ROOT = bytes('index.html":"');
const K_POSTS = bytes('posts/');
const K_TAGS_DIR = bytes('/tags/');
const K_PAGE_DIR = bytes('page/');
const K_UNTITLED = bytes('untitled');
const K_TRUE = bytes('true');
const K_FALSE = bytes('false');
const K_BROKEN = bytes('broken-link ');
const K_ARROW = bytes(' -> ');
const K_DRAFT = bytes('draft ');
const K_REFUSED = bytes('refused ');
const K_REPORT_KEY = bytes('"build-report.txt":"');
const K_KEYS = KEYS.map(bytes);
const K_MONTHS = MONTHS.map(bytes);

// The kernels: the few loops that touch every byte. They are small, so the optimizing compiler takes them quickly, and
// prime() runs each over every branch before it is asked to (tune.js), so none is compiled twice.

/** Bytes written out: a constant at h. */
function k_lit(u, h, k) {
  const n = k.length;
  for (let i = 0; i < n; i++) u[h + i] = k[i];
  return h + n;
}

/** n bytes from a copied to h. */
function k_cpy(u, h, a, n) {
  if (n < 96) for (let k = 0; k < n; k++) u[h + k] = u[a + k];
  else u.copyWithin(h, a, a + n);
  return h + n;
}

function same(u, a, b, n) {
  for (let k = 0; k < n; k++) if (u[a + k] !== u[b + k]) return false;
  return true;
}

function eq(u, p, k) {
  for (let i = 0; i < k.length; i++) if (u[p + i] !== k[i]) return false;
  return true;
}

function wnum(u, h, n) {
  if (n < 10) {
    u[h] = 48 + n;
    return h + 1;
  }
  let d = 1;
  for (let t = n; t >= 10; t = (t / 10) | 0) d++;
  for (let k = h + d - 1, t = n; k >= h; k--, t = (t / 10) | 0) u[k] = 48 + (t % 10);
  return h + d;
}

/** The text of JSON string bytes. */
function str(a, b) {
  const t = BUF.utf8Slice(a, b);
  return t.includes('\\') ? JSON.parse(`"${t}"`) : t;
}

// What a byte of a body asks of the inline pass.
const PLAIN = 0;
const AMP = 1;
const LT = 2;
const GT = 3;
const APOS = 4;
const BSL = 5;
const TICK = 6;
const STAR = 7;
const LBR = 8;
const SPC = 9;
const NL = 10; // a line break inside a block (written over the bytes that broke the line)
const FILL = 11; // a byte the block gave up: spaces at a line's ends, a quote's marker
const BAD = 12;
const UNI = 13; // may open a space outside ASCII
const CLS = new Uint8Array(256);
const ECLS = new Uint8Array(256); // the same for text that is escaped and nothing else
const MDESC = new Uint8Array(256); // what a backslash escapes
const SLG = new Uint8Array(256); // a slug's byte for a byte, 0 where it keeps none
const LANG = new Uint8Array(256);
const SCHEME = new Uint8Array(256);
for (let i = 0; i < 32; i++) CLS[i] = BAD;
CLS[1] = FILL;
CLS[10] = NL;
CLS[0x22] = BAD;
CLS[0x26] = AMP;
CLS[0x3c] = LT;
CLS[0x3e] = GT;
CLS[0x27] = APOS;
CLS[0x5c] = BSL;
CLS[0x60] = TICK;
CLS[0x2a] = STAR;
CLS[0x5b] = LBR;
CLS[0x20] = SPC;
CLS[0xc2] = CLS[0xe1] = CLS[0xe2] = CLS[0xe3] = CLS[0xef] = UNI;
for (let i = 0; i < 256; i++) ECLS[i] = CLS[i] === TICK || CLS[i] === STAR || CLS[i] === LBR ? PLAIN : CLS[i];
for (const ch of '`*_[]()#+-.!>') MDESC[ch.charCodeAt(0)] = 1;
for (let i = 48; i < 58; i++) SLG[i] = LANG[i] = SCHEME[i] = i;
for (let i = 97; i < 123; i++) SLG[i] = LANG[i] = SCHEME[i] = i;
for (let i = 65; i < 91; i++) {
  SLG[i] = i + 32;
  LANG[i] = SCHEME[i] = i;
}
LANG[95] = LANG[43] = LANG[45] = 1;
SCHEME[43] = SCHEME[46] = SCHEME[45] = 1;

/** Whether a space outside ASCII (or a line separator) opens at p. */
function uniWs(u, p) {
  const c = u[p];
  const d = u[p + 1];
  const e = u[p + 2];
  if (c === 0xc2) return d === 0xa0;
  if (c === 0xe1) return d === 0x9a && e === 0x80;
  if (c === 0xe2) return (d === 0x80 && (e <= 0x8a || e === 0xa8 || e === 0xa9 || e === 0xaf)) || (d === 0x81 && e === 0x9f);
  if (c === 0xe3) return d === 0x80 && e === 0x80;
  return c === 0xef && d === 0xbb && e === 0xbf;
}

/** Whether a word opens at p: no space, tab, line end or end of the text there. */
function wordAt(u, p) {
  const n = u[p];
  if (n === 92) {
    const e = u[p + 1];
    return e !== 116 && e !== 110 && e !== 114;
  }
  return n > 34 || n === 33;
}

// What k_scan does with a byte.
const T_SPC = 1;
const T_AMP = 2; // 2 to 6: written as an entity
const T_LT = 3;
const T_GT = 4;
const T_APOS = 5;
const T_QUOT = 6;
const T_BSL = 7; // a backslash: a quote after it is read
const T_BSLP = 8; // a backslash where a paragraph's plain line breaks are read too
const T_NL = 9;
const T_FILL = 10;
const T_STOP = 11;
const ENT = bytes('&amp;\0&lt;\0&gt;\0&#39;\0&quot;\0');
const ENT_AT = new Uint8Array(8);
ENT_AT[T_LT] = 6;
ENT_AT[T_GT] = 11;
ENT_AT[T_APOS] = 16;
ENT_AT[T_QUOT] = 22;
const TI = new Uint8Array(256); // a block's text: stops at what may open a mark
const TE = new Uint8Array(256); // code: escaped and nothing else
const TA = new Uint8Array(256); // any JSON string bytes, escaped: no words counted
// A line that starts on one of these may end a paragraph (a blank line, a fence, a heading, a break) or opens on
// spaces to drop: any other first byte plainly continues it.
const START = new Uint8Array(256);
const TAGX = new Uint8Array(256); // what makes a tag list more than names, commas and spaces
for (let i = 0; i < 256; i++) {
  const c = CLS[i];
  const t = c === PLAIN ? 0 : c === SPC ? T_SPC : c === AMP ? T_AMP : c === LT ? T_LT : c === GT ? T_GT : c === APOS ? T_APOS : c === BSL ? T_BSLP : c === NL ? T_NL : c === FILL ? T_FILL : T_STOP;
  TI[i] = t;
  TE[i] = c === TICK || c === STAR || c === LBR ? 0 : t;
  TA[i] = t === T_AMP || t === T_LT || t === T_GT || t === T_APOS ? t : c === BSL ? T_BSL : 0;
  START[i] = i < 33 || i === 34 || i === 92 || i === 35 || i === 96 || i === 45 || i === 42 ? 1 : 0;
  TAGX[i] = i === 92 || i === 91 || i === 93 || c === UNI ? 1 : 0;
}

/**
 * Bytes from p written at h under table t, escaped as HTML asks: as far as it can go. Returns where it stopped (b, or
 * a byte the table stops at, or a backslash it does not read: one that is no quote and no plain line break of a
 * paragraph) and leaves where it wrote to in hp; words it met are added to words.
 */
function k_scan(u, p, b, h, t) {
  let w = 0;
  while (p < b) {
    const c = u[p];
    let k = t[c];
    if (k === 0) {
      u[h++] = c;
      p++;
      continue;
    }
    if (k === T_SPC) {
      u[h++] = 32;
      p++;
      // A word opens after it unless a space, a tab, a line end or the end of the text follows.
      const n = u[p];
      if (n > 34) {
        if (n !== 92) w++;
        else {
          const e = u[p + 1];
          if (e !== 116 && e !== 110 && e !== 114) w++;
        }
      } else if (n === 33) w++;
      continue;
    }
    if (k >= T_BSL) {
      if (k === T_NL) {
        u[h] = 92; u[h + 1] = 110;
        h += 2;
        p++;
        w++;
        continue;
      }
      if (k === T_FILL) {
        p++;
        continue;
      }
      if (k === T_STOP) break;
      const e = u[p + 1];
      if (e === 34) {
        k = T_QUOT;
        p++;
      } else if (k === T_BSLP && e === 110 && p + 2 < b && START[u[p + 2]] === 0 && u[p - 1] !== 32 && (u[p - 1] !== 116 || u[p - 2] !== 92)) {
        // A paragraph's line break with nothing to drop around it and a next line that plainly continues it.
        u[h] = 92; u[h + 1] = 110;
        h += 2;
        p += 2;
        w++;
        continue;
      } else break;
    }
    // & < > ' or a quote: its entity
    let q = ENT_AT[k];
    let x = ENT[q];
    do {
      u[h++] = x;
      x = ENT[++q];
    } while (x !== 0);
    p++;
  }
  words += w;
  hp = h;
  return p;
}

/** JSON string bytes HTML-escaped at h; the end of what was written. */
function escTo(u, h, a, b) {
  const kept = words;
  let p = a;
  for (;;) {
    p = k_scan(u, p, b, h, TA);
    h = hp;
    if (p >= b) break;
    // a backslash that is no quote: the escape as it stands
    const e = u[p + 1];
    if (e === 117) throw BAIL;
    u[h] = 92; u[h + 1] = e;
    h += 2;
    p += 2;
  }
  words = kept;
  return h;
}

/** A run of a body escaped at hp and nothing else, its words counted. */
function escSpan(a, b) {
  const u = B;
  let p = a;
  for (;;) {
    p = k_scan(u, p, b, hp, TE);
    if (p >= b) return;
    const c = u[p];
    if (c === 92) {
      const e = u[p + 1];
      if (e === 110 || e === 114) {
        p = lineBreak(u, p, b);
        if (p < 0) throw BAIL;
        continue;
      }
      p += 2;
      if (e === 92) {
        u[hp] = 92; u[hp + 1] = 92;
        hp += 2;
      } else if (e === 116) {
        u[hp] = 92; u[hp + 1] = 116;
        hp += 2;
        if (wordAt(u, p)) words++;
      } else throw BAIL;
    } else if (CLS[c] === UNI && !uniWs(u, p)) {
      u[hp++] = c;
      p++;
    } else throw BAIL;
  }
}

/**
 * The first place from j, before b, where a mark closes, or -1. kind 0: the byte ch outside an escape; 1: ch standing
 * alone (not doubled), outside an escape; 2: ch doubled, outside an escape; 3: the byte ch wherever it is; 4: a byte
 * that may be a space (a space, a line break, a backslash or one outside ASCII); 5: a byte no plain path holds (not
 * printable ASCII, a quote or a backslash); 6: a byte a string is escaped for, or an escape; 7: a byte that makes a
 * tag list more than names, commas and spaces. A search reads on over a paragraph's line break where the next line
 * plainly continues the paragraph; at any other line break at j it answers -2 - j.
 */
function k_find(u, j, b, kind, ch) {
  if (kind >= 4) {
    if (kind === 4) {
      for (; j < b; j++) {
        const c = u[j];
        if (c <= 32 || c === 92 || c >= 0xc2) return j;
      }
    } else if (kind === 5) {
      for (; j < b; j++) {
        const c = u[j];
        if (c < 32 || c > 126 || c === 34 || c === 92) return j;
      }
    } else if (kind === 6) {
      for (; j < b; j++) {
        const c = u[j];
        if (c === 92 || c === 38 || c === 60 || c === 62 || c === 39) return j;
      }
    } else {
      for (; j < b; j++) if (TAGX[u[j]] !== 0) return j;
    }
    return -1;
  }
  while (j < b) {
    const c = u[j];
    if (c === 92) {
      const e = u[j + 1];
      if (e === 110 || e === 114) {
        if (e === 110 && j + 2 < b && START[u[j + 2]] === 0) j += 2;
        else return -2 - j;
      } else if (kind === 3) j += 2;
      else if (e === 92 && j + 2 < b) {
        // An escape takes its character with it: a backslash of the text before one of the characters it escapes.
        const f = u[j + 2];
        if (f === 92) j += u[j + 3] === 92 ? 4 : 2;
        else j += MDESC[f] === 1 ? 3 : 2;
      } else j += 2;
    } else if (c === ch) {
      if (kind === 0 || kind === 3) return j;
      const doubled = j + 1 < b && u[j + 1] === ch;
      if (kind === 1) {
        if (!doubled) return j;
        j += 2;
      } else if (doubled) return j;
      else j++;
    } else j++;
  }
  return -1;
}

/** k_find over the line breaks of a paragraph: a search ends where the paragraph does. */
function find(u, j, b, kind, ch) {
  for (;;) {
    const r = k_find(u, j, b, kind, ch);
    if (r >= -1) return r;
    const p = -2 - r;
    let n = p + 2;
    if (u[p + 1] === 114 && u[n] === 92 && u[n + 1] === 110) n += 2;
    if (n >= b || endsAt(u, n)) return -1;
    j = n;
  }
}

/** Whether a link's target holds no space. */
function noSpace(u, a, b) {
  for (let p = a; p < b; p++) {
    const c = u[p];
    if (c === 32 || c === 10) return false;
    if (c === 92) {
      const e = u[++p];
      if (e === 116 || e === 110 || e === 114) return false;
      if (e !== 34 && e !== 92) throw BAIL;
    } else if (CLS[c] === UNI && uniWs(u, p)) return false;
  }
  return true;
}

let curCE = 0; // where the body being rendered ends
let pEnd = -1; // where the block after a paragraph starts, once a line break has ended the paragraph

/** Whether the line at n ends a paragraph: a blank line, a fence, a heading or a break. */
function endsAt(u, n) {
  const c = u[n];
  if (c === 92) {
    const e = u[n + 1];
    if (e === 110 || e === 114) return true;
    if (e !== 116) return false;
  } else if (c === 34) {
    if (n >= curCE) return true;
    return false;
  } else if (c !== 32 && c !== 96 && c !== 35 && c !== 45 && c !== 42) return false;
  eol(u, n, curCE);
  return endsParagraph(u, n, le);
}

/** What was written, less the spaces and tabs it ends on: a line's are dropped. */
function untrail(u, h) {
  for (;;) {
    const c = u[h - 1];
    if (c === 32) h--;
    else if (c === 116 && u[h - 2] === 92) {
      // a tab only when its backslash is not itself an escaped one
      let k = h - 2;
      while (u[k] === 92) k--;
      if (((h - 2 - k) & 1) === 0) break;
      h -= 2;
    } else break;
  }
  return h;
}

/**
 * A line break of a paragraph at p, inside the run that ends at b: the spaces around it dropped. Where the paragraph
 * goes on, the break is written and the next line's text is where to read on; where the next line ends the
 * paragraph, pEnd is that line and the answer is -1.
 */
function lineBreak(u, p, b) {
  let n = p + 2;
  if (u[p + 1] === 114 && u[n] === 92 && u[n + 1] === 110) n += 2;
  let h = untrail(u, hp);
  if (n < b || b < curCE) {
    if (n < b) {
      if (endsAt(u, n)) {
        hp = h;
        pEnd = n;
        return -1;
      }
      n = skipWs(u, n, b);
    } else n = b;
    u[h] = 92; u[h + 1] = 110;
    hp = h + 2;
    words++;
    return n;
  }
  // the body ends on this line break
  hp = h;
  pEnd = n;
  return -1;
}

let curF = 0; // the source being rendered: its row
let curDir = 0; // where its directory ends in its path
let brAt = 0; // where its broken links start
let BR = new Int32Array(8192);
let brN = 0;

/** A link's href at hp: the page or static file its target names, or the target as written. */
function href(a, b) {
  const u = B;
  const c0 = u[a];
  if (c0 === 47 || c0 === 35) {
    hp = escTo(u, hp, a, b);
    return;
  }
  if ((c0 | 32) >= 97 && (c0 | 32) <= 122) {
    // A scheme: nothing but what a scheme holds before the first colon.
    const colon = k_find(u, a, b, 3, 58);
    if (colon > 0) {
      let q = a + 1;
      while (q < colon && SCHEME[u[q]] !== 0) q++;
      if (q === colon) {
        hp = escTo(u, hp, a, b);
        return;
      }
    }
  }
  let hash = k_find(u, a, b, 3, 35);
  if (hash < 0) hash = b;
  // The path it names, from the source's directory.
  let t = k_cpy(u, TMP0, F[curF + PS], curDir - F[curF + PS]);
  let ok = true;
  let s = a;
  while (s < hash) {
    let e = k_find(u, s, hash, 3, 47);
    if (e < 0) e = hash;
    const n = e - s;
    if (n === 2 && u[s] === 46 && u[s + 1] === 46) {
      if (t === TMP0) {
        ok = false;
        break;
      }
      t--;
      while (t > TMP0 && u[t] !== 47) t--;
    } else if (n !== 0 && !(n === 1 && u[s] === 46)) {
      if (t + n + 1 > TMP1) throw BAIL;
      if (t > TMP0) u[t++] = 47;
      t = k_cpy(u, t, s, n);
    }
    s = e + 1;
  }
  if (ok) {
    const v = k_lookup(u, TMP0, t - TMP0, HT, hMask, F);
    if (v >= 0) {
      if (F[v + ST] === 0) hp = k_cpy(u, hp, F[v + UEO], F[v + UEL]);
      else {
        hp = k_cpy(u, hp, BASE_EO, BASE_EL);
        u[hp++] = 47;
        hp = escTo(u, hp, TMP0, t);
      }
      hp = escTo(u, hp, hash, b);
      return;
    }
  }
  // It names neither: reported once, and kept as written.
  const n = b - a;
  let known = false;
  for (let k = brAt; k < brN; k += 2) {
    if (BR[k + 1] === n && same(u, BR[k], a, n)) {
      known = true;
      break;
    }
  }
  if (!known) {
    if (brN + 2 > BR.length) {
      const g = new Int32Array(BR.length * 2);
      g.set(BR);
      BR = g;
    }
    BR[brN++] = a;
    BR[brN++] = n;
  }
  hp = escTo(u, hp, a, b);
}

/**
 * A block's text rendered inline at hp. A paragraph's run is handed over to the end of the body: it ends at the line
 * break that ends the paragraph (pEnd is then the line after it).
 */
function inl(a, b) {
  const u = B;
  let p = a;
  for (;;) {
    p = k_scan(u, p, b, hp, TI);
    if (p >= b) return;
    const c = u[p];
    let h = hp;
    switch (CLS[c]) {
      case BSL: {
        const e = u[p + 1];
        if (e === 110 || e === 114) {
          p = lineBreak(u, p, b);
          if (p < 0) return;
          break;
        }
        if (e === 92) {
          // A backslash of the text: it escapes the character after it when that is one a backslash escapes.
          let done = false;
          if (p + 2 < b) {
            const f = u[p + 2];
            if (f === 92) {
              if (u[p + 3] === 92) {
                u[h] = 92; u[h + 1] = 92;
                h += 2;
                p += 4;
                done = true;
              }
            } else if (MDESC[f] === 1) {
              if (f === 62) {
                u[h] = 38; u[h + 1] = 103; u[h + 2] = 116; u[h + 3] = 59;
                h += 4;
              } else u[h++] = f;
              p += 3;
              done = true;
            }
          }
          if (!done) {
            u[h] = 92; u[h + 1] = 92;
            h += 2;
            p += 2;
          }
        } else if (e === 116) {
          u[h] = 92; u[h + 1] = 116;
          h += 2;
          p += 2;
          if (wordAt(u, p)) words++;
        } else throw BAIL;
        hp = h;
        break;
      }
      case TICK: {
        const j = find(u, p + 1, b, 3, 96);
        if (j > p + 1) {
          hp = k_lit(u, h, K_CODE);
          escSpan(p + 1, j);
          hp = k_lit(u, hp, K_CODE_END);
          p = j + 1;
        } else {
          u[h] = 96;
          hp = h + 1;
          p++;
        }
        break;
      }
      case STAR: {
        if (p + 1 < b && u[p + 1] === 42) {
          const j = find(u, p + 2, b, 2, 42);
          if (j > p + 2) {
            hp = k_lit(u, h, K_STRONG);
            inl(p + 2, j);
            hp = k_lit(u, hp, K_STRONG_END);
            p = j + 2;
          } else {
            u[h] = 42; u[h + 1] = 42;
            hp = h + 2;
            p += 2;
          }
        } else {
          const j = find(u, p + 1, b, 1, 42);
          if (j > p + 1) {
            hp = k_lit(u, h, K_EM);
            inl(p + 1, j);
            hp = k_lit(u, hp, K_EM_END);
            p = j + 1;
          } else {
            u[h] = 42;
            hp = h + 1;
            p++;
          }
        }
        break;
      }
      case LBR: {
        const close = find(u, p + 1, b, 0, 93);
        let m = -1;
        if (close !== -1 && close + 1 < b && u[close + 1] === 40) m = find(u, close + 2, b, 3, 41);
        if (m > close + 2 && (k_find(u, close + 2, m, 4, 0) < 0 || noSpace(u, close + 2, m))) {
          hp = k_lit(u, h, K_A);
          href(close + 2, m);
          h = hp;
          u[h] = 92; u[h + 1] = 34; u[h + 2] = 62;
          hp = h + 3;
          inl(p + 1, close);
          hp = k_lit(u, hp, K_A_END);
          p = m + 1;
        } else {
          u[h] = 91;
          hp = h + 1;
          p++;
        }
        break;
      }
      case UNI:
        if (uniWs(u, p)) throw BAIL;
        u[h] = c;
        hp = h + 1;
        p++;
        break;
      default:
        throw BAIL;
    }
  }
}

// ---- lines

let le = 0; // the end of the line eol() read
let ln = 0; // where the next line starts, past ce when there is none

function eol(u, p, ce) {
  for (let q = p; ; q += 2) {
    q = u.indexOf(92, q);
    if (q >= ce || q < 0) {
      le = ce;
      ln = ce + 1;
      return;
    }
    const c = u[q + 1];
    if (c === 110) {
      le = q;
      ln = q + 2;
      return;
    }
    if (c === 114) {
      le = q;
      ln = u[q + 2] === 92 && u[q + 3] === 110 ? q + 4 : q + 2;
      return;
    }
    if (c !== 34 && c !== 92 && c !== 116) throw BAIL;
  }
}

function isBlank(u, p, e) {
  while (p < e) {
    const c = u[p];
    if (c === 32) p++;
    else if (c === 92 && u[p + 1] === 116) p += 2;
    else return false;
  }
  return true;
}

function skipWs(u, p, e) {
  while (p < e) {
    const c = u[p];
    if (c === 32) p++;
    else if (c === 92 && u[p + 1] === 116) p += 2;
    else break;
  }
  return p;
}

function trimEnd(u, s, e) {
  while (e > s) {
    const c = u[e - 1];
    if (c === 32) {
      e--;
      continue;
    }
    if (c === 116 && e - 2 >= s && u[e - 2] === 92) {
      // A tab only when its backslash is not itself escaped: an odd run of backslashes before the t.
      let k = e - 2;
      while (k >= s && u[k] === 92) k--;
      if (((e - 2 - k) & 1) === 1) {
        e -= 2;
        continue;
      }
    }
    break;
  }
  return e;
}

/** The bytes between two lines of one block: a line break, then nothing. */
function fill(u, a, b) {
  u[a] = 10;
  for (let k = a + 1; k < b; k++) u[k] = 1;
}

/** The end of a fence line's language, or -1 when the line (opening on three backticks) is no fence. */
function fenceOpen(u, p, e) {
  let q = p + 3;
  while (q < e && LANG[u[q]] !== 0) q++;
  return isBlank(u, q, e) ? q : -1;
}

let hA = 0; // the text of the heading headingAt() read
let hB = 0;

function headingAt(u, p, e) {
  let q = p + 1;
  while (u[q] === 35) q++;
  const d = q - p;
  if (d > 6 || q >= e) return 0;
  const c = u[q];
  if (c !== 32 && !(c === 92 && u[q + 1] === 116)) return 0;
  const a = skipWs(u, q, e);
  const b = trimEnd(u, a, e);
  if (b <= a) return 0;
  hA = a;
  hB = b;
  return d;
}

const isHr = (u, p, e, c) => u[p + 1] === c && u[p + 2] === c && isBlank(u, p + 3, e);

function endsParagraph(u, p, e) {
  if (e === p) return true;
  const c = u[p];
  if (c === 32 || c === 92) return isBlank(u, p, e);
  if (c === 96) return u[p + 1] === 96 && u[p + 2] === 96 && fenceOpen(u, p, e) >= 0;
  if (c === 35) return headingAt(u, p, e) !== 0;
  if (c === 45 || c === 42) return isHr(u, p, e, c);
  return false;
}

/** The slug of JSON string bytes at d: its length, or -1 when the text is not plain ASCII (read it as a string). */
function k_slug(u, a, b, d) {
  let n = 0;
  let gap = false;
  for (let p = a; p < b; p++) {
    const c = u[p];
    if (c >= 128) return -1;
    let k = SLG[c];
    if (c === 92) {
      if (u[p + 1] === 117) return -1;
      p++;
      k = 0;
    }
    if (k === 0) {
      gap = n > 0;
      continue;
    }
    if (gap) {
      u[d + n++] = 45;
      gap = false;
      if (n === 64) break;
    }
    u[d + n++] = k;
    if (n === 64) break;
  }
  if (n > 0 && u[d + n - 1] === 45) n--;
  if (n === 0) {
    // "untitled"
    u[d] = 117; u[d + 1] = 110; u[d + 2] = 116; u[d + 3] = 105; u[d + 4] = 116; u[d + 5] = 108; u[d + 6] = 101; u[d + 7] = 100;
    return 8;
  }
  return n;
}

let IDS = new Int32Array(256); // the ids of the page's headings: where and how long
let idN = 0;
let TC = new Int32Array(4096); // table of contents rows: level, id, id length, html, html length
let tcN = 0;

function heading(d, a, b) {
  const u = B;
  words += 2;
  let h = hp;
  u[h] = 60; u[h + 1] = 104; u[h + 2] = 48 + d;
  h = k_lit(u, h + 3, K_ID);
  let n = k_slug(u, a, b, h);
  if (n < 0) n = BUF.latin1Write(slugify(str(a, b)), h);
  // The first of slug, slug-2, slug-3 … that is no id of this page yet.
  const base = n;
  for (let next = 2; ; next++) {
    let taken = false;
    for (let k = 0; k < idN; k += 2) {
      if (IDS[k + 1] === n && same(u, IDS[k], h, n)) {
        taken = true;
        break;
      }
    }
    if (!taken) break;
    u[h + base] = 45;
    n = wnum(u, h + base + 1, next) - h;
  }
  if (idN + 2 > IDS.length) {
    const g = new Int32Array(IDS.length * 2);
    g.set(IDS);
    IDS = g;
  }
  IDS[idN++] = h;
  IDS[idN++] = n;
  const id = h;
  h += n;
  u[h] = 92; u[h + 1] = 34; u[h + 2] = 62;
  hp = h + 3;
  const html = hp;
  inl(a, b);
  h = hp;
  if (d === 2 || d === 3) {
    if (tcN + 5 > TC.length) {
      const g = new Int32Array(TC.length * 2);
      g.set(TC);
      TC = g;
    }
    TC[tcN] = d;
    TC[tcN + 1] = id;
    TC[tcN + 2] = n;
    TC[tcN + 3] = html;
    TC[tcN + 4] = h - html;
    tcN += 5;
  }
  u[h] = 60; u[h + 1] = 47; u[h + 2] = 104; u[h + 3] = 48 + d; u[h + 4] = 62; u[h + 5] = 92; u[h + 6] = 110;
  hp = h + 7;
}

/** One source's body rendered at hp: its HTML, excerpt, table of contents and reading time into its row. */
function markdown(f) {
  const u = B;
  const ce = F[f + CE];
  const h0 = hp;
  const toc0 = tcN;
  let xo = 0;
  let xl = -1;
  idN = 0;
  words = 0;
  curF = f;
  curDir = F[f + DE];
  curCE = ce;
  brAt = brN;
  let p = F[f + BS];
  while (p <= ce) {
    const c = u[p];
    if (c === 92 && u[p + 1] === 110) {
      p += 2; // an empty line
      continue;
    }
    if (START[c] === 0 && c !== 62 && (c < 48 || c > 57)) {
      // Nothing a block opens on: a paragraph, read in one pass to the line break that ends it.
      words++;
      hp = k_lit(u, hp, K_P);
      const hs = hp;
      pEnd = -1;
      inl(p, ce);
      if (pEnd < 0) {
        hp = untrail(u, hp);
        p = ce + 1;
      } else p = pEnd;
      if (xl < 0) {
        xo = hs;
        xl = hp - hs;
      }
      hp = k_lit(u, hp, K_P_END);
      continue;
    }
    eol(u, p, ce);
    let e = le;
    let n = ln;
    if (e === p) {
      p = n;
      continue;
    }
    if ((c === 32 || c === 92) && isBlank(u, p, e)) {
      p = n;
      continue;
    }
    if (c === 96 && u[p + 1] === 96 && u[p + 2] === 96) {
      const lang = fenceOpen(u, p, e);
      if (lang >= 0) {
        words++;
        let h = k_lit(u, hp, K_PRE);
        if (lang > p + 3) {
          h = k_lit(u, h, K_LANG);
          for (let q = p + 3; q < lang; q++) u[h++] = u[q];
          u[h] = 92; u[h + 1] = 34;
          h += 2;
        }
        u[h++] = 62;
        hp = h;
        p = n;
        while (p <= ce) {
          eol(u, p, ce);
          e = le;
          n = ln;
          if (u[p] === 96 && u[p + 1] === 96 && u[p + 2] === 96 && e - p >= 3 && isBlank(u, p + 3, e)) {
            words++;
            p = n;
            break;
          }
          if (e > p && wordAt(u, p)) words++;
          escSpan(p, e);
          u[hp] = 92; u[hp + 1] = 110;
          hp += 2;
          p = n;
        }
        hp = k_lit(u, hp, K_PRE_END);
        continue;
      }
    }
    if (c === 35) {
      const d = headingAt(u, p, e);
      if (d !== 0) {
        heading(d, hA, hB);
        p = n;
        continue;
      }
    }
    if ((c === 45 || c === 42) && isHr(u, p, e, c)) {
      words++;
      hp = k_lit(u, hp, K_HR);
      p = n;
      continue;
    }
    if (c === 62) {
      hp = k_lit(u, hp, K_BQ);
      let us = 0;
      let ue = -1;
      for (;;) {
        // The mark is a word of its own unless text follows it at once.
        let a = p + 1;
        if (!wordAt(u, a)) words++;
        if (a < e && u[a] === 32) a++;
        a = skipWs(u, a, e);
        const b = trimEnd(u, a, e);
        if (b > a) {
          if (ue < 0) {
            us = a;
            words++;
          } else fill(u, ue, a);
          ue = b;
        }
        p = n;
        if (p > ce || u[p] !== 62) break;
        eol(u, p, ce);
        e = le;
        n = ln;
      }
      if (ue >= 0) {
        hp = k_lit(u, hp, K_P);
        inl(us, ue);
        hp = k_lit(u, hp, K_P_END);
      }
      hp = k_lit(u, hp, K_BQ_END);
      continue;
    }
    let a = -1; // where the first item's text starts, when the line opens a list
    let ordered = false;
    if ((c === 45 || c === 42) && u[p + 1] === 32) a = p + 2;
    else if (c >= 48 && c <= 57) {
      let q = p + 1;
      while (u[q] >= 48 && u[q] <= 57) q++;
      if (q - p <= 9 && u[q] === 46 && u[q + 1] === 32) {
        ordered = true;
        a = q + 2;
        let start = 0;
        for (let k = p; k < q; k++) start = start * 10 + (u[k] - 48);
        if (start === 1) hp = k_lit(u, hp, K_OL);
        else {
          hp = k_lit(u, hp, K_OL_START);
          hp = wnum(u, hp, start);
          hp = k_lit(u, hp, K_QUOTE_GT_NL);
        }
      }
    }
    if (a >= 0) {
      if (!ordered) hp = k_lit(u, hp, K_UL);
      for (;;) {
        // An item: its mark, its text on this line and the lines that continue it.
        words++;
        const us = skipWs(u, a, e);
        let ue = trimEnd(u, us, e);
        if (ue > us) words++;
        p = n;
        let more = false;
        while (p <= ce) {
          eol(u, p, ce);
          e = le;
          n = ln;
          if (e === p) break;
          const c2 = u[p];
          if (ordered) {
            if (c2 >= 48 && c2 <= 57) {
              let q = p + 1;
              while (u[q] >= 48 && u[q] <= 57) q++;
              if (q - p <= 9 && u[q] === 46 && u[q + 1] === 32) {
                a = q + 2;
                more = true;
                break;
              }
            }
          } else if ((c2 === 45 || c2 === 42) && u[p + 1] === 32) {
            a = p + 2;
            more = true;
            break;
          }
          if (c2 !== 32 || u[p + 1] !== 32) break;
          let q = p + 2;
          while (u[q] === 32) q++;
          if (q >= e || (u[q] === 92 && u[q + 1] === 116) || (CLS[u[q]] === UNI && uniWs(u, q))) break;
          fill(u, ue, q);
          ue = trimEnd(u, q, e);
          p = n;
        }
        hp = k_lit(u, hp, K_LI);
        inl(us, ue);
        hp = k_lit(u, hp, K_LI_END);
        if (!more) break;
      }
      hp = k_lit(u, hp, ordered ? K_OL_END : K_UL_END);
      continue;
    }
    // A paragraph after all (a line that looked like a block's and is none): the same one pass.
    words++;
    hp = k_lit(u, hp, K_P);
    const hs = hp;
    pEnd = -1;
    inl(skipWs(u, p, e), ce);
    if (pEnd < 0) {
      hp = untrail(u, hp);
      p = ce + 1;
    } else p = pEnd;
    if (xl < 0) {
      xo = hs;
      xl = hp - hs;
    }
    hp = k_lit(u, hp, K_P_END);
  }
  F[f + HO] = h0;
  F[f + HL] = hp - h0;
  F[f + XO] = xo;
  F[f + XL] = xl < 0 ? 0 : xl;
  F[f + TOC0] = toc0;
  F[f + TOCN] = (tcN - toc0) / 5;
  F[f + RM] = words <= 200 ? 1 : ((words + 199) / 200) | 0;
  F[f + BR0] = brAt;
  F[f + BRN] = (brN - brAt) >> 1;
}

// ---- the kernels made ready

// V8's own switches for when a function is optimized, where the driver allowed their syntax (--allow-natives-syntax);
// null where it did not, and the kernels are then optimized when V8 finds them hot.
let prepare = null;
let optimizeNext = null;
try {
  prepare = new Function('f', '%PrepareFunctionForOptimization(f)');
  optimizeNext = new Function('f', '%OptimizeFunctionOnNextCall(f)');
} catch {
  prepare = optimizeNext = null;
}

const PRIME_TEXT = 'ab c \\"d \\"e  f \\tg !h &<>\'i\\\\j\nk\x01l`m*n[o \\\\*p**q*r]s(t)u\\\\\\\\v w\\\\\\"x y\\nz \\nq\\n r\\n\\ns\\r\\nt\\t\\nu ';
const PRIME = bytes(PRIME_TEXT);
const PRIME_STAR = PRIME_TEXT.indexOf('n[o'); // past the first star
let primed = false;

/**
 * Runs every kernel over every branch it has, on a made-up sample, then asks for each to be optimized: the compiler
 * then sees all of a kernel at once and compiles it once, before the first case is read.
 */
function prime() {
  if (primed) return;
  primed = true;
  const u = B;
  const a = HT0;
  const b = a + PRIME.length;
  const o = a + 4096;
  u.set(PRIME, a);
  const ht = new Int32Array(8);
  const rows = new Int32Array(8);
  rows[0] = a; // one path: the sample's first three bytes
  rows[1] = a + 3;
  rows[2] = a + 5; // another, of the same length
  rows[3] = a + 8;
  const kernels = [k_scan, k_cpy, k_lit, k_find, k_lookup, k_slug];
  if (prepare !== null) for (const k of kernels) prepare(k);
  const all = () => {
    for (const t of [TI, TE, TA]) {
      for (let p = a; p < b; ) {
        p = k_scan(u, p, b, o, t);
        if (p < b) p += u[p] === 92 ? 2 : 1;
      }
    }
    for (let kind = 0; kind <= 3; kind++) {
      k_find(u, a, b, kind, 42);
      k_find(u, a, b, kind, 93);
      k_find(u, a + PRIME_STAR, b, kind, 42);
      k_find(u, a + PRIME_STAR, b, kind, 93);
      k_find(u, a, a + 9, kind, 42);
    }
    for (let kind = 4; kind <= 7; kind++) {
      k_find(u, a, b, kind, 0);
      k_find(u, a, a + 2, kind, 0);
    }
    k_slug(u, a, b, o);
    k_slug(u, a + 1, a + 2, o);
    k_slug(u, a + 2, a + 3, o);
    k_slug(u, b - 3, b, o);
    k_cpy(u, o, a, 0);
    k_cpy(u, o, a, 7);
    k_cpy(u, o, a, 200);
    k_lit(u, o, K_P);
    k_lit(u, o, K_PRE_END);
    ht.fill(0);
    for (let g = 0; g < 4; g += 2) if (k_lookup(u, rows[g], 3, ht, 7, rows) < 0) ht[slot] = g + 1;
    for (let n = 1; n <= 4; n++) for (let from = a; from < a + 8; from++) k_lookup(u, from, n, ht, 7, rows);
  };
  all();
  all();
  if (optimizeNext !== null) {
    for (const k of kernels) optimizeNext(k);
    all();
  }
  hp = 0;
  words = 0;
}

// ---- the files of a case: one row each

const FS = 64;
const PS = 0; // path
const PE = 1;
const CE = 3; // content end
const ST = 4; // 0 a page that is built, 1 refused, 2 a draft, 3 a static file
const POST = 5;
const TEO = 6; // title, escaped: where and how long, as every string here
const TEL = 7;
const TRO = 8; // title, as it is
const TRL = 9;
const DATE = 10; // yyyymmdd, 0 with none
const DO = 11; // the date as written
const DN = 12;
const DLO = 13; // the date in words
const DLL = 14;
const SEO = 15; // summary, escaped
const SEL = 16;
const SRO = 17;
const SRL = 18;
const SLO = 19; // slug
const SLL = 20;
const UEO = 21; // url, escaped
const UEL = 22;
const URO = 23;
const URL_ = 24;
const KO = 25; // the output directory
const KL = 26;
const LAY = 27;
const BS = 28; // body start
const HO = 29; // html
const HL = 30;
const XO = 31; // excerpt
const XL = 32;
const TOC0 = 33;
const TOCN = 34;
const RM = 35; // reading minutes, 0 until the body is rendered
const TG0 = 36; // its tags
const TGN = 37;
const NEWER = 38;
const OLDER = 39;
const BR0 = 40; // its broken links
const BRN = 41;
const TN0 = 42; // its tag names as written
const TNN = 43;
const SKO = 44; // the slug its front matter gives
const SKL = 45;
const LYO = 46; // the layout its front matter gives
const LYL = 47;
const DE = 48; // where its directory ends in its path
let F = new Int32Array(FS * 1024);

let TN = new Int32Array(8192); // every source's tags as written: spellings (see nameOf)
let tnN = 0;

function tnPush(g) {
  if (tnN === TN.length) {
    const grown = new Int32Array(TN.length * 2);
    grown.set(TN);
    TN = grown;
  }
  TN[tnN++] = g;
}

/** Stops the byte path before kept bytes run out of room. */
function room(n) {
  if (sp + n > SCR1) throw BAIL;
}

/** The answer written so far goes to the file; a file that outgrew the store ends the byte path. */
function flush() {
  if (op > OUT1) throw BAIL;
  if (outFd < 0) outFd = openSync(outFile, 'w');
  for (let a = OUT0; a < op; ) a += writeSync(outFd, BUF, a, op - a);
  op = OUT0;
}

// ---- front matter

let fmSeen = 0;
let fmBody = 0;
let fmDraft = 0;
let hasE2 = false; // whether the case holds a byte that can open a line separator

function keyOf(u, p, n) {
  if (n === 5) return eq(u, p, K_KEYS[0]) ? 0 : eq(u, p, K_KEYS[3]) ? 3 : -1;
  if (n === 4) return eq(u, p, K_KEYS[1]) ? 1 : eq(u, p, K_KEYS[2]) ? 2 : eq(u, p, K_KEYS[5]) ? 5 : -1;
  if (n === 6) return eq(u, p, K_KEYS[4]) ? 4 : -1;
  if (n === 7) return eq(u, p, K_KEYS[6]) ? 6 : -1;
  return -1;
}

function fmStringSlow(f, id, vs, ve) {
  const s = stringOf(str(vs, ve));
  if ('error' in s) return s.error;
  room(12 * (ve - vs) + 64);
  const ro = sp;
  sp += BUF.write(jsonText(s.value), sp);
  const rl = sp - ro;
  let eo = ro;
  let el = rl;
  const e = escapeHtml(s.value);
  if (e !== s.value) {
    eo = sp;
    sp += BUF.write(jsonText(e), sp);
    el = sp - eo;
  }
  const g = f + (id === 0 ? TEO : SEO);
  F[g] = eo;
  F[g + 1] = el;
  F[g + 2] = ro;
  F[g + 3] = rl;
  return null;
}

function fmString(f, id, vs, ve) {
  const u = B;
  let a = vs;
  let b = ve;
  let eo = vs;
  let el = ve - vs;
  if (k_find(u, vs, ve, 6, 0) < 0) {
    // nothing to escape and no escape: the bytes as they stand
    if (u[vs] === 91) return 'a bare string opens on [';
  } else {
    if (u[vs] === 92 && u[vs + 1] === 34) {
      // Quoted: its inside when no escape is in it; any other is read as the string it is.
      let simple = ve - vs >= 4 && u[ve - 2] === 92 && u[ve - 1] === 34;
      for (let q = vs + 2; simple && q < ve - 2; q++) if (u[q] === 92) simple = false;
      if (!simple) return fmStringSlow(f, id, vs, ve);
      a = vs + 2;
      b = ve - 2;
    } else if (u[vs] === 91) return 'a bare string opens on [';
    // (A bare string is its bytes as they stand, escapes and all.)
    room(6 * (b - a) + 64);
    eo = sp;
    sp = escTo(u, sp, a, b);
    el = sp - eo;
    if (el === b - a) {
      // nothing was escaped
      sp = eo;
      eo = a;
    }
  }
  const g = f + (id === 0 ? TEO : SEO);
  F[g] = eo;
  F[g + 1] = el;
  F[g + 2] = a;
  F[g + 3] = b - a;
  return null;
}

let NM = new Int32Array(512); // every spelling of a tag in the case: where it starts and ends
let nmN = 0;
let NH = new Int32Array(1024); // the spellings by their bytes
let nhMask = 1023;

/** The spelling at [x, y): the same number for the same bytes. */
function nameOf(u, x, y) {
  let g = k_lookup(u, x, y - x, NH, nhMask, NM);
  if (g >= 0) return g;
  if (nmN + 2 > NM.length) {
    const grown = new Int32Array(NM.length * 2);
    grown.set(NM);
    NM = grown;
  }
  if (nmN >= NH.length >> 1) {
    // too full to probe well: twice the room, every spelling put again
    NH = new Int32Array(NH.length * 2);
    nhMask = NH.length - 1;
    for (let k = 0; k < nmN; k += 2) {
      k_lookup(u, NM[k], NM[k + 1] - NM[k], NH, nhMask, NM);
      NH[slot] = k + 1;
    }
    k_lookup(u, x, y - x, NH, nhMask, NM);
  }
  g = nmN;
  NM[g] = x;
  NM[g + 1] = y;
  NH[slot] = g + 1;
  nmN += 2;
  return g;
}

function fmTags(f, a, b) {
  const u = B;
  const t0 = tnN;
  for (let x = k_find(u, a, b, 7, 0); x >= 0; x = k_find(u, x + 1, b, 7, 0)) {
    const c = u[x];
    if (c === 91 || c === 93) return false;
    if (c === 92 || uniWs(u, x)) {
      // Tabs, backslashes or spaces outside ASCII: read as the strings they are.
      const tags = tagsOf(str(a - 1, b + 1));
      if (tags === null) return false;
      for (const t of tags) {
        const j = jsonText(t);
        room(3 * j.length);
        const n = BUF.write(j, sp);
        tnPush(nameOf(u, sp, sp + n));
        sp += n;
      }
      F[f + TN0] = t0;
      F[f + TNN] = tnN - t0;
      return true;
    }
  }
  let q = a;
  while (q < b && u[q] === 32) q++;
  if (q < b) {
    let s = a;
    for (;;) {
      let e = k_find(u, s, b, 3, 44);
      if (e < 0) e = b;
      let x = s;
      let y = e;
      while (x < y && u[x] === 32) x++;
      while (y > x && u[y - 1] === 32) y--;
      if (x === y) {
        tnN = t0;
        return false;
      }
      tnPush(nameOf(u, x, y));
      if (e >= b) break;
      s = e + 1;
    }
  }
  F[f + TN0] = t0;
  F[f + TNN] = tnN - t0;
  return true;
}

const digit = (c) => c >= 48 && c <= 57;

function fmDate(f, vs, ve) {
  const u = B;
  if (ve - vs !== 10 || u[vs + 4] !== 45 || u[vs + 7] !== 45) return false;
  for (let k = 0; k < 10; k++) if (k !== 4 && k !== 7 && !digit(u[vs + k])) return false;
  const y = (u[vs] - 48) * 1000 + (u[vs + 1] - 48) * 100 + (u[vs + 2] - 48) * 10 + (u[vs + 3] - 48);
  const m = (u[vs + 5] - 48) * 10 + (u[vs + 6] - 48);
  const d = (u[vs + 8] - 48) * 10 + (u[vs + 9] - 48);
  if (y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return false;
  F[f + DATE] = y * 10000 + m * 100 + d;
  F[f + DO] = vs;
  F[f + DN] = 10;
  return true;
}

function fmLine(f, p, e, no) {
  const u = B;
  if (p === e) return null;
  const c = u[p];
  if (c === 35) return null;
  if ((c === 32 || c === 92) && isBlank(u, p, e)) return null;
  let k = p;
  while (k < e) {
    const d = u[k];
    if ((d >= 97 && d <= 122) || d === 95) k++;
    else break;
  }
  if (k === p || k >= e || u[k] !== 58) return `line ${no} is not "key: value"`;
  let vs = e;
  let ve = e;
  if (k + 1 < e) {
    if (u[k + 1] !== 32) return `line ${no} is not "key: value"`;
    vs = k + 2;
    // A line separator in the value is no part of a "key: value" line: left to build().
    if (hasE2) for (let q = vs; q < e; q++) if (u[q] === 0xe2 && u[q + 1] === 0x80 && (u[q + 2] === 0xa8 || u[q + 2] === 0xa9)) throw BAIL;
    ve = trimEnd(u, vs, e);
  }
  const id = keyOf(u, p, k - p);
  if (id < 0) return `unknown key "${BUF.latin1Slice(p, k)}"`;
  if ((fmSeen & (1 << id)) !== 0) return `key "${KEYS[id]}" is given twice`;
  if (ve === vs) return `key "${KEYS[id]}" has no value`;
  switch (id) {
    case 0:
    case 6: {
      const err = fmString(f, id, vs, ve);
      if (err !== null) return `key "${KEYS[id]}": ${err}`;
      break;
    }
    case 1:
      if (!fmDate(f, vs, ve)) return BAD_DATE;
      break;
    case 2:
      if (u[vs] !== 91 || u[ve - 1] !== 93) return 'key "tags": not a list [a, b]';
      if (!fmTags(f, vs + 1, ve - 1)) return BAD_TAGS;
      break;
    case 3:
      if (ve - vs === 4 && eq(u, vs, K_TRUE)) fmDraft = 1;
      else if (ve - vs === 5 && eq(u, vs, K_FALSE)) fmDraft = 0;
      else return 'key "draft": true or false';
      break;
    case 4:
      for (let q = vs; q < ve; q++) {
        const d = u[q];
        if (!((d >= 97 && d <= 122) || digit(d) || d === 45)) return 'key "layout": not a template name';
      }
      F[f + LYO] = vs;
      F[f + LYL] = ve - vs;
      break;
    default: {
      // a-z and 0-9, single dashes between, at most 64
      let dash = true;
      for (let q = vs; q < ve; q++) {
        const d = u[q];
        if ((d >= 97 && d <= 122) || digit(d)) dash = false;
        else if (d === 45 && !dash) dash = true;
        else return 'key "slug": not a slug';
      }
      if (dash || ve - vs > 64) return 'key "slug": not a slug';
      F[f + SKO] = vs;
      F[f + SKL] = ve - vs;
    }
  }
  fmSeen |= 1 << id;
  return null;
}

/** A source's front matter into its row: the reason it is refused, or null (fmBody is then where its body starts). */
function frontMatter(f, cs, ce) {
  const u = B;
  fmSeen = 0;
  fmDraft = 0;
  if (!(u[cs] === 45 && u[cs + 1] === 45 && u[cs + 2] === 45)) return 'no front matter';
  let p = cs + 3;
  if (p >= ce) return p === ce ? 'the front matter is not closed' : 'no front matter';
  if (!(u[p] === 92 && (u[p + 1] === 110 || u[p + 1] === 114))) return 'no front matter';
  eol(u, p, ce);
  p = ln;
  let err = null;
  for (let no = 2; ; no++) {
    if (p > ce) return 'the front matter is not closed';
    eol(u, p, ce);
    const e = le;
    const n = ln;
    if (e - p === 3 && u[p] === 45 && u[p + 1] === 45 && u[p + 2] === 45) {
      fmBody = n > ce ? ce : n;
      break;
    }
    if (err === null) err = fmLine(f, p, e, no);
    p = n;
  }
  if (err !== null) return err;
  return (fmSeen & 1) === 0 ? 'no title' : null;
}

// ---- the paths links name

let HT = new Int32Array(4096);
let hMask = 4095;
let BASE_EO = 0; // the site's base, escaped
let BASE_EL = 0;
let BASE_RO = 0;
let BASE_RL = 0;

let slot = 0; // where k_lookup stopped when it found nothing: the place to put what it looked for

/** The row of the built page or static file whose path is the n bytes at a, or -1 (slot is then where it would go). */
function k_lookup(u, a, n, ht, mask, f) {
  let h = 0;
  for (let k = 0; k < n; k++) h = (Math.imul(h, 31) + u[a + k]) | 0;
  let k = h & mask;
  for (;;) {
    const v = ht[k];
    if (v === 0) {
      slot = k;
      return -1;
    }
    const g = v - 1;
    const ps = f[g];
    if (f[g + 1] - ps === n) {
      let i = 0;
      while (i < n && u[ps + i] === u[a + i]) i++;
      if (i === n) return g;
    }
    k = (k + 1) & mask;
  }
}

function hashPut(u, g) {
  if (k_lookup(u, F[g + PS], F[g + PE] - F[g + PS], HT, hMask, F) >= 0) throw BAIL;
  HT[slot] = g + 1;
}

// ---- templates, compiled for one site: what every page shares is rendered once, into kept bytes

const OP_END = 0;
const OP_STATIC = 1; // kept bytes: where, how long
const OP_STR = 2; // a string of an index page's pager: which, whose, how (0 as it is, 1 escaped)
const OP_F = 10; // a string of a page or a card: its place in the row, the register of the row
const OP_FH = 11; // the same of a page's newer or older post: place, register, which
const OP_T = 12; // a string of a tag
const OP_C = 13; // a string of a table of contents row
const OP_ESC = 14; // HTML of a page, escaped as it is written: 0 a row's, 1 a table of contents row's; place, register
const OP_IFF = 15; // a string of a page tested: place, register, whether "not", where to go when it fails
const OP_IFT = 16; // a string of a tag tested
const OP_NUM = 3;
const OP_BOOL = 4;
const OP_SEP = 5; // an array written: its items are objects, so only what joins them
const OP_IF = 6; // what is tested (kind, a, b), whether "not", where to go when it fails
const OP_JMP = 7;
const OP_FOR = 8; // which array, whose, the loop's register, where to go when it is empty
const OP_NEXT = 9;

// The strings a page gives.
const S_TITLE = 0;
const S_URL = 1;
const S_DATE = 2;
const S_DATELONG = 3;
const S_SUMMARY = 4;
const S_EXCERPT = 5;
const S_SLUG = 6;
const S_CONTENT = 7;
const S_TAGNAME = 8;
const S_TAGSLUG = 9;
const S_TAGURL = 10;
const S_TOCID = 11;
const S_TOCHTML = 12;
const S_PURL = 13;
const S_PNEWER = 14;
const S_POLDER = 15;
// The numbers.
const N_RM = 0;
const N_TAGCOUNT = 1;
const N_TOCLEVEL = 2;
const N_PNUM = 3;
const N_PTOTAL = 4;
const N_LIDX = 5;
const N_LLEN = 6;
const N_LEN = 7; // + the array's kind
// The booleans.
const B_ISPOST = 0;
const B_LFIRST = 1;
const B_LLAST = 2;
// The arrays.
const A_TAGREFS = 0;
const A_TOC = 1;
const A_POSTS = 2;
const A_TAGPOSTS = 3;

// The tags of a case: one row each.
const TS = 12;
const NEO = 0; // name, escaped
const NEL = 1;
const NRO = 2;
const NRL = 3;
const TSO = 4; // slug
const TSL = 5;
const TUO = 6; // url, escaped (no url: a page's tag no post has)
const TUL = 7;
const TVO = 8;
const TVL = 9;
const TP0 = 10; // its posts
const TPN = 11;
let TG = new Int32Array(TS * 256);
let TR = new Int32Array(8192); // every source's tags: tag rows
let TP = new Int32Array(8192); // every tag's posts: file rows
let PO = new Int32Array(1024); // the posts, newest first: file rows

const R = new Int32Array(256); // registers: what each loop is at
const LI = new Int32Array(256); // each loop's index, from 1
const LN = new Int32Array(256); // each loop's length
const LP = new Int32Array(256); // where each loop's array starts
let CODE = [];
let lastStatic = -1;
let nextReg = 1;
let idxLo = 0; // the posts of the index page being rendered
let idxHi = 0;
let pgN = 0; // its number and the number of index pages
let pgT = 0;
let TEMPLATES = new Map();
let ROOT = null;

// What a path is, read where the template is compiled.
const V_CONST = 0;
const V_SRC = 1; // a page or a card: the register, whether a page
const V_LINK = 2; // a page's newer or older: the register, which
const V_TAGREF = 3;
const V_TAG = 4;
const V_TOC = 5;
const V_PAGER = 6;
const V_LOOP = 7;
const V_ARR = 8; // which array, whose
const V_STR = 9; // which string, whose
const V_NUM = 10;
const V_BOOL = 11;
const cv = (k, a, b, v) => ({ k, a, b, v });
const UNDEF = cv(V_CONST, 0, 0, undefined);

function step(c, name) {
  switch (c.k) {
    case V_CONST: {
      const v = c.v;
      return v === null || typeof v !== 'object' || !Object.hasOwn(v, name) ? UNDEF : cv(V_CONST, 0, 0, v[name]);
    }
    case V_SRC: {
      const r = c.a;
      switch (name) {
        case 'title': return cv(V_STR, S_TITLE, r);
        case 'url': return cv(V_STR, S_URL, r);
        case 'date': return cv(V_STR, S_DATE, r);
        case 'date_long': return cv(V_STR, S_DATELONG, r);
        case 'summary': return cv(V_STR, S_SUMMARY, r);
        case 'excerpt': return cv(V_STR, S_EXCERPT, r);
        case 'reading_minutes': return cv(V_NUM, N_RM, r);
        case 'tags': return cv(V_ARR, A_TAGREFS, r);
      }
      if (c.b === 1) {
        switch (name) {
          case 'slug': return cv(V_STR, S_SLUG, r);
          case 'content': return cv(V_STR, S_CONTENT, r);
          case 'toc': return cv(V_ARR, A_TOC, r);
          case 'newer': return cv(V_LINK, r, 1);
          case 'older': return cv(V_LINK, r, 2);
          case 'is_post': return cv(V_BOOL, B_ISPOST, r);
        }
      }
      return UNDEF;
    }
    case V_LINK: {
      const sel = c.a | (c.b << 8);
      switch (name) {
        case 'title': return cv(V_STR, S_TITLE, sel);
        case 'url': return cv(V_STR, S_URL, sel);
        case 'date': return cv(V_STR, S_DATE, sel);
        case 'date_long': return cv(V_STR, S_DATELONG, sel);
      }
      return UNDEF;
    }
    case V_TAGREF:
      switch (name) {
        case 'name': return cv(V_STR, S_TAGNAME, c.a);
        case 'slug': return cv(V_STR, S_TAGSLUG, c.a);
        case 'url': return cv(V_STR, S_TAGURL, c.a);
      }
      return UNDEF;
    case V_TAG:
      switch (name) {
        case 'name': return cv(V_STR, S_TAGNAME, c.a);
        case 'slug': return cv(V_STR, S_TAGSLUG, c.a);
        case 'url': return cv(V_STR, S_TAGURL, c.a);
        case 'count': return cv(V_NUM, N_TAGCOUNT, c.a);
        case 'posts': return cv(V_ARR, A_TAGPOSTS, c.a);
      }
      return UNDEF;
    case V_TOC:
      switch (name) {
        case 'level': return cv(V_NUM, N_TOCLEVEL, c.a);
        case 'id': return cv(V_STR, S_TOCID, c.a);
        case 'html': return cv(V_STR, S_TOCHTML, c.a);
      }
      return UNDEF;
    case V_PAGER:
      switch (name) {
        case 'number': return cv(V_NUM, N_PNUM, 0);
        case 'total': return cv(V_NUM, N_PTOTAL, 0);
        case 'url': return cv(V_STR, S_PURL, 0);
        case 'newer_url': return cv(V_STR, S_PNEWER, 0);
        case 'older_url': return cv(V_STR, S_POLDER, 0);
      }
      return UNDEF;
    case V_LOOP:
      switch (name) {
        case 'index': return cv(V_NUM, N_LIDX, c.a);
        case 'first': return cv(V_BOOL, B_LFIRST, c.a);
        case 'last': return cv(V_BOOL, B_LLAST, c.a);
        case 'length': return cv(V_NUM, N_LLEN, c.a);
      }
      return UNDEF;
    case V_ARR:
      return name === 'length' ? cv(V_NUM, N_LEN + c.a, c.b) : UNDEF;
    default:
      return UNDEF;
  }
}

/** A path's value in a scope: its first name from the nearest loop that binds it, else the page's values. */
function look(scope, path) {
  const name = path[0];
  let c;
  let s = scope;
  while (s !== null && s.n1 !== name && s.n2 !== name) s = s.parent;
  if (s !== null) c = s.n1 === name ? s.v1 : s.v2;
  else if (Object.hasOwn(ROOT, name)) c = ROOT[name];
  else return UNDEF;
  for (let k = 1; k < path.length; k++) c = step(c, path[k]);
  return c;
}

/** Where a string sits in its row: a page's or a card's in F, a tag's in TG. */
function placeOf(field, esc) {
  switch (field) {
    case S_TITLE: return esc ? TEO : TRO;
    case S_URL: return esc ? UEO : URO;
    case S_DATE: return DO;
    case S_DATELONG: return DLO;
    case S_SUMMARY: return esc ? SEO : SRO;
    case S_EXCERPT: return XO;
    case S_SLUG: return SLO;
    case S_CONTENT: return HO;
    case S_TAGNAME: return esc ? NEO : NRO;
    case S_TAGSLUG: return TSO;
    default: return esc ? TUO : TVO;
  }
}

/** Text every page of the site shares, kept once. */
function keep(j) {
  if (j.length === 0) return;
  room(3 * j.length + 16);
  const n = BUF.write(j, sp);
  if (lastStatic >= 0 && CODE[lastStatic + 1] + CODE[lastStatic + 2] === sp) CODE[lastStatic + 2] += n;
  else {
    lastStatic = CODE.length;
    CODE.push(OP_STATIC, sp, n);
  }
  sp += n;
}

function compileNodes(nodes, scope, depth) {
  for (const n of nodes) {
    switch (n.t) {
      case TEXT:
        keep((n.j ??= jsonText(n.s)));
        break;
      case VAR:
      case RAW: {
        const c = look(scope, n.p);
        const esc = n.t === VAR;
        switch (c.k) {
          case V_CONST: {
            const t = textOf(c.v);
            keep(jsonText(esc ? escapeHtml(t) : t));
            break;
          }
          case V_STR: {
            const field = c.a;
            const reg = c.b & 255;
            const hop = c.b >> 8;
            if (field >= S_PURL) CODE.push(OP_STR, field, 0, esc ? 1 : 0);
            else if (esc && (field === S_EXCERPT || field === S_CONTENT)) CODE.push(OP_ESC, 0, placeOf(field, false), reg);
            else if (esc && field === S_TOCHTML) CODE.push(OP_ESC, 1, 3, reg);
            else if (field <= S_CONTENT) {
              if (hop === 0) CODE.push(OP_F, placeOf(field, esc), reg);
              else CODE.push(OP_FH, placeOf(field, esc), reg, hop);
            } else if (field <= S_TAGURL) CODE.push(OP_T, placeOf(field, esc), reg);
            else CODE.push(OP_C, field === S_TOCID ? 1 : 3, reg);
            lastStatic = -1;
            break;
          }
          case V_NUM:
            CODE.push(OP_NUM, c.a, c.b);
            lastStatic = -1;
            break;
          case V_BOOL:
            CODE.push(OP_BOOL, c.a, c.b);
            lastStatic = -1;
            break;
          case V_ARR:
            CODE.push(OP_SEP, c.a, c.b);
            lastStatic = -1;
            break;
          default: // an object, or a neighbour that is one or null: written as nothing
        }
        break;
      }
      case IF: {
        const c = look(scope, n.p);
        let known = -1;
        let kind = 0;
        switch (c.k) {
          case V_CONST: known = truthy(c.v) ? 1 : 0; break;
          case V_STR: kind = 0; break;
          case V_NUM: kind = 1; break;
          case V_BOOL: kind = 2; break;
          case V_ARR: kind = 3; break;
          case V_LINK: kind = 4; break;
          default: known = 1; // an object
        }
        if (known >= 0) {
          const branch = (known === 1) !== n.not ? n.a : n.b;
          if (branch !== null) compileNodes(branch, scope, depth);
          break;
        }
        const at = CODE.length;
        if (kind === 0 && c.a <= S_CONTENT && c.b >> 8 === 0) CODE.push(OP_IFF, placeOf(c.a, false), c.b, 0, n.not ? 1 : 0, 0);
        else if (kind === 0 && c.a >= S_TAGNAME && c.a <= S_TAGURL) CODE.push(OP_IFT, placeOf(c.a, false), c.b, 0, n.not ? 1 : 0, 0);
        else CODE.push(OP_IF, kind, c.a, c.b, n.not ? 1 : 0, 0);
        lastStatic = -1;
        compileNodes(n.a, scope, depth);
        if (n.b !== null) {
          const jump = CODE.length;
          CODE.push(OP_JMP, 0);
          CODE[at + 5] = CODE.length;
          lastStatic = -1;
          compileNodes(n.b, scope, depth);
          CODE[jump + 1] = CODE.length;
        } else CODE[at + 5] = CODE.length;
        lastStatic = -1;
        break;
      }
      case FOR: {
        const c = look(scope, n.p);
        if (c.k === V_CONST) {
          const xs = c.v;
          if (!Array.isArray(xs)) break;
          for (let k = 0; k < xs.length; k++) {
            const loop = cv(V_CONST, 0, 0, { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length });
            compileNodes(n.body, { n1: n.name, v1: n.name === 'loop' ? loop : cv(V_CONST, 0, 0, xs[k]), n2: 'loop', v2: loop, parent: scope }, depth);
          }
          break;
        }
        if (c.k !== V_ARR) break;
        const reg = nextReg++;
        if (reg > 255) throw BAIL;
        const loop = cv(V_LOOP, reg, 0);
        const item = c.a === A_TAGREFS ? cv(V_TAGREF, reg, 0) : c.a === A_TOC ? cv(V_TOC, reg, 0) : cv(V_SRC, reg, 0);
        const at = CODE.length;
        CODE.push(OP_FOR, c.a, c.b, reg, 0);
        lastStatic = -1;
        compileNodes(n.body, { n1: n.name, v1: n.name === 'loop' ? loop : item, n2: 'loop', v2: loop, parent: scope }, depth);
        CODE.push(OP_NEXT, c.a, reg, at + 5);
        CODE[at + 4] = CODE.length;
        lastStatic = -1;
        break;
      }
      default: {
        const t = TEMPLATES.get(n.name);
        if (t !== undefined && depth < 8) compileNodes(t, scope, depth + 1);
      }
    }
  }
}

/** A template compiled for one kind of page (0 a page, 1 an index page, 2 a tag's page, 3 the tags page): where it starts. */
function compile(name, kind) {
  const start = CODE.length;
  lastStatic = -1;
  nextReg = 1;
  const root = { site: ROOT.site, tags: ROOT.tags, recent: ROOT.recent };
  if (kind === 0) root.page = cv(V_SRC, 0, 1);
  else if (kind === 1) {
    root.posts = cv(V_ARR, A_POSTS, 0);
    root.pager = cv(V_PAGER, 0, 0);
  } else if (kind === 2) root.tag = cv(V_TAG, 0, 0);
  const saved = ROOT;
  ROOT = root;
  compileNodes(TEMPLATES.get(name), null, 0);
  ROOT = saved;
  CODE.push(OP_END);
  return start;
}

/** How long a string of a page is (through a newer or older post where sel says so), a tag's or a contents row's. */
function lengthOf(field, sel) {
  if (field <= S_CONTENT) {
    let f = R[sel & 255];
    const hop = sel >> 8;
    if (hop !== 0) {
      f = F[f + (hop === 1 ? NEWER : OLDER)];
      if (f < 0) return 0;
    }
    return F[f + placeOf(field, false) + 1];
  }
  if (field <= S_TAGURL) return TG[R[sel] + placeOf(field, false) + 1];
  return TC[R[sel] + (field === S_TOCID ? 2 : 4)];
}

function arrLen(kind, sel) {
  switch (kind) {
    case A_TAGREFS: return F[R[sel] + TGN];
    case A_TOC: return F[R[sel] + TOCN];
    case A_POSTS: return idxHi - idxLo;
    default: return TG[R[sel] + TPN];
  }
}

function num(kind, sel) {
  switch (kind) {
    case N_RM: return F[R[sel] + RM];
    case N_TAGCOUNT: return TG[R[sel] + TPN];
    case N_TOCLEVEL: return TC[R[sel]];
    case N_PNUM: return pgN;
    case N_PTOTAL: return pgT;
    case N_LIDX: return LI[sel];
    case N_LLEN: return LN[sel];
    default: return arrLen(kind - N_LEN, sel);
  }
}

function test(kind, a, b) {
  switch (kind) {
    case 0:
      if (a >= S_PURL) return a === S_PURL || (a === S_PNEWER ? pgN > 1 : pgN < pgT);
      return lengthOf(a, b) > 0;
    case 1: return num(a, b) !== 0;
    case 2: return a === B_ISPOST ? F[R[b] + POST] === 1 : a === B_LFIRST ? LI[b] === 1 : LI[b] === LN[b];
    case 3: return arrLen(a, b) > 0;
    default: return F[R[a] + (b === 1 ? NEWER : OLDER)] >= 0;
  }
}

/** An index page's url at h (page 1 is the site's root). */
function pageUrl(u, h, k, esc) {
  h = esc !== 0 ? k_cpy(u, h, BASE_EO, BASE_EL) : k_cpy(u, h, BASE_RO, BASE_RL);
  u[h++] = 47;
  if (k === 1) return h;
  h = wnum(u, k_lit(u, h, K_PAGE_DIR), k);
  u[h] = 47;
  return h + 1;
}

/** Runs a compiled template: the page written at op. */
function exec(pc) {
  const u = B;
  const C = CODE;
  let o = op;
  for (;;) {
    switch (C[pc]) {
      case OP_STATIC:
        o = k_cpy(u, o, C[pc + 1], C[pc + 2]);
        pc += 3;
        break;
      case OP_F: {
        const g = R[C[pc + 2]] + C[pc + 1];
        o = k_cpy(u, o, F[g], F[g + 1]);
        pc += 3;
        break;
      }
      case OP_T: {
        const g = R[C[pc + 2]] + C[pc + 1];
        o = k_cpy(u, o, TG[g], TG[g + 1]);
        pc += 3;
        break;
      }
      case OP_C: {
        const g = R[C[pc + 2]] + C[pc + 1];
        o = k_cpy(u, o, TC[g], TC[g + 1]);
        pc += 3;
        break;
      }
      case OP_IFF: {
        if ((F[R[C[pc + 2]] + C[pc + 1] + 1] > 0) !== (C[pc + 4] === 1)) pc += 6;
        else pc = C[pc + 5];
        break;
      }
      case OP_IFT: {
        if ((TG[R[C[pc + 2]] + C[pc + 1] + 1] > 0) !== (C[pc + 4] === 1)) pc += 6;
        else pc = C[pc + 5];
        break;
      }
      case OP_FH: {
        const f = F[R[C[pc + 2]] + (C[pc + 3] === 1 ? NEWER : OLDER)];
        if (f >= 0) o = k_cpy(u, o, F[f + C[pc + 1]], F[f + C[pc + 1] + 1]);
        pc += 4;
        break;
      }
      case OP_ESC: {
        const g = R[C[pc + 3]] + C[pc + 2];
        o = C[pc + 1] === 0 ? escTo(u, o, F[g], F[g] + F[g + 1]) : escTo(u, o, TC[g], TC[g] + TC[g + 1]);
        pc += 4;
        break;
      }
      case OP_STR: {
        const field = C[pc + 1];
        const k = field === S_PURL ? pgN : field === S_PNEWER ? (pgN > 1 ? pgN - 1 : 0) : pgN < pgT ? pgN + 1 : 0;
        if (k !== 0) o = pageUrl(u, o, k, C[pc + 3]);
        pc += 4;
        break;
      }
      case OP_NUM:
        o = wnum(u, o, num(C[pc + 1], C[pc + 2]));
        pc += 3;
        break;
      case OP_BOOL:
        o = k_lit(u, o, test(2, C[pc + 1], C[pc + 2]) ? K_TRUE : K_FALSE);
        pc += 3;
        break;
      case OP_SEP:
        for (let k = arrLen(C[pc + 1], C[pc + 2]); k > 1; k--) {
          u[o] = 44; u[o + 1] = 32;
          o += 2;
        }
        pc += 3;
        break;
      case OP_IF:
        if (test(C[pc + 1], C[pc + 2], C[pc + 3]) !== (C[pc + 4] === 1)) pc += 6;
        else pc = C[pc + 5];
        break;
      case OP_JMP:
        pc = C[pc + 1];
        break;
      case OP_FOR: {
        const kind = C[pc + 1];
        const sel = C[pc + 2];
        const reg = C[pc + 3];
        const n = arrLen(kind, sel);
        if (n === 0) {
          pc = C[pc + 4];
          break;
        }
        const base = kind === A_TAGREFS ? F[R[sel] + TG0] : kind === A_TOC ? F[R[sel] + TOC0] : kind === A_POSTS ? idxLo : TG[R[sel] + TP0];
        LP[reg] = base;
        LI[reg] = 1;
        LN[reg] = n;
        R[reg] = kind === A_TAGREFS ? TR[base] : kind === A_TOC ? base : kind === A_POSTS ? PO[base] : TP[base];
        pc += 5;
        break;
      }
      case OP_NEXT: {
        const reg = C[pc + 2];
        const k = LI[reg];
        if (k < LN[reg]) {
          const kind = C[pc + 1];
          const at = LP[reg] + (kind === A_TOC ? k * 5 : k);
          LI[reg] = k + 1;
          R[reg] = kind === A_TAGREFS ? TR[at] : kind === A_TOC ? at : kind === A_POSTS ? PO[at] : TP[at];
          pc = C[pc + 3];
        } else pc += 4;
        break;
      }
      default:
        op = o;
        return;
    }
  }
}

// ---- one case, bytes to bytes

const N_TEMPLATES = Buffer.from('},"templates":{');
const N_FILES = Buffer.from('},"files":[');
const N_CONTENT = Buffer.from('","content":"');
const N_CLOSE = Buffer.from('"}');
const K_SITE = bytes('{"site":{');
const K_PATH = bytes('{"path":"');
const K_NEXT_PATH = bytes(',{"path":"');
let inputEnd = -1; // where the input answer() last read ends, once it knows
const K_MD = bytes('.md');
const K_INDEX_HTML = bytes('index.html');
const K_REPORT_NAME = bytes('build-report.txt');
const K_TAGS_SLASH = bytes('tags/');
const K_PAGE_SLASH = bytes('page/');

/** The tags of the case: every spelling's slug, every slug's tag, each source's tags and each tag's posts. */
function tagPhase(u, kept, nKept, posts, nPosts, base) {
  const slugOfName = new Int32Array(nmN >> 1).fill(-1); // each spelling's slug, as a number
  const slugNumber = new Map();
  const slugs = [];
  const tagOfSlug = []; // each slug's tag, -1 while no post has it
  const names = []; // each tag's name, slug and url, as templates read them
  const seen = [];
  let nTags = 0;
  let trN = 0;
  const refs = (f, post) => {
    const t0 = F[f + TN0];
    const n = F[f + TNN];
    const start = trN;
    let nSeen = 0;
    for (let k = 0; k < n; k++) {
      const g = TN[t0 + k];
      let id = slugOfName[g >> 1];
      if (id < 0) {
        const slug = slugify(str(NM[g], NM[g + 1]));
        const known = slugNumber.get(slug);
        if (known === undefined) {
          id = slugs.length;
          slugNumber.set(slug, id);
          slugs.push(slug);
          tagOfSlug.push(-1);
        } else id = known;
        slugOfName[g >> 1] = id;
      }
      // each slug once in a source, its first spelling kept
      let again = false;
      for (let j = 0; j < nSeen; j++) if (seen[j] === id) again = true;
      if (again) continue;
      seen[nSeen++] = id;
      let t = tagOfSlug[id];
      if (t < 0) {
        // A new tag, named as it is first met: a post's is its slug's from here on; a page's, where no post has
        // the slug, is its own and has no url.
        if ((nTags + 1) * TS > TG.length) {
          const grown = new Int32Array(TG.length * 2);
          grown.set(TG);
          TG = grown;
        }
        const a = NM[g];
        const len = NM[g + 1] - a;
        const slug = slugs[id];
        t = nTags++ * TS;
        room(8 * len + 3 * BASE_EL + 256);
        TG[t + NRO] = a;
        TG[t + NRL] = len;
        TG[t + NEO] = sp;
        sp = escTo(u, sp, a, a + len);
        TG[t + NEL] = sp - TG[t + NEO];
        TG[t + TSO] = sp;
        sp += BUF.latin1Write(slug, sp);
        TG[t + TSL] = sp - TG[t + TSO];
        TG[t + TPN] = 0;
        if (post) {
          tagOfSlug[id] = t;
          TG[t + TUO] = sp;
          sp = k_lit(u, k_cpy(u, sp, BASE_EO, BASE_EL), K_TAGS_DIR);
          sp = k_cpy(u, sp, TG[t + TSO], TG[t + TSL]);
          u[sp++] = 47;
          TG[t + TUL] = sp - TG[t + TUO];
          TG[t + TVO] = sp;
          sp = k_lit(u, k_cpy(u, sp, BASE_RO, BASE_RL), K_TAGS_DIR);
          sp = k_cpy(u, sp, TG[t + TSO], TG[t + TSL]);
          u[sp++] = 47;
          TG[t + TVL] = sp - TG[t + TVO];
        } else TG[t + TUL] = TG[t + TVL] = 0;
        names.push({ name: str(a, a + len), slug, url: post ? `${base}/tags/${slug}/` : '' });
      }
      if (trN === TR.length) {
        const grown = new Int32Array(TR.length * 2);
        grown.set(TR);
        TR = grown;
      }
      TR[trN++] = t;
      if (post) TG[t + TPN]++;
    }
    F[f + TG0] = start;
    F[f + TGN] = trN - start;
  };
  for (let k = 0; k < nPosts; k++) refs(posts[k], true);
  const nReal = nTags;
  for (let k = 0; k < nKept; k++) if (F[kept[k] + POST] === 0) refs(kept[k], false);
  // Each tag's posts, in the posts' order.
  let at = 0;
  for (let t = 0; t < nReal; t++) {
    TG[t * TS + TP0] = at;
    at += TG[t * TS + TPN];
    TG[t * TS + TPN] = 0;
  }
  if (at > TP.length) TP = new Int32Array(at * 2);
  for (let k = 0; k < nPosts; k++) {
    const f = posts[k];
    for (let j = F[f + TG0], e = j + F[f + TGN]; j < e; j++) {
      const t = TR[j];
      TP[TG[t + TP0] + TG[t + TPN]++] = f;
    }
  }
  // Most posts first, then by slug.
  const order = [];
  for (let t = 0; t < nReal; t++) order.push(t);
  order.sort((x, y) => TG[y * TS + TPN] - TG[x * TS + TPN] || byCodeUnits(names[x].slug, names[y].slug));
  return { names, order };
}

// What a case's sources are read into, one source at a time.
let REFUSED = []; // [row, reason] in the sources' order
let DRAFTS = [];
let LAYOUTS = new Map(); // each layout's number
let LAYOUT_NAMES = [];
let TAKEN = new Map(); // the slugs taken in each directory
let POST_SLUGS = new Set();
let SLUGS = new Map(); // each page's slug
let PROGRAMS = new Int32Array(0); // each layout compiled: where it starts
let tocKept = 0; // the tables of contents kept with the recent posts end here

/** A source's front matter read: whether it is built (it is refused, or a draft, where it is not). */
function admit(f) {
  const u = B;
  const ps = F[f + PS];
  const post = eq(u, ps, K_POSTS) && F[f + PE] - ps >= 6;
  let reason = frontMatter(f, F[f + BS], F[f + CE]);
  let layout = '';
  if (reason === null) {
    if ((eq(u, ps, K_TAGS_SLASH) || eq(u, ps, K_PAGE_SLASH)) && F[f + PE] - ps >= 5) reason = `${BUF.latin1Slice(ps, ps + 4)}/ is the generator's own`;
    else if (post && F[f + DATE] === 0) reason = 'a post needs a date';
    else {
      layout = F[f + LYL] > 0 ? BUF.latin1Slice(F[f + LYO], F[f + LYO] + F[f + LYL]) : post ? 'post' : 'page';
      if (!TEMPLATES.has(layout)) reason = `layout "${layout}" is no template that parses`;
    }
  }
  if (reason !== null) {
    F[f + ST] = 1;
    REFUSED.push(f, reason);
    return false;
  }
  if (fmDraft === 1) {
    F[f + ST] = 2;
    DRAFTS.push(f);
    return false;
  }
  let id = LAYOUTS.get(layout);
  if (id === undefined) {
    LAYOUTS.set(layout, (id = LAYOUT_NAMES.length));
    LAYOUT_NAMES.push(layout);
  }
  F[f + LAY] = id;
  F[f + POST] = post ? 1 : 0;
  F[f + BS] = fmBody;
  F[f + NEWER] = F[f + OLDER] = -1;
  return true;
}

/** A built page's slug, unique in its directory in the sources' order; its output directory, url and long date. */
function permalink(f) {
  const u = B;
  const ps = F[f + PS];
  const post = F[f + POST] === 1;
  const dirLen = post ? 0 : F[f + DE] - ps;
  let set = POST_SLUGS;
  if (!post) {
    const dir = dirLen === 0 ? '' : BUF.latin1Slice(ps, ps + dirLen);
    set = TAKEN.get(dir);
    if (set === undefined) TAKEN.set(dir, (set = new Set(dir === '' ? RESERVED : [])));
  }
  room(16 * (F[f + PE] - ps) + 6 * BASE_EL + 2048);
  let slug;
  if (F[f + SKL] > 0) slug = BUF.latin1Slice(F[f + SKO], F[f + SKO] + F[f + SKL]);
  else {
    const len = k_slug(u, F[f + TRO], F[f + TRO] + F[f + TRL], sp);
    slug = len < 0 ? slugify(str(F[f + TRO], F[f + TRO] + F[f + TRL])) : BUF.latin1Slice(sp, sp + len);
  }
  slug = uniqueSlug(slug, set);
  SLUGS.set(f, slug);
  // "<directory>/<slug>", then the url
  F[f + KO] = sp;
  if (post) sp = k_lit(u, sp, K_POSTS);
  else if (dirLen > 0) {
    sp = k_cpy(u, sp, ps, dirLen);
    u[sp++] = 47;
  }
  F[f + SLO] = sp;
  sp += BUF.latin1Write(slug, sp);
  F[f + SLL] = sp - F[f + SLO];
  F[f + KL] = sp - F[f + KO];
  F[f + URO] = sp;
  sp = k_cpy(u, sp, BASE_RO, BASE_RL);
  u[sp++] = 47;
  sp = k_cpy(u, sp, F[f + KO], F[f + KL]);
  u[sp++] = 47;
  F[f + URL_] = sp - F[f + URO];
  F[f + UEO] = sp;
  sp = k_cpy(u, sp, BASE_EO, BASE_EL);
  u[sp++] = 47;
  sp = escTo(u, sp, F[f + KO], F[f + KO] + F[f + KL]);
  u[sp++] = 47;
  F[f + UEL] = sp - F[f + UEO];
  if (F[f + DATE] !== 0) {
    const date = F[f + DATE];
    F[f + DLO] = sp;
    sp = wnum(u, sp, date % 100);
    u[sp++] = 32;
    sp = k_lit(u, sp, K_MONTHS[(((date / 100) | 0) % 100) - 1]);
    u[sp++] = 32;
    sp = wnum(u, sp, (date / 10000) | 0);
    F[f + DLL] = sp - F[f + DLO];
  }
}

/** A built page through its layout: its Markdown first, unless it is a recent post's and rendered already. */
function page(f) {
  const u = B;
  if (F[f + RM] === 0) {
    hp = HT0;
    tcN = tocKept;
    markdown(f);
    if (hp > HT1) throw BAIL;
  }
  let pc = PROGRAMS[F[f + LAY]];
  if (pc < 0) pc = PROGRAMS[F[f + LAY]] = compile(LAYOUT_NAMES[F[f + LAY]], 0);
  u[op++] = 34;
  op = k_lit(u, k_cpy(u, op, F[f + KO], F[f + KL]), K_INDEX_KEY);
  R[0] = f;
  exec(pc);
  u[op] = 34; u[op + 1] = 44;
  op += 2;
  if (op > OUT_FLUSH) flush();
  // What the lists show of a post outlives its page: its excerpt.
  if (F[f + XO] >= HT0 && F[f + POST] === 1) {
    room(F[f + XL] + 65536);
    const at = sp;
    sp = k_cpy(u, sp, F[f + XO], F[f + XL]);
    F[f + XO] = at;
  }
}

/** One case's answer written at op: its input is the JSON object that opens at c0. */
function answer(c0) {
  const u = B;
  if (!eq(u, c0, K_SITE)) throw BAIL;
  const siteEnd = IN.indexOf(N_TEMPLATES, c0);
  if (siteEnd < 0) throw BAIL;
  const templatesEnd = IN.indexOf(N_FILES, siteEnd);
  if (templatesEnd < 0) throw BAIL;
  const site = JSON.parse(BUF.utf8Slice(c0 + 8, siteEnd + 1));
  const sources = JSON.parse(BUF.utf8Slice(siteEnd + 14, templatesEnd + 1));
  const per = site.per_page;
  const recentN = site.recent;
  if (typeof site.title !== 'string' || typeof site.base_url !== 'string' || !Number.isInteger(per) || per < 1 || per > 1e6 || !Number.isInteger(recentN) || recentN < 0) throw BAIL;
  for (const k in sources) if (typeof sources[k] !== 'string') throw BAIL;

  // The files: a row each. A content ends at the first quote no backslash escapes, and "}" follows it.
  let n = 0;
  let p = templatesEnd + 11;
  let c1 = 0;
  if (u[p] === 93) {
    if (u[p + 1] !== 125) throw BAIL;
    c1 = p + 2;
  } else {
    for (;;) {
      if (!eq(u, p, K_PATH)) throw BAIL;
      const ps = p + 9;
      const pe = IN.indexOf(N_CONTENT, ps);
      if (pe < 0) throw BAIL;
      const cs = pe + 13;
      let ce = cs;
      for (;;) {
        ce = IN.indexOf(N_CLOSE, ce);
        if (ce < 0) throw BAIL;
        if (u[ce - 1] !== 92) break;
        let k = ce - 1;
        while (k >= cs && u[k] === 92) k--;
        if (((ce - 1 - k) & 1) === 0) break;
        ce++;
      }
      if ((n + 1) * FS > F.length) {
        const g = new Int32Array(F.length * 2);
        g.set(F);
        F = g;
      }
      const f = n++ * FS;
      F.fill(0, f, f + FS);
      F[f + PS] = ps;
      F[f + PE] = pe;
      F[f + BS] = cs;
      F[f + CE] = ce;
      if (u[ce + 2] === 93) {
        if (u[ce + 3] !== 125) throw BAIL;
        c1 = ce + 4;
        break;
      }
      if (!eq(u, ce + 2, K_NEXT_PATH)) throw BAIL;
      p = ce + 3;
    }
  }
  inputEnd = c1;
  hasE2 = IN.subarray(c0, c1).indexOf(0xe2) !== -1;

  // Paths: plain ASCII, no escape, none from the root. Sources apart from static files.
  const md = [];
  const statics = [];
  for (let f = 0; f < n * FS; f += FS) {
    const ps = F[f + PS];
    const pe = F[f + PE];
    if (pe === ps || u[ps] === 47 || k_find(u, ps, pe, 5, 0) >= 0) throw BAIL;
    let slash = pe - 1;
    while (slash > ps && u[slash] !== 47) slash--;
    F[f + DE] = slash;
    if (pe - ps >= 3 && eq(u, pe - 3, K_MD)) md.push(f);
    else {
      F[f + ST] = 3;
      if ((pe - ps >= 10 && eq(u, pe - 10, K_INDEX_HTML)) || (pe - ps === 16 && eq(u, ps, K_REPORT_NAME))) throw BAIL;
      statics.push(f);
    }
  }
  for (let x = 0; x < statics.length; x++) {
    for (let y = 0; y < x; y++) {
      const a = statics[x];
      const b = statics[y];
      if (F[a + PE] - F[a + PS] === F[b + PE] - F[b + PS] && same(u, F[a + PS], F[b + PS], F[a + PE] - F[a + PS])) throw BAIL;
    }
  }
  // The sources in the order of their paths (as strings sort: by code unit). No source's path opens another's: then
  // the report's lines sort as the sources do.
  const rowOf = new Map();
  const names = [];
  for (const f of md) {
    const name = BUF.latin1Slice(F[f + PS], F[f + PE]);
    names.push(name);
    rowOf.set(name, f);
  }
  names.sort();
  for (let k = 0; k < names.length; k++) {
    if (k > 0 && names[k].startsWith(names[k - 1])) throw BAIL;
    md[k] = rowOf.get(names[k]);
  }

  const report = [];
  TEMPLATES = parseTemplates(sources, report);
  const base = site.base_url.replace(/\/+$/, '');
  sp = SCR0;
  tnN = 0;
  tcN = 0;
  brN = 0;
  room(12 * base.length + 4096);
  BASE_RO = sp;
  sp += BUF.write(jsonText(base), sp);
  BASE_RL = sp - BASE_RO;
  BASE_EO = BASE_RO;
  BASE_EL = BASE_RL;
  const baseEscaped = escapeHtml(base);
  if (baseEscaped !== base) {
    BASE_EO = sp;
    sp += BUF.write(jsonText(baseEscaped), sp);
    BASE_EL = sp - BASE_EO;
  }

  // Front matter: which sources are built, and why the others are not.
  const kept = new Int32Array(md.length);
  let nKept = 0;
  REFUSED = [];
  DRAFTS = [];
  LAYOUTS = new Map();
  LAYOUT_NAMES = [];
  nmN = 0;
  NH.fill(0);
  for (const f of md) if (admit(f)) kept[nKept++] = f;

  // Permalinks, in the sources' order.
  TAKEN = new Map();
  POST_SLUGS = new Set();
  SLUGS = new Map();
  for (let k = 0; k < nKept; k++) permalink(kept[k]);
  const slugs = SLUGS;
  const refused = REFUSED;
  const drafts = DRAFTS;

  // What links may name: the built pages and the static files.
  let size = 64;
  while (size < 2 * (nKept + statics.length) + 2) size *= 2;
  if (size > HT.length) HT = new Int32Array(size);
  else HT.fill(0, 0, size);
  hMask = size - 1;
  for (let k = 0; k < nKept; k++) hashPut(u, kept[k]);
  for (const f of statics) hashPut(u, f);

  // The posts, newest first and then by slug; each one's neighbours.
  // (One string a post sorts by: its date counted down, eight digits, then its slug.)
  const posts = [];
  {
    const postOf = new Map();
    const keys = [];
    for (let k = 0; k < nKept; k++) {
      const f = kept[k];
      if (F[f + POST] !== 1) continue;
      const key = (99999999 - F[f + DATE]) + slugs.get(f);
      keys.push(key);
      postOf.set(key, f);
    }
    keys.sort();
    for (const key of keys) posts.push(postOf.get(key));
  }
  const nPosts = posts.length;
  if (nPosts > PO.length) PO = new Int32Array(nPosts * 2);
  for (let k = 0; k < nPosts; k++) {
    PO[k] = posts[k];
    if (k > 0) F[posts[k] + NEWER] = posts[k - 1];
    if (k + 1 < nPosts) F[posts[k] + OLDER] = posts[k + 1];
  }

  const tags = tagPhase(u, kept, nKept, posts, nPosts, base);

  // The recent posts are part of every page: rendered first, and kept.
  const nRecent = Math.min(recentN, nPosts);
  for (let k = 0; k < nRecent; k++) {
    const f = posts[k];
    room(8 * (F[f + CE] - F[f + BS]) + 65536);
    hp = sp;
    markdown(f);
    sp = hp;
  }
  tocKept = tcN; // their tables of contents are kept with them
  const tagOf = (t) => ({ name: tags.names[t / TS].name, slug: tags.names[t / TS].slug, url: tags.names[t / TS].url });
  const cardOf = (f) => {
    const own = [];
    for (let j = F[f + TG0], e = j + F[f + TGN]; j < e; j++) own.push(tagOf(TR[j]));
    return {
      title: str(F[f + TRO], F[f + TRO] + F[f + TRL]),
      url: str(F[f + URO], F[f + URO] + F[f + URL_]),
      date: F[f + DATE] === 0 ? '' : BUF.latin1Slice(F[f + DO], F[f + DO] + 10),
      date_long: BUF.latin1Slice(F[f + DLO], F[f + DLO] + F[f + DLL]),
      summary: str(F[f + SRO], F[f + SRO] + F[f + SRL]),
      excerpt: str(F[f + XO], F[f + XO] + F[f + XL]),
      reading_minutes: F[f + RM],
      tags: own,
    };
  };
  const recent = [];
  for (let k = 0; k < nRecent; k++) recent.push(cardOf(posts[k]));
  ROOT = {
    site: cv(V_CONST, 0, 0, { title: site.title, base_url: base }),
    tags: cv(V_CONST, 0, 0, tags.order.map((t) => ({ ...tags.names[t], count: TG[t * TS + TPN] }))),
    recent: cv(V_CONST, 0, 0, recent),
  };
  CODE = [];

  // Every page through its layout.
  u[op++] = 123;
  PROGRAMS = new Int32Array(LAYOUT_NAMES.length).fill(-1);
  for (let k = 0; k < nKept; k++) page(kept[k]);

  // The index pages, each tag's page and the tags page.
  if (TEMPLATES.has('index')) {
    const pc = compile('index', 1);
    pgT = Math.max(1, Math.ceil(nPosts / per));
    for (pgN = 1; pgN <= pgT; pgN++) {
      idxLo = (pgN - 1) * per;
      idxHi = Math.min(pgN * per, nPosts);
      u[op++] = 34;
      op = pgN > 1 ? k_lit(u, wnum(u, k_lit(u, op, K_PAGE_DIR), pgN), K_INDEX_KEY) : k_lit(u, op, K_INDEX_ROOT);
      exec(pc);
      u[op] = 34; u[op + 1] = 44;
      op += 2;
      if (op > OUT_FLUSH) flush();
    }
  }
  if (TEMPLATES.has('tag')) {
    const pc = compile('tag', 2);
    for (const t of tags.order) {
      const g = t * TS;
      u[op++] = 34;
      op = k_cpy(u, k_lit(u, op, K_TAGS_SLASH), TG[g + TSO], TG[g + TSL]);
      op = k_lit(u, op, K_INDEX_KEY);
      R[0] = g;
      exec(pc);
      u[op] = 34; u[op + 1] = 44;
      op += 2;
      if (op > OUT_FLUSH) flush();
    }
  }
  if (TEMPLATES.has('tags')) {
    const pc = compile('tags', 3);
    u[op++] = 34;
    op = k_lit(u, k_lit(u, op, K_TAGS_SLASH) - 1, K_INDEX_KEY);
    exec(pc);
    u[op] = 34; u[op + 1] = 44;
    op += 2;
  }

  // Each static file at its own path, its text as given.
  flush();
  for (const f of statics) {
    if (op + (F[f + CE] - F[f + PS]) + 64 > OUT1) throw BAIL;
    u[op++] = 34;
    op = k_cpy(u, op, F[f + PS], F[f + PE] - F[f + PS]);
    u[op] = 34; u[op + 1] = 58; u[op + 2] = 34;
    op = k_cpy(u, op + 3, F[f + BS], F[f + CE] - F[f + BS]);
    u[op] = 34; u[op + 1] = 44;
    op += 2;
  }

  // The report: every line sorted, then the counts.
  flush();
  op = k_lit(u, op, K_REPORT_KEY);
  for (let k = 0; k < nKept; k++) {
    const f = kept[k];
    const count = F[f + BRN];
    if (count === 0) continue;
    const b0 = F[f + BR0];
    // This page's broken links, in the order of their targets.
    for (let x = 1; x < count; x++) {
      const a = BR[b0 + 2 * x];
      const len = BR[b0 + 2 * x + 1];
      let y = x - 1;
      while (y >= 0 && targetAfter(u, BR[b0 + 2 * y], BR[b0 + 2 * y + 1], a, len)) {
        BR[b0 + 2 * y + 2] = BR[b0 + 2 * y];
        BR[b0 + 2 * y + 3] = BR[b0 + 2 * y + 1];
        y--;
      }
      BR[b0 + 2 * y + 2] = a;
      BR[b0 + 2 * y + 3] = len;
    }
    if (op > OUT_FLUSH) flush();
    if (op + count * (F[f + PE] - F[f + PS] + 32) > OUT1) throw BAIL;
    for (let x = 0; x < count; x++) {
      const len = BR[b0 + 2 * x + 1];
      if (op + len + 64 > OUT1) throw BAIL;
      op = k_cpy(u, k_lit(u, op, K_BROKEN), F[f + PS], F[f + PE] - F[f + PS]);
      op = k_cpy(u, k_lit(u, op, K_ARROW), BR[b0 + 2 * x], len);
      u[op] = 92; u[op + 1] = 110;
      op += 2;
    }
  }
  for (const f of drafts) {
    op = k_cpy(u, k_lit(u, op, K_DRAFT), F[f + PS], F[f + PE] - F[f + PS]);
    u[op] = 92; u[op + 1] = 110;
    op += 2;
  }
  for (let k = 0; k < refused.length; k += 2) {
    const f = refused[k];
    op = k_cpy(u, k_lit(u, op, K_REFUSED), F[f + PS], F[f + PE] - F[f + PS]);
    u[op] = 58; u[op + 1] = 32;
    op += 2;
    const reason = jsonText(refused[k + 1]);
    if (op + 3 * reason.length + 64 > OUT1) throw BAIL;
    op += BUF.write(reason, op);
    u[op] = 92; u[op + 1] = 110;
    op += 2;
  }
  let tail = '';
  for (const line of report.sort(byCodeUnits)) tail += `${line}\n`;
  tail += `built ${nKept - nPosts} pages, ${nPosts} posts, ${tags.order.length} tags and ${statics.length} static files\n`;
  tail = jsonText(tail);
  if (op + 3 * tail.length + 64 > OUT1) throw BAIL;
  op += BUF.write(tail, op);
  u[op] = 34; u[op + 1] = 125;
  op += 2;
}

/** Whether target a sorts after target b: code-unit order of the texts they are. */
function targetAfter(u, a, an, b, bn) {
  const n = an < bn ? an : bn;
  for (let k = 0; k < n; k++) {
    const x = u[a + k];
    const y = u[b + k];
    if (x >= 128 || y >= 128 || x === 92 || y === 92) return str(a, a + an) > str(b, b + bn);
    if (x !== y) return x > y;
  }
  return an > bn;
}

// ---------------------------------------------------------------- the driver's three calls

class Input {
  constructor(index, at) {
    this.index = index;
    this.at = at;
  }
}

class Answer {
  constructor(index) {
    this.index = index;
  }
}

const N_INPUT = Buffer.from('","input":');
const K_ID_KEY = bytes('{"id":"');
let FILE = '';

/** The file read into one store: where the first case's input opens. */
function open(file) {
  const fd = openSync(file, 'r');
  let size = 0;
  try {
    size = fstatSync(fd).size | 0; // a small integer from here on: every place in the store is computed from it
    if (size < 2 || size > 400_000_000) throw BAIL;
    const out = 6 << 20;
    const scr = size * 2 + (4 << 20);
    const tmp = 1 << 16;
    const html = size * 2 + (2 << 20);
    const total = size + 16 + out + scr + tmp + html;
    BUF = Buffer.allocUnsafeSlow(total);
    B = new Uint8Array(BUF.buffer, BUF.byteOffset, total);
    IN = BUF.subarray(0, size);
    SIZE = size;
    let got = 0;
    while (got < size) {
      const n = readSync(fd, BUF, got, size - got, got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== size) throw BAIL;
    B[size] = 92; // every search for a backslash ends here at the latest
    B[size + 1] = 110;
    OUT0 = size + 16;
    OUT1 = OUT0 + out - 4096;
    OUT_FLUSH = OUT0 + (256 << 10);
    SCR0 = OUT0 + out;
    SCR1 = SCR0 + scr - 4096;
    TMP0 = SCR0 + scr;
    TMP1 = TMP0 + tmp - 16;
    HT0 = TMP0 + tmp;
    HT1 = total - 4096;
    op = OUT0;
    outFd = -1;
    failed = false;
  } finally {
    closeSync(fd);
  }
  prime();
  if (B[0] !== 91 || !eq(B, 1, K_ID_KEY)) throw BAIL;
  const q = IN.indexOf(N_INPUT, 8);
  if (q < 0) throw BAIL;
  return q + 10;
}

/**
 * Each case's input in turn, as a place in the store. The next one opens where run() found the last one ended; where
 * run() did not get that far (or the file is not laid out as this path reads it), the cases left are handed over
 * parsed.
 */
function* inputs(first) {
  const u = B;
  let at = first;
  for (let index = 0; ; index++) {
    inputEnd = -1;
    yield new Input(index, at);
    const end = inputEnd;
    if (end >= 0 && u[end] === 125 && u[end + 1] === 93 && end + 2 === SIZE) return;
    const q = end >= 0 && u[end] === 125 && u[end + 1] === 44 && eq(u, end + 2, K_ID_KEY) ? IN.indexOf(N_INPUT, end + 9) : -1;
    if (q < 0) {
      const all = JSON.parse(readFileSync(FILE, 'utf8'));
      for (let k = index + 1; k < all.length; k++) yield all[k].input;
      return;
    }
    at = q + 10;
  }
}

/** Every case's input, read from cases.json: what run() takes, one at a time. */
export function cases(file, answersFile) {
  FILE = file ?? `${process.env.MAKEFUN_INPUT_DIR ?? '/input'}/cases.json`;
  outFile = answersFile ?? `${process.env.MAKEFUN_OUTPUT_DIR ?? '/output'}/answers.json`;
  let first = 0;
  try {
    first = open(FILE);
  } catch (err) {
    if (DEBUG) throw err;
    return JSON.parse(readFileSync(FILE, 'utf8')).map((c) => c.input);
  }
  return inputs(first);
}

/**
 * makefun-site 1.0.0's answer for one case's input: an object of path to text for a parsed input; for an input from
 * cases(), the same answer as JSON text, written toward answers.json as it is made (the Answer says which case).
 */
export function run(input) {
  if (!(input instanceof Input)) return build(input);
  if (!failed) {
    try {
      B[op++] = input.index === 0 ? 91 : 44;
      answer(input.at);
      return new Answer(input.index);
    } catch (err) {
      if (DEBUG) throw err;
      failed = true;
      inputEnd = -1;
    }
  }
  return null; // left to answers(): this file is answered whole by build()
}

/** The answers finished as answers.json, one per case and in the cases' order. */
export function answers(list, file) {
  const path = file ?? outFile;
  let whole = !failed && list.length > 0 && path === outFile;
  for (let k = 0; whole && k < list.length; k++) whole = list[k] instanceof Answer && list[k].index === k;
  if (whole) {
    try {
      B[op++] = 93;
      flush();
      closeSync(outFd);
      outFd = -1;
      return;
    } catch (err) {
      if (DEBUG) throw err;
    }
  }
  if (outFd >= 0) {
    closeSync(outFd);
    outFd = -1;
  }
  // Not every case went the byte path (or none did): each parsed input is answered by build().
  const parsed = FILE === '' ? [] : JSON.parse(readFileSync(FILE, 'utf8'));
  const out = list.map((a, k) => (a instanceof Answer || a === null ? build(parsed[k].input) : a));
  writeFileSync(path, JSON.stringify(out));
}
