# BUILD_NOTES — markdown-render-speed-02

Entry for the make.fun bounty **"Make Markdown rendering faster"**
(slug `markdown-render-speed-02`, $250, escrowed). Deadline **Mon 16 Nov
2026 20:30 UTC = Tue 17 Nov 2026 03:30 WIB**.

Goal: `parse.js`, a dependency-free ES module whose `parse(markdown)`
returns byte-identical HTML to **marked 18.1.3** (default options) on
every case, faster than marked itself. `main.ts` is the driver the
harness runs (`node /bot/main.ts` on Node 22, erasable TS only).

## Files in this repository

| File | Size | Role |
| --- | --- | --- |
| `parse.js` | ~114 KB | The parser. Original hand-written implementation (no marked source copied). |
| `main.ts` | ~1.1 KB | Driver: reads `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders each case with `parse()`, writes `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`). |
| `BUILD_NOTES.md` | this file | Design, fixes, results, how to run the checks. |

Total repo size is well under the 1 MiB cap. No LICENSE is added here
yet — add an OSI-approved LICENSE before submitting (the kit's `check`
verifies it). The GitHub repo / submit step is **not** done by this
session (per the task: do not create the repo, upload, or submit).

## Parser design

`parse.js` is a single-file, dependency-free parser written from the
CommonMark/GFM behaviour as marked 18.1.3 implements it (marked's
vendored source in the kit was read only as a reference for the exact
semantics; no marked source was copied into `parse.js`).

- **Block layer** (`parseBlocks`): ATX/setext headings, fenced and
  indented code, block quotes, bullet/ordered/task lists, tables,
  thematic breaks, HTML blocks (7 terminator types), link reference
  definitions, paragraphs with lazy continuation. Link reference
  definitions are collected into a `refs` Map keyed by
  `normalizeLabel` (trim, collapse whitespace, Unicode case-fold).
- **Inline layer** (`scanInline`): a single left-to-right scan that
  dispatches on the character code — backslash escapes, hard breaks,
  `<` (HTML tags / autolinks), backticks (code spans), `[`/`!` (links
  and images, inline / reference / collapsed / shortcut), `*`/`_`/`~`
  (emphasis / strong / strikethrough via `findEm`/`findDel`), extended
  autolinks (`www.` / scheme URLs, email), entities, and plain text
  (escaped and entity-decoded on flush).
- **Delimiter handling** mirrors marked's `emStrong`/`del`: left/right
  flanking computed from the characters around a run (`flanking`,
  `classifyDelim`), the rule-of-3 accounting (`m`/`f`/`y`/`R`/`o`),
  and the "last possible closer" limit. `_` delimiters additionally
  require punctuation on both sides for a both-flanking run and reject
  an opener followed by an alphanumeric.
- **Emphasis masking** (the subtle part, see Fix 3b below): before the
  closer scan, marked builds a `#n` mask of the inline slice in which
  code spans, links, HTML and escapes are hidden, and reads the
  flanking characters from that mask. `parse.js` reproduces it with
  `computeMask` (three passes, length-preserving so positions map 1:1).

## Failure patterns found and fixed (705/720 -> 720/720)

All 15 initial failures were in the long generated README documents
(doc-08, 09, 12, 15, 16, 19, 20, 22, 23, 24, 28, 33, 35, 36, 37).

### Fix 1 — extended-autolink backpedal (705 -> 709)
`backpedal()` was replaced with a faithful implementation of marked's
`_backpedal` regex (parenthesis groups, trailing-punctuation fixpoint,
`&`-entity rule). `matchExtUrl` now stops at any whitespace or `<`, and
the `www.` previous-character check uses `isWsCh`. Fixed doc-08, 12,
36, 37 (URLs such as `https://sub.domain.example.io)%5D...` where the
closing paren/bracket was misplaced).

### Fix 2 — HTML-block trailing newline (709 -> 713)
Added `geStrip()` (marked's `ge()`: strip trailing blank lines only
when there are >= 2) and reworked `matchHtmlBlock` so terminator types
1–5 (script/pre/style/textarea, comment, `<?`, `<!Letter`,
`<![CDATA[`) get the `ge()` treatment: a trailing `\n` is kept when
followed by a tab/spaces-only line and dropped after an empty line;
type 6 (block tag until blank line) is unchanged. Fixed doc-15, 19, 22,
24 (marked emits a newline before the closing `-->` of an HTML block;
the parser did not).

### Fix 3a — `findLabelEnd` backtracking (713 -> 714)
Replaced the old loop with `matchLabelContent` (recursive DFS with a
`failed` memo) and `matchNestedBracket` (depth cap 2: outer label + one
nested bracket + one simple pair). At a backtick run the code-span
alternative is tried first (skip to after the next backtick run); if
that path fails, fall back to `` `` `` + `(?=\])` (2+ backticks
immediately before `]`). Verified against marked's label regex
directly, including the "huge label" and 3-level-nesting cases. Fixed
doc-33.

### Fix 3b — emphasis masking (714 -> 719)
The big one. Implemented marked's `#n` masking as three passes over
the inline slice (length-preserving):
1. `maskReflinks` — reference-link matches masked to `[aaa...]` when
   the ref is defined (only if `refs.size > 0`); a reflink whose label
   contains a link is masked recursively, with only the ref part
   masked.
2. `maskCodeAndEscapes` — code span = opening run + content (not
   starting/ending with a backtick) + closing run of exactly the same
   length; keep the runs, inner backticks become `+`; bare runs
   unchanged; escapes (`\` + a Unicode punctuation/symbol) become
   `++` (astral-aware).
3. `maskBlockSkip` — link (`matchBlockSkipLink`: label = plain chars or
   code spans with matching-length closing run, no nesting/escapes;
   dest via `matchBlockSkipDest` with one level of parens), code span,
   or HTML (`<(?! )[ ^<>]*?>`) masked to `[aaa...]`.

`findEm`/`findDel` now scan the **mask** (the old `skipOpaque` in the
closer scan is gone); the char before the opener, and the closer's
`p2`/`n2`, come from the mask via `maskPrevChar`/`maskNextChar`;
`maskedRunEnd` runs on the mask; the opener back-up loop runs on the
mask clamped to the slice start. `scanInline` computes the mask lazily
per call via `ensureMask()` and passes it explicitly (recursive calls
for labels/emphasis content get their own mask).

**Precode fix (inside 3b):** step-3 code spans must not be preceded by
a backtick (`(?<!`)` / `(^|[^`])`). Without it a `` `` `` run was split
and its second backtick wrongly started a code span (doc-01:
`**faster will ``pull` note**...`). After this fix the check went
697 -> 719 (the mask initially regressed to 697 before the precode
fix).

The `fe()` last-possible-closer limit was deliberately **not**
implemented: `classifyDelim` already rejects runs preceded by
whitespace (they classify as opener/none), so it is redundant for
correctness.

### Fix 4 — `isFenceLike` list-item break (doc-19 para 104)
A line starting with 3+ backticks or tildes at indent <= 3 ends a list
item even when the info string is invalid (a backtick fence info
containing backticks is not a valid fence, so `matchFence` returns
null, but the line still cannot be a lazy continuation; it is then
parsed as a paragraph with a code span). Added `isFenceLike()` and
used it in `parseListItem`'s `breaks` check in place of
`matchFence(U)`. Verified: `` ```c``` ``, `` ```c d``` ``, `` ``` ``` ``,
```` ````c ```` all end the item in marked; 2-backtick lines do NOT;
tilde fences with tildes in info are valid fences and already worked.

### Fix 5 — mask bounded to the slice (719 -> 720)
The last failure was `~~browser inline example **or large &#xA9;**~~`
— the `<strong>` inside the `<del>` did not form. Debug showed
`findEm` for the `**` opener found the closer with `p2=";" n2="~"`,
classifying it as an opener. The `n2="~"` came from `maskNextChar`
reading past the slice end: when `computeMask` returned null,
`ensureMask` fell back to the full string with `maskOff = 0`, so the
char after the closer `**` was read as `~` (the del's closing `~~`)
instead of end-of-slice. Since `~` is NOT punctuation for `*`
delimiters, the closer classified as an opener. Fix: `computeMask`
now returns `null` when nothing needs masking, and `ensureMask` uses
the real string with `maskOff = 0` **plus** explicit slice bounds
(`sStart` passed to `findEm`/`findDel`; `maskPrevChar`/`maskNextChar`
take `lo`/`hi` bounds), so flanking is always read within the slice
only. This also avoids allocating a slice for the common
nothing-to-mask case.

## Final results

### Correctness — practice set (720 cases)
- `/tmp/check.mjs` (and `main.ts` run end-to-end): **PASS 720/720**,
  failure groups: none.
- Kit grade-local:
  `node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process --worktree`
  -> `scores {"cases_passed":720,"cases_total":720,"passed":1}`,
  `checks 720 of 720 points over 71 checks`, `L1 regrade reproduced
  byte for byte`, `result_sha256 9bdfc93acff1963b0c04fe3576910e283fcf529db1e1fcbc4c4d12553173a7d4`.
  (The `eligible ... prize no, efficiency no (no_transcripts,
  coverage_below_gate, cost_unpriced)` line is expected from
  grade-local: it reads no transcripts, so authorship/cost are 0. The
  sealed recording supplies them at submit time.)

### Speed — CPU time over the 720 practice cases
`/tmp/bench.mjs` (5 reps, `process.cpuUsage()`):

| run | mine | marked | speedup |
| --- | --- | --- | --- |
| 5-rep run 1 | 863.8 ms | 879.6 ms | 1.02x |
| 5-rep run 2 | 881.2 ms | 864.3 ms | 0.98x |
| 5-rep run 3 | 912.9 ms | 894.3 ms | 0.98x |
| 5-rep run 4 | 892.4 ms | 898.2 ms | 1.01x |
| 5-rep run 5 | 924.2 ms | 932.9 ms | 1.01x |

So **about 1.0x on this machine** — roughly at parity with marked,
not the ~1.2x measured at the start of the session (mine ~937 ms vs
marked ~1143 ms, 3 reps, before the masking work). The masking passes
cost roughly 7% (a bypass test with the mask passes removed measured
1.11x), and the remaining gap is machine contention: the bench host
was running a parallel CPU-bound chess-engine trial at ~90% CPU
(load average ~1.7 on a 1.5-CPU cell) while these numbers were taken,
which depresses both sides and adds run-to-run noise. On a quiet
single-CPU grader the ratio should read better, but it is **not**
comfortably above 1.0x here — the honest summary is: correctness gate
met (720/720), speed about even with marked on a loaded host. If more
speed work is done, the mask passes (`maskCodeAndEscapes`,
`maskBlockSkip`) are the place to look first; do not trade correctness
for it.

### Speed — optimization round (16 Nov 2026, ~08:40–08:52 WIB)

Target: ≥1.10x vs marked on `bench5.mjs`, still 720/720. All changes
were proven equivalent to the old behaviour from the code they guard
(each skip mirrors an early return the callee would have taken), and
`check.mjs` was re-run after every step (720/720 throughout, no
regressions to revert).

1. **Pre-checks before `ensureMask()`** (`scanInline`, `*`/`_` branch):
   run length + next char first — whitespace/end-of-slice means
   `findEm` returns null, so the mask is never built. When the run
   cannot back up (char before it is not the delimiter — the mask
   never introduces `*`/`_`), `findEm`'s `n` is exactly `effR()`:
   `_` after an alnum char can never open (both of `findEm`'s early
   returns fire for it — the `d!==''` one and the `_`-specific one),
   and next-char-punctuation with a non-punct, non-space prev fires
   the first early return. Same idea for `~` (`findDel`: run > 2,
   next ws/end/`~`, next punct + prev non-punct-non-space).
2. **Ext-URL dispatch** (`scanInline`): the email-local class test is
   inlined on the char code (no per-character function call + 1-char
   string allocation); a scheme 2nd-char filter (`http(s)`/`ftp`
   need `t`, `www.` needs lowercase `w`, `mailto:` needs `a`,
   `xmpp:` needs `m`) skips `matchExtUrl` calls that provably return
   null mid-word; the previous char is read with `charCodeAt`
   instead of `prevChar()` (only its email-local-ness matters for
   the word-boundary test, and a surrogate half is never
   email-local, exactly like the full char); a lazy per-slice
   `hasAt` flag (one `indexOf('@')` per `scanInline` call) skips the
   bare-email path entirely in slices with no `@`.
3. **`matchEmailAt`**: the local-part scan uses `charCodeAt` with
   code-based helpers (`isEmailLocalCode` / `isAutolinkLocalCode`)
   instead of a function call on a 1-char string per character.
4. **Mask passes**: per-pass guards in `computeMask`
   (`maskCodeAndEscapes` only when `` ` `` or `\` is present,
   `maskBlockSkip` only when `` ` ``, `[` or `<` is present), and
   `indexOf` jumps instead of per-character stepping in the
   code-span close search, the inner-backtick check (now
   `replaceAll('`', '+')`), the HTML end search, and
   `matchBlockSkipLink`'s code-span scan.
5. **Misc**: `clsOf` ASCII fast path (precomputed `Uint8Array[128]`,
   so hot ASCII punct/alnum checks skip the `Map` + regex);
   `flanking` no longer allocates a closure per call; `parse()`
   skips the `\r\n?` regex replace when the input has no `\r`;
   `findEm`/`findDel` closer scans jump to the next delimiter run
   with `indexOf` instead of stepping through the mask one char at
   a time.

The profile before this round put the mask passes at ~7% of samples,
`matchExtUrl` 2.9% and `matchEmailAt` 2.4%; after it, `maskReflinks`
fell to ~0.6%, `matchEmailAt` to ~1.4%, `matchExtUrl` to ~2.0%.

### Speed — results after the optimization round

Baseline for this round (bench5, load 1.05/1.38/1.07, 01:40 WIB):
mine 855.6 ms, marked 877.4 ms, **1.03x**.

Runs taken while the host was heavily loaded (load 2.0–7.1: a
parallel ollama install + chess trial) were noisy and are not used
for the conclusion: 1.03x, 1.01x, 1.07x, 1.04x, 1.12x, 1.06x, 1.05x,
1.04x.

Five consecutive runs once the host calmed down (load 1.25–1.35):

| run | mine | marked | speedup |
| --- | --- | --- | --- |
| 1 | 791.0 ms | 918.8 ms | 1.16x |
| 2 | 738.7 ms | 894.4 ms | 1.21x |
| 3 | 765.4 ms | 917.2 ms | 1.20x |
| 4 | 727.3 ms | 906.3 ms | 1.25x |
| 5 | 792.0 ms | 913.2 ms | 1.15x |

Median **~1.20x**, all five runs ≥1.15x — the ≥1.10x target is met
with margin on this host. Note the jump appeared together with the
round-4 change (the `hasAt`/dispatch work, the largest single
contributor) and with the load falling from ~3–7 to ~1.3, so the
before/after comparison is not perfectly clean; the five-run series
at stable load is the number to trust. Correctness after the round:
`check.mjs` **720/720**, kit grade-local `cases_passed 720/720`,
`checks 720 of 720 points over 71 checks`, `L1 regrade reproduced
byte for byte`, `result_sha256
90654c46b8ccc1d159525614bb1a103dc6f0462a8228deb5222b257bc2ad2a7b`.
`parse.js` is now 114,475 bytes (was 110,037); `main.ts` untouched.

## How to run the checks

The check/bench scripts live in `/tmp` in this session (recreated
after a `/tmp` wipe) and are also saved under
`~/workspace/makefun/markdown-render-speed-02-local/`:

- `node /tmp/check.mjs` (or `...-local/check.mjs`) — renders all 720
  practice cases with `parse.js` and compares byte-for-byte with
  `practice/reference/expected.json`. Prints `PASS x/720`, failure
  groups, and first-diff contexts for the first 5 failures.
- `node /tmp/bench.mjs` (or `...-local/bench.mjs`) — CPU time via
  `process.cpuUsage()`, 3 reps over the 720 cases, prints
  `mine: X ms, marked: Y ms, speedup: Zx`. `bench5.mjs` is the same
  with 5 reps.
- `node main.ts` with `MAKEFUN_INPUT_DIR=<kit>/practice/input` and
  `MAKEFUN_OUTPUT_DIR=<dir>` — runs the real driver and writes
  `html.json` (verified 720/720 against the reference).
- Kit grade-local (from the kit directory):
  `node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process --worktree`
  (Docker is not available here, so `--driver process`; `--worktree`
  grades the files as they are, since the repo has no commit yet).

## Notes / caveats

- Node here is v24.22.1; the grader uses Node 22.23.4. `main.ts` uses
  erasable TypeScript syntax only (type annotations, `??`, no enums /
  namespaces / parameter properties), so Node 22 strips it natively.
- `parse.js` keeps nothing between calls (no memo/cache across
  cases), reads no files, clock, or environment, and is deterministic
  — both graded executions produce identical output.
- The 40 generated documents are 20–110 KB each; the whole 720-case
  set renders in ~0.9 s of CPU here, well inside the 20 s wall budget.
- Do **not** copy marked's source into this repo. The masking scanners
  are hand-written to mirror the regex semantics, not copied literals.
