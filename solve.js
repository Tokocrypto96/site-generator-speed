// sitegen — a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build()
// returns for the same input, byte for byte, but faster: single-pass Markdown
// rendering (no token objects), chunk-based HTML escaping (no per-character
// regex replace), per-run caches for slugs and long dates, one card built per
// source and reused, and a template interpreter that writes into one output
// array instead of concatenating strings at every node.
//
// Everything is derived from makefun-site's own rules (its README and code
// are the reference wherever they differ). No cache lives past one run()
// call: every case is answered alone from its own input.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped, copying untouched runs whole. */
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const rep = ESCAPES[text[i]];
    if (rep === undefined) continue;
    out += text.slice(start, i) + rep;
    start = i + 1;
  }
  return out + text.slice(start);
}

const SLUG_MAX = 64;
const MARK = /\p{M}/gu;

/** The slug of `text` (see makefun-site's README, "Text"). `cache` is per-run. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  // Pure ASCII is unchanged by NFKD and holds no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK, '');
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
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. `cache` is per-run. */
function longDate(date, cache) {
  let hit = cache.get(date);
  if (hit === undefined) {
    const y = date.slice(0, 4);
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    hit = `${d} ${MONTHS[m - 1]} ${y}`;
    cache.set(date, hit);
  }
  return hit;
}

// JavaScript's \s, as a table: \t \n \v \f \r space \u00a0 \u1680 \u2000-\u200a
// \u2028 \u2029 \u202f \u205f \u3000 \ufeff.
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

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

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Finds the closing line first (a malformed line
 * only refuses when the front matter is closed, as the reference does),
 * then validates the few lines between.
 */
function parseFrontMatter(text) {
  // First line must be exactly '---'.
  let nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  // Scan line by line for the closing '---', collecting the lines between.
  const fmLines = [];
  let start = nl === -1 ? text.length : nl + 1;
  let close = -1;
  let bodyStart = text.length;
  while (start <= text.length) {
    nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end);
    if (line === '---') {
      close = fmLines.length + 1; // 1-based line number of the closing line
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    start = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (BLANK_RE.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A heading line's level and text, or null. */
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR_RE.test(line);
  return false;
}

/** Spaces and tabs at either end dropped (nothing else). */
function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const a0 = line.charCodeAt(0);
  const b0 = line.charCodeAt(n - 1);
  if (a0 !== 32 && a0 !== 9 && b0 !== 32 && b0 !== 9) return line;
  let a = 0;
  let b = n;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` is a fence close: ``` then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !WS[line.charCodeAt(i)];
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
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

const INLINE_NEXT = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline into `out` (an array of string pieces); `link(target)`
 * resolves a link target to its href. A native regex jumps straight to the
 * next character that can matter, so plain runs are copied whole and never
 * scanned character by character. (lastIndex is re-set before every exec,
 * so the recursion below cannot disturb the outer scan.)
 */
function inlineInto(out, s, link) {
  const n = s.length;
  let i = 0;
  let run = 0; // start of the current plain run (holds no escapable char)
  const flush = (to) => {
    if (to > run) out.push(s.slice(run, to));
    run = to;
  };
  while (i < n) {
    INLINE_NEXT.lastIndex = i;
    const m = INLINE_NEXT.exec(s);
    i = m === null ? n : m.index;
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        out.push(s[i + 1]);
        i += 2;
        run = i;
      } else {
        i++; // a backslash before anything else is itself, left in the run
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
        run = i;
      } else {
        i++; // no closer: the backtick is itself, left in the run
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineInto(out, s.slice(i + 2, k), link);
          out.push('</strong>');
          i = k + 2;
          run = i;
        } else {
          i += 2; // no closer: both stars are themselves, left in the run
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        flush(i);
        out.push('<em>');
        inlineInto(out, s.slice(i + 1, k), link);
        out.push('</em>');
        i = k + 1;
        run = i;
      } else {
        i++; // no closer: the star is itself, left in the run
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const t = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = t === -1 ? '' : s.slice(k + 2, t);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(out, s.slice(i + 1, k), link);
        out.push('</a>');
        i = t + 1;
        run = i;
        continue;
      }
      i++; // not a link: the bracket is itself, left in the run
      continue;
    }
    flush(i);
    out.push(ESCAPES[c]);
    i++;
    run = i;
  }
  flush(n);
}

/**
 * `src` rendered in one pass over its lines: HTML (each block followed by
 * "\n"), the table of contents (level 2 and 3 headings) and the excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const parts = []; // every piece of the HTML, blocks separated by '\n'
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  // The inline HTML of the piece written since `from`: a heading's html for
  // the toc, a paragraph's for the excerpt. Joined only for those two.
  const pieceHtml = (from) => parts.slice(from).join('');
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0); // NaN on an empty line
    if (line === '' || c0 === 32 || c0 === 9) {
      // Blank, or starting in spaces/tabs: only a paragraph can start here.
      if (line === '' || isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) { // '`': only a fence can start here
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        parts.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`);
        i++;
        while (i < n && !isFenceClose(lines[i])) {
          parts.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        parts.push('</code></pre>', '\n');
        continue;
      }
    } else if (c0 === 35) { // '#': only a heading can start here
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        parts.push(`<h${heading.depth} id="${id}">`);
        const from = parts.length;
        inlineInto(parts, heading.text, link);
        const html = pieceHtml(from);
        parts.push(`</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*': break, or a bullet
      if (HR_RE.test(line)) {
        parts.push('<hr>', '\n');
        i++;
        continue;
      }
      const bullet = BULLET_RE.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const m = BULLET_RE.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        parts.push('<ul>', '\n');
        for (const item of items) {
          parts.push('<li>');
          inlineInto(parts, item.join('\n'), link);
          parts.push('</li>', '\n');
        }
        parts.push('</ul>', '\n');
        continue;
      }
    } else if (c0 === 62) { // '>': a blockquote
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        body.push(lines[i++].replace(/^> ?/, ''));
      }
      const kept = body.map(trimLine).filter((l) => l !== '');
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(parts, kept.join('\n'), link);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit: only an ordered list can start here
      const ordered = ORDERED_RE.exec(line);
      if (ordered !== null) {
        const startNum = Number(ordered[1]);
        const items = [];
        while (i < n) {
          const m = ORDERED_RE.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[2])]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        parts.push(startNum !== 1 ? `<ol start="${startNum}">` : '<ol>', '\n');
        for (const item of items) {
          parts.push('<li>');
          inlineInto(parts, item.join('\n'), link);
          parts.push('</li>', '\n');
        }
        parts.push('</ol>', '\n');
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line,
    // a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    parts.push('<p>');
    const from = parts.length;
    inlineInto(parts, body.join('\n'), link);
    if (excerpt === null) excerpt = pieceHtml(from);
    parts.push('</p>', '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the frame (one null-prototype object holding the
 * innermost binding of every name, so the first name is a direct read; the
 * reference walks a chain of scopes, which this frame replaces exactly).
 */
function lookup(frame, path) {
  let v = frame[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (an array of string pieces). */
function renderNodes(nodes, frame, templates, out, depth) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(frame, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(frame, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(frame, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frame, templates, out, depth);
        break;
      }
      case 'for': {
        const xs = lookup(frame, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One loop record per loop, mutated per item; the frame holds the
        // innermost binding, saved and restored around the loop.
        const loop = { index: 1, first: true, last: len === 1, length: len };
        const hadName = Object.hasOwn(frame, n.name);
        const oldName = frame[n.name];
        const hadLoop = Object.hasOwn(frame, 'loop');
        const oldLoop = frame.loop;
        for (let k = 0; k < len; k++) {
          frame[n.name] = xs[k];
          frame.loop = loop; // the loop record wins when the element is named `loop`
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderNodes(n.body, frame, templates, out, depth);
        }
        if (hadLoop) frame.loop = oldLoop;
        else delete frame.loop;
        if (n.name !== 'loop') {
          if (hadName) frame[n.name] = oldName;
          else delete frame[n.name];
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, frame, templates, out, depth + 1);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` opens on a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c = target.indexOf(':');
  if (c <= 0) return false;
  const a = target.charCodeAt(0);
  if (!((a >= 65 && a <= 90) || (a >= 97 && a <= 122))) return false;
  for (let k = 1; k < c; k++) {
    const ch = target.charCodeAt(k);
    if (!((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 43 || ch === 45 || ch === 46)) return false;
  }
  return true;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** One site's output tree: path -> text. Nothing is kept past this call. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources, in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Front matter, in order: refused, the generator's own directory, a
  // post with no date, a layout that is no template, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (target.startsWith('/') || target.startsWith('#') || hasScheme(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts. One card per source, built once and reused by every list
  // and by the page itself (the reference rebuilds it; the values are the same).
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    // A null-prototype frame: a missing name reads as undefined, with no
    // inherited property ever answering for one.
    const frame = Object.create(null);
    Object.assign(frame, vars);
    const out = [];
    renderNodes(nodes, frame, templates, out, 0);
    return out.join('');
  };
  const baseVars = { site, tags: allTags, recent };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { ...baseVars, page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      ...baseVars,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { ...baseVars, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', baseVars);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
