[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Tokocrypto96/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Tokocrypto96/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# sitegen — a fast drop-in for makefun-site 1.0.0

`run(input)` returns exactly the output tree makefun-site 1.0.0's `build()`
returns for the same input — every page's `index.html`, the index and tag
pages, `build-report.txt` and each static file, byte for byte — but faster.
It is the entry for make.fun's
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
competition ("Build a static site faster").

## Layout

- `solve.js` — the generator. A dependency-free ES module exporting
  `run(input)`. No network, no clock, no randomness, no environment: the
  output is a function of the input alone, and two runs on the same input
  are byte-identical.
- `main.ts` — the driver the harness runs (`node /bot/main.ts`). It reads
  every case from `/input/cases.json`, answers each one alone with `run`,
  and writes `/output/answers.json`. (`MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output` outside a
  container.) It turns V8's incremental marking off before importing
  `solve.js`, as the house baseline does.
- `SPEC.md` — what the generator implements, in short.

## How it is faster

The reference (`makefun-site` 1.0.0) is a pipeline of plugins over a
lex-then-render Markdown engine and a template interpreter that
concatenates strings node by node. This entry keeps every rule and every
output of the reference and removes the repeated work:

- **Markdown in one pass.** Bodies are rendered straight from their lines
  into one output array — no token objects, no second render walk, no join
  per paragraph. Inline rendering jumps with one native regex to the next
  character that can matter, so plain runs are copied whole instead of
  being escaped character by character.
- **Escaping in runs.** `escapeHtml` first tests for a special character
  and returns untouched text as-is; otherwise it copies untouched runs
  whole.
- **Per-run caches, never across cases.** Slugs and long dates are cached
  in maps that live and die inside one `run()` call — every case is
  answered alone from its own input.
- **One card per source.** The reference rebuilds a page's card (including
  its word count) every time the page is listed; this entry builds it once
  and reuses the same values everywhere.
- **A flat template frame.** Template scopes are one null-prototype object
  holding the innermost binding of every name (saved and restored around
  `for` loops), so a path lookup is a direct read instead of a walk down a
  chain of scope objects. Template output is written into one array and
  joined once per render.
- **Cheap line tests.** Block dispatch reads the first character before
  any regex runs, and paragraph continuation checks are prefix checks with
  a regex only on candidate lines.

## Correctness

Checked against makefun-site 1.0.0 itself, not against the README alone
(the code is the reference wherever the two differ):

- **Practice set: 3/3 cases byte-identical** to
  `practice/reference/expected.json`.
- **Fresh draws: 30/30 cases byte-identical** — ten instances drawn from
  new seeds with the kit's own generator (`program/generator/draw.ts`),
  each compared against the oracle's expected output.

## Speed (local, Node v24.22.1, this VM)

CPU time of `run()` over the 3 practice cases, median of 9 interleaved
runs, measured with `process.cpuUsage()`:

| | CPU time |
|---|---:|
| makefun-site 1.0.0 (house baseline) | ~1,216 ms |
| this entry | ~343 ms |
| **speedup** | **~3.5×** |

Full process (read + parse `cases.json`, run all cases, write
`answers.json`): baseline ~1,525 ms median, this entry ~711 ms median.
Local numbers only compare with the baseline measured beside them on the
same machine; the scored heat runs on the grader's machine.

## License

MIT. See `LICENSE`.
