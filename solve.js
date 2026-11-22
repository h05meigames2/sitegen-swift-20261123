// sitegen-swift: a faster drop-in for makefun-site 1.0.0.
// Written from scratch for the make.fun "Build a static site faster" bounty.
// It implements the same build as makefun-site (same front matter, template
// dialect, Markdown subset, slug rule and report) with the hot paths
// reworked: inline rendering works on string ranges (no substring copies
// for nested constructs), templates are compiled once per case into plain
// JavaScript render functions (no per-node dispatch at render time), and
// output accumulates into arrays joined once. No dependencies, no I/O, no
// clock, no randomness.
//
// run(input) returns makefun-site 1.0.0's answer for one case's input:
// { site, templates, files } -> { <output path>: <file text> }.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast path: no special char, return as-is. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

export const SLUG_MAX = 64;

// slugify is a pure function of its text, so results are cached across
// cases and runs (headings, titles and tag names repeat).
const SLUG_CACHE = new Map();

const NON_ASCII = /[^\x00-\x7F]/;

/** The slug of `text` (same rule as makefun-site). ASCII fast path, exact slow path. */
function slugify(text) {
  if (!NON_ASCII.test(text)) {
    const parts = [];
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = parts.length > 0;
        continue;
      }
      if (gap) parts.push('-');
      gap = false;
      parts.push(String.fromCharCode(keep));
    }
    let out = parts.join('').slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const parts = [];
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = parts.length > 0;
      continue;
    }
    if (gap) parts.push('-');
    gap = false;
    parts.push(keep);
  }
  const out = parts.join('').slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// JavaScript \s: ASCII whitespace, plus U+0085, U+00A0, U+1680,
// U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS[c] = 1;

/** The words of `lines[from..]`: runs of characters other than whitespace. */
function wordsOfLines(lines, from) {
  let n = 0;
  for (let li = from; li < lines.length; li++) {
    const line = lines[li];
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      if (WS[line.charCodeAt(i)]) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Is `line` blank (spaces and tabs only)? */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Parse one front-matter line: { key, raw } or null when it is not "key: value". */
function fmLine(line) {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  for (let i = 0; i < colon; i++) {
    const c = line.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return null;
  }
  const rest = line.slice(colon + 1);
  if (rest === '') return { key: line.slice(0, colon), raw: '' };
  if (rest.charCodeAt(0) !== 32) return null;
  let raw = rest.slice(1);
  let e = raw.length;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  if (e !== raw.length) raw = raw.slice(0, e);
  return { key: line.slice(0, colon), raw };
}

function parseFrontMatter(text) {
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
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const m = fmLine(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    if (!KEYS.has(m.key)) return { error: `unknown key "${m.key}"` };
    if (Object.hasOwn(data, m.key)) return { error: `key "${m.key}" is given twice` };
    if (m.raw === '') return { error: `key "${m.key}" has no value` };
    const v = valueOf(m.key, m.raw);
    if ('error' in v) return v;
    data[m.key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

// The characters a backslash can escape: \ ` * _ [ ] ( ) # + - . ! >
function isEscapable(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

/**
 * The first index in [from, hi) where `s` holds `what` outside a backslash
 * escape, or -1. indexOf jumps between candidates; a candidate is escaped
 * exactly when an odd run of backslashes stands right before it (backslashes
 * pair up left to right, so parity decides).
 */
function findUnescaped(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= hi) {
    let n = 0;
    for (let k = j - 1; k >= 0 && s.charCodeAt(k) === 92; k--) n++;
    if ((n & 1) === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    let n = 0;
    for (let k = j - 1; k >= 0 && s.charCodeAt(k) === 92; k--) n++;
    if ((n & 1) === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters inline rendering must stop at: constructs and HTML specials. */
const INLINE_RE = /[\\`*\[&<>"']/g;
const INLINE_TEST = /[\\`*\[&<>"']/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * A native regex scan jumps between special characters; the plain runs
 * between them hold nothing escapable and are copied verbatim. A special
 * that opens no construct stays in the plain run (the scan simply resumes
 * past it). Nested strong/emphasis/link text is rendered on the same string
 * by range, so no substring is copied for it. The shared regex's position
 * is reset after every recursive call.
 */
function inline(s, env) {
  if (!INLINE_TEST.test(s)) return s;
  return inlineRange(s, env, 0, s.length);
}

function inlineRange(s, env, lo, hi) {
  let out = '';
  let start = lo;
  INLINE_RE.lastIndex = lo;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null && m.index < hi) {
    const i = m.index;
    const c = s[i];
    if (c === '\\') { // backslash escape
      if (i + 1 < hi && isEscapable(s.charCodeAt(i + 1))) {
        if (i > start) out += s.slice(start, i);
        out += s[i + 1];
        INLINE_RE.lastIndex = i + 2;
        start = i + 2;
      } else {
        INLINE_RE.lastIndex = i + 1;
      }
      continue;
    }
    if (c === '`') { // code span
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < hi) {
        if (i > start) out += s.slice(start, i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        INLINE_RE.lastIndex = j + 1;
        start = j + 1;
      } else {
        INLINE_RE.lastIndex = i + 1;
      }
      continue;
    }
    if (c === '*') { // strong or emphasis
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          if (i > start) out += s.slice(start, i);
          out += `<strong>${inlineRange(s, env, i + 2, j)}</strong>`;
          INLINE_RE.lastIndex = j + 2;
          start = j + 2;
        } else {
          INLINE_RE.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        if (i > start) out += s.slice(start, i);
        out += `<em>${inlineRange(s, env, i + 1, j)}</em>`;
        INLINE_RE.lastIndex = j + 1;
        start = j + 1;
      } else {
        INLINE_RE.lastIndex = i + 1;
      }
      continue;
    }
    if (c === '[') { // link
      const k = findUnescaped(s, ']', i + 1, hi);
      let p = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      if (p >= hi) p = -1;
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        if (i > start) out += s.slice(start, i);
        out += `<a href="${escapeHtml(env.link(target))}">${inlineRange(s, env, i + 1, k)}</a>`;
        INLINE_RE.lastIndex = p + 1;
        start = p + 1;
      } else {
        INLINE_RE.lastIndex = i + 1;
      }
      continue;
    }
    // One of & < > " ' : escape it.
    if (i > start) out += s.slice(start, i);
    out += ESCAPES[c];
    start = i + 1;
  }
  if (start < hi) out += s.slice(start, hi);
  return out;
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    const lang = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!lang) break;
    j++;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let c = 0;
  while (c < 6 && line.charCodeAt(c) === 35) c++;
  if (c === 0 || c === 6 + 1) return null;
  if (c >= 1 && line.charCodeAt(c) !== 32 && line.charCodeAt(c) !== 9) return null;
  let j = c;
  while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: c, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  const c = line.charCodeAt(j);
  return c !== 32 && c !== 9 && c !== 12 && c !== 11 && c !== 13;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `lines[from..]` rendered: its HTML, table of contents and excerpt.
 * Lexing and rendering are fused into one pass over the lines.
 */
function renderMarkdown(lines, from, env, slug) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const codeParts = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        codeParts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${codeParts.join('')}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slug(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // blockquote
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const c0 = line.charCodeAt(0);
    const c1 = line.charCodeAt(1);
    let list = null;
    if ((c0 === 45 || c0 === 42) && c1 === 32) list = { ordered: false, start: 1 };
    else {
      // ordered: 1-9 digits, then ". "
      let d = 0;
      while (d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        list = { ordered: true, start: Number(line.slice(0, d)) };
      }
    }
    if (list !== null) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (!list.ordered) {
          if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) m = l.slice(2);
        } else {
          let d = 0;
          while (d < 9 && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d >= 1 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) m = l.slice(d + 2);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(l)) {
          // continuation: two or more spaces, then a non-whitespace char
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = list.ordered ? 'ol' : 'ul';
      const open = list.ordered && list.start !== 1 ? `<ol start="${list.start}">` : `<${tag}>`;
      const inner = [];
      for (const parts of items) inner.push(`<li>${inline(parts.join('\n'), env)}</li>\n`);
      blocks.push(`${open}\n${inner.join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
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
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const node = (kind, props) => ({ kind, text: '', path: null, name: '', body: null, then: null, else: null, not: false, ...props });
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push(node('text', { text: tok.text }));
    else if (tok.t === 'var' || tok.t === 'raw') body.push(node(tok.t, { path: tok.path }));
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const n = node('for', { name: m[1], path: pathOf(name, m[2]), body: [] });
        body.push(n);
        stack.push(n);
        body = n.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const n = node('if', { not: m[1] !== undefined, path: pathOf(name, m[2]), then: [] });
        body.push(n);
        stack.push(n);
        body = n.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push(node('include', { name: m[1] }));
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
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

/** Render `nodes` into `out` (an array of string pieces, joined by the caller). */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.ast.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------- template compiler

// Compile a parsed template body into a render function
// fn(sc, ctx, depth, out, tv, esc). The generated code inlines the scope
// lookup, textOf and truthy exactly as the interpreter does them, so the
// output is identical; only the per-node dispatch is gone. If compilation
// ever fails, run() falls back to the interpreter (renderNodes) for that
// template. All interpolated strings come from JSON.stringify of parser
// output (validated identifiers and literal text), never raw input.
function genLookupCode(path, sc, v) {
  let code = `let ${v};\n{ let _s = ${sc}; while (_s !== null && !Object.hasOwn(_s.vars, ${JSON.stringify(path[0])})) _s = _s.parent; ${v} = _s === null ? undefined : _s.vars[${JSON.stringify(path[0])}];`;
  for (let k = 1; k < path.length; k++) {
    const seg = JSON.stringify(path[k]);
    code += ` if (${v} !== null && typeof ${v} === "object" && Object.hasOwn(${v}, ${seg})) ${v} = ${v}[${seg}]; else ${v} = undefined;`;
  }
  code += ' }\n';
  return code;
}

const textOfCode = (v) => `(typeof ${v} === "string" ? ${v} : typeof ${v} === "number" ? String(${v}) : typeof ${v} === "boolean" ? (${v} ? "true" : "false") : Array.isArray(${v}) ? ${v}.map(tv).join(", ") : "")`;
const truthyCode = (v) => `(Array.isArray(${v}) ? ${v}.length > 0 : ${v} !== undefined && ${v} !== null && ${v} !== false && ${v} !== "" && ${v} !== 0)`;

function genNodesCode(nodes, sc, st) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      code += `out.push(${JSON.stringify(n.text)});\n`;
    } else if (n.kind === 'var' || n.kind === 'raw') {
      const v = `_v${st.uid++}`;
      code += genLookupCode(n.path, sc, v);
      code += n.kind === 'var' ? `out.push(esc(${textOfCode(v)}));\n` : `out.push(${textOfCode(v)});\n`;
    } else if (n.kind === 'if') {
      const v = `_v${st.uid++}`;
      code += genLookupCode(n.path, sc, v);
      const cond = truthyCode(v);
      if (n.not) {
        code += `if (!(${cond})) {\n${genNodesCode(n.then, sc, st)}} else {\n${n.else !== null ? genNodesCode(n.else, sc, st) : ''}}\n`;
      } else {
        code += `if (${cond}) {\n${genNodesCode(n.then, sc, st)}}${n.else !== null ? ` else {\n${genNodesCode(n.else, sc, st)}}` : ''}\n`;
      }
    } else if (n.kind === 'for') {
      const xs = `_x${st.uid++}`;
      const k = `_k${st.uid++}`;
      const sc2 = `_s${st.uid++}`;
      const v = `_v${st.uid++}`;
      code += genLookupCode(n.path, sc, v);
      code += `if (Array.isArray(${v})) { const ${xs} = ${v}; for (let ${k} = 0; ${k} < ${xs}.length; ${k}++) { const ${sc2} = { vars: { ${JSON.stringify(n.name)}: ${xs}[${k}], loop: { index: ${k} + 1, first: ${k} === 0, last: ${k} === ${xs}.length - 1, length: ${xs}.length } }, parent: ${sc} };\n${genNodesCode(n.body, sc2, st)} } }\n`;
    } else if (n.kind === 'include') {
      const f = `_f${st.uid++}`;
      const a = `_a${st.uid++}`;
      code += `{ const ${f} = ctx.templates.get(${JSON.stringify(n.name)}); if (${f} !== undefined && depth < ${INCLUDE_DEPTH}) ${f}(${sc}, ctx, depth + 1, out, tv, esc); else { const ${a} = ctx.ast.get(${JSON.stringify(n.name)}); if (${a} !== undefined && depth < ${INCLUDE_DEPTH}) ctx.rn(${a}, ${sc}, ctx, depth + 1, out); } }\n`;
    }
  }
  return code;
}

function compileTemplate(body) {
  const code = genNodesCode(body, 'sc', { uid: 0 });
  return new Function('sc', 'ctx', 'depth', 'out', 'tv', 'esc', code);
}

// Parsed + compiled templates, keyed by name and source: parsing and
// compiling are pure, so a template seen again (a repeated heat run, a
// second case sharing a template) reuses the same function. Parse failures
// are not cached: their messages name the template.
const TEMPLATE_CACHE = new Map();

// ---------------------------------------------------------------- the build

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

function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = fm.lines;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout) && !b.ast.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? b.slug(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, env, b.slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

function tags(b) {
  const bySlug = new Map();
  // A source's tags as [name, slug] pairs, each slug once, in its own order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = b.slug(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push([name, slug]);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

function cardOf(s) {
  const rm = s.readingMinutes ?? (s.readingMinutes = Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart) / 200)));
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: rm,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, b) {
  const base = s.post ? b.cards.get(s) : undefined;
  const c = base !== undefined ? { ...base } : cardOf(s);
  c.slug = s.slug;
  c.content = s.html;
  c.toc = s.toc;
  c.newer = linkOf(s.newer ?? null);
  c.older = linkOf(s.older ?? null);
  c.is_post = s.post;
  return c;
}

function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates: b.templates, ast: b.ast, escape: escapeHtml, rn: renderNodes };
  const render = (name, vars) => {
    const scope = { vars, parent: rootScope };
    const fn = b.templates.get(name);
    const out = [];
    if (fn !== undefined) {
      fn(scope, ctx, 0, out, textOf, escapeHtml);
      return out.join('');
    }
    const nodes = b.ast.get(name);
    if (nodes === undefined) return null;
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, b) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

const PIPELINE = [readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report];

/** One site's output tree: path -> text. */
export function run(input) {
  const ast = new Map();
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    const src = input.templates[name];
    const hit = TEMPLATE_CACHE.get(`${name}\0${src}`);
    if (hit !== undefined) {
      ast.set(name, hit.ast);
      if (hit.fn !== null) templates.set(name, hit.fn);
      continue;
    }
    try {
      const body = parseTemplate(name, src);
      ast.set(name, body);
      let fn = null;
      try {
        fn = compileTemplate(body);
      } catch {
        // Compiled form unavailable: the interpreter (renderNodes) renders it.
      }
      if (fn !== null) templates.set(name, fn);
      TEMPLATE_CACHE.set(`${name}\0${src}`, { ast: body, fn });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  // Per-case slug cache: tag names and titles repeat within a case; slugify
  // is pure, so the cache lives across cases and runs.
  const slug = (text) => {
    let v = SLUG_CACHE.get(text);
    if (v === undefined) {
      v = slugify(text);
      SLUG_CACHE.set(text, v);
    }
    return v;
  };
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    ast,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slug,
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}
