# SPEC.md — what `solve.js` implements

A short statement of the dialect `run(input)` reproduces, byte for byte.
The full rules are makefun-site 1.0.0's README; its code is the reference
wherever the two differ.

## Input and output

Input: `{ site: { title, base_url, per_page, recent }, templates: { <name>:
<source> }, files: [{ path, content }] }`.

Output: a JSON object, each output path (relative, `/`-separated) to the
text of that file — each page's `index.html`, the index and tag pages,
`build-report.txt` and each static file.

## The build, in order

1. **Sources.** Files sorted by path in code-unit order. A file ending in
   `.md` is a source, its `\r\n` and lone `\r` made `\n`; any other file is
   static.
2. **Templates.** Every template parsed, in code-unit order of its name. One
   that does not parse is reported (`template "<name>": <reason>`) and left
   out.
3. **Front matter.** A source opens on the line `---` and its front matter
   runs to the next line exactly `---`. Every line between is blank, a
   comment (`#` first) or `key: value` (key of a–z and `_`, one space after
   the colon, trailing spaces/tabs dropped). Refusals, first reason met:
   `no front matter`, `the front matter is not closed`, `line <n> is not
   "key: value"`, `unknown key "<k>"`, `key "<k>" is given twice`,
   `key "<k>" has no value`, or the key's own reason; then `no title` for a
   source with no title. Keys: `title`, `summary` (quoted `"..."` with only
   `\"` and `\\` escapes, or bare); `date` (`YYYY-MM-DD`, a real day
   1970-01-01 to 2099-12-31); `tags` (`[a, b]`, each trimmed, none empty or
   holding `"`, `[`, `]`); `draft` (`true`/`false`); `layout` (a template
   name, a–z 0–9 `-`); `slug` (a–z 0–9, single `-` between, at most 64
   characters). A refused source is reported (`refused <path>: <reason>`)
   and dropped; so is a source under `tags/` or `page/`, a post under
   `posts/` with no date, and a source whose layout is no template that
   parses. A source with `draft: true` is reported (`draft <path>`) and
   dropped. The checks run in that order.
4. **Permalinks.** A post's directory is `posts/`; a page's is its source's
   directory. Its slug is its `slug` key, or the slug of its title, made
   unique in its directory in source order (`s`, `s-2`, `s-3`, …). At the
   root, `posts`, `tags` and `page` are taken from the start. Written to
   `<directory>/<slug>/index.html`, url `<base>/<directory>/<slug>/`,
   where `<base>` is `site.base_url` with trailing slashes dropped.
5. **Markdown** (below), each source's body rendered to HTML, its links
   resolved.
6. **Collections.** Posts newest date first, equal dates by slug in
   code-unit order. Each post's `newer` is the one before it, `older` the
   one after (null at either end).
7. **Tags.** Each post's tags, each slug once (first spelling kept), in its
   own order. A tag is all the posts whose tags have its slug, named as
   first met walking the posts in collection order; url
   `<base>/tags/<slug>/`. Tags ordered by post count, most first, then by
   slug. A page's tags link to the tag of the same slug, or have url `""`
   where no post has that tag.
8. **Layouts.** Every page through its layout (its `layout` key, else
   `post` for a post and `page` for a page), with `page`. The index through
   `index`, `site.per_page` posts a page (`index.html`, then
   `page/2/index.html` and on, at least one even with no posts), with
   `posts` and `pager`. Each tag through `tag` at
   `tags/<slug>/index.html`, with `tag`; `tags/index.html` through `tags`.
   An index, tag or tags page whose template is missing is not written.
   Every template also sees `site`, `tags` and `recent`. Then each static
   file at its own path, unless a built page has that path (reported:
   `shadowed <path>: a built page has its path`).
9. **The report**, `build-report.txt`: every line reported above and each
   broken link (`broken-link <source> -> <target>`, each once), sorted in
   code-unit order, then
   `built <n> pages, <n> posts, <n> tags and <n> static files`, every line
   ending in `\n`.

## What templates see

- `site`: `title`, `base_url` (`<base>`).
- `tags`: every tag, each `name`, `slug`, `url`, `count`.
- `recent`: the first `site.recent` posts, as cards.
- A card: `title`, `url`, `date` (the string, or `""`), `date_long`,
  `summary` (its `summary` key, or `""`), `excerpt` (the HTML of its
  body's first paragraph, or `""`), `reading_minutes` (the body's words,
  runs of characters other than whitespace, over 200, rounded up, at
  least 1) and `tags` (each `name`, `slug`, `url`).
- `page`: a card of the page, and `slug`, `content` (its body's HTML),
  `toc` (each level 2 and 3 heading: `level`, `id`, `html`), `newer` and
  `older` (each `title`, `url`, `date`, `date_long`, or null; null for a
  page) and `is_post`.
- On an index page, `posts` and `pager`: `number`, `total`, `url`,
  `newer_url` and `older_url` (`""` where there is none). On a tag page,
  `tag`: `name`, `slug`, `url`, `count` and `posts` (its cards).

## Text

- HTML escaping replaces `&` `<` `>` `"` `'` with `&amp;` `&lt;` `&gt;`
  `&quot;` `&#39;`, and nothing else.
- A slug: the text in Unicode NFKD, its combining marks (`\p{M}`) dropped;
  A–Z lowered; each run of characters other than a–z and 0–9 one `-`, none
  at either end; cut to 64 characters, a `-` left at the cut dropped;
  `untitled` when nothing is left.
- `date_long`: the date in words from the string alone: `2026-11-09` is
  `9 November 2026`.

## Markdown

Blocks, read line by line: fenced code (three backticks, optional language
of A–Z a–z 0–9 `_` `+` `-`, then spaces/tabs only; body to a line of three
backticks or the end; `<pre><code class="language-<lang>">…</code></pre>`,
no class without a language), ATX headings 1–6 (`#`s, at least one space or
tab, then text; `<hN id="<id>">inline</hN>`, the id the slug of the heading's
text made unique in the page; no text, or 7+ `#`, is not a heading),
thematic breaks (`---` or `***`, then spaces/tabs only: `<hr>`),
blockquotes (lines opening on `>`, the `>` and one space dropped, then
trimmed, empties dropped; `<blockquote>\n<p>inline</p>\n</blockquote>`, or
`<blockquote>\n</blockquote>` when none is left), flat lists (`- `, `* `, or
digits and `. `; a line of two or more spaces then a non-space continues
the item; any other line ends the list; no nesting; an ordered list whose
first number is not 1 opens `<ol start="n">`), and paragraphs (any other
line and the lines after it up to a blank line, a fence, a heading or a
thematic break; each line trimmed of spaces and tabs at both ends, joined
by `\n`: `<p>inline</p>`). Blocks in order, each followed by `\n`.

Inline, left to right: `\` before one of `` \ ` * _ [ ] ( ) # + - . ! > ``
writes that character (escaped); any other `\` is itself. A backtick opens
a code span closed by the next backtick with at least one character
between (`<code>escaped</code>`; with no closer it is itself). `**` opens
strong, closed by the next `**` not escaped with at least one character
between; with no closer, `**` is itself. A single `*` opens emphasis,
closed by the next single `*` (one not beside another `*`) not escaped
with at least one character between; with no closer, `*` is itself. `_` is
always itself. `[text](target)`: the first `]` not escaped closes the text,
`(` must follow at once, the next `)` closes the target, which must not be
empty or hold whitespace; else `[` is itself
(`<a href="escaped href">inline text</a>`). Every other character is
written escaped. Raw HTML is text.

A link's href: a target with a scheme, opening on `/` or on `#`, is kept as
written. Any other is a path from the source's directory (`.` and `..`
steps, never above the root), with an optional `#` fragment: the url of the
page built from that source, or `<base>/<path>` of a static file, the
fragment after it. A target that names neither is reported as a broken link
and kept as written.

## Templates

- `{{ path }}` writes the value, escaped; `{{{ path }}}` writes it raw. A
  path is names joined by `.` (a–z, A–Z, 0–9 and `_`, from a letter or `_`),
  with spaces allowed inside the braces around it.
- `{% for x in path %}…{% endfor %}` renders its body for each element of
  an array (anything else renders nothing), with `x` bound to the element
  and `loop` to `index` (from 1), `first`, `last` and `length`.
- `{% if path %}…{% else %}…{% endif %}`, and `{% if not path %}`; the
  else is optional. Undefined, null, false, `""`, 0 and an empty array are
  false; anything else is true.
- `{% include "name" %}` renders the template `name` in the same scope; a
  missing one, or one nested more than 8 deep, renders nothing.
- A `{% %}` tag alone on its line (only spaces or tabs beside it) takes the
  whole line with it, its `\n` included. Text, `{{ }}` and `{{{ }}}` never do.
- A path's first name is read from the innermost loop that binds it (`loop`
  before the element), else from the page's values; each next name is an
  own property of the value so far, or the path is undefined. A value is
  written as: a string itself; a number in JavaScript's own digits; `true`
  or `false`; an array as its items written and joined by `, `; anything
  else as `""`.
- A template does not parse when a `{{`, `{{{` or `{%` is not closed, a
  path is not one, a tag is none of the above, or a for or if is not closed
  or closed out of order.
