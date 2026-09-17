# Short cut: "Building your coding harness" in 10–15 minutes

This deck is a trimmed version of `../building-your-coding-harness/` (~50 slides, 30–40 min).
Everything in `BUILD-GUIDE.md` still applies (hard rules, theme, step engine, visual QA).

## Audience change

People who use AI coding agents every day, at an event sponsored by Devin/Cognition with speakers from
Vercel and Cloudflare. They know what an agent loop, tool calls and context windows are. **Don't explain
the basics twice. Let the diagrams do the work, and keep the captions short.**

## New structure (22 slides, target ≈ 14–15 min)

| # | Part file | Slide | Budget | Notes on the cut |
|---|-----------|-------|--------|------------------|
| 1 | 00-intro | `title` | 0:20 | |
| 1b | 00-intro | `hands` | 0:30 | re-added with 4 questions: agents → shared skills → scripts/hooks/MCPs → modified harness (expected %s in notes only) |
| 2 | 00-intro | `agenda` | 0:25 | extensions now in order speedometer → checklist → context-prune (observe → add tools → rewrite context) |
| 3 | 10-harness | `hn-loop` | 1:45 | first content slide. Absorbs `hn-model` ("the model is a text function; the harness runs the loop") |
| 4 | 10-harness | `hn-same` | 0:45 | absorbs `hn-bridge` ("built to be bent / no fork") |
| 5 | 20-lifecycle | `lc-divider` | 0:10 | holds shared lc CSS + `window.LC`, so it must stay |
| 6 | 20-lifecycle | `lc-loop` | 1:30 | THE hooks explanation. Absorbs `lc-catalogue` (36 events, 14 can change the outcome) and `lc-chain` (observe vs intervene, handlers chain) in one line or in the notes |
| 7 | 20-lifecycle | `lc-extension` | 0:35 | now comes after lc-loop. Absorbs `lc-bridge`: ends by pointing at the 3 extensions |
| 8 | 30-speedometer | `sp-divider` | 0:10 | now extension 1 of 3. Absorbs `sp-numbers` (TTFT vs TPS) |
| 9 | 30-speedometer | `sp-sim` | 0:50 | |
| 10 | 30-speedometer | `sp-code` | 0:40 | absorbs `sp-takeaway` (every hook returns undefined: pure observation) |
| 11 | 40-checklist | `ck-divider` | 0:10 | now extension 2 of 3. Absorbs `ck-why` in one line |
| 12 | 40-checklist | `ck-walk` | 1:00 | |
| 13 | 40-checklist | `ck-code` | 0:45 | absorbs `ck-tree` + `ck-takeaway` (state lives in the session and is rebuilt from getBranch) |
| 14 | 50-context-prune | `cp-divider` | 0:10 | now extension 3 of 3, "the most involved" one. Holds shared cp CSS + `window.CP` |
| 15 | 50-context-prune | `cp-problem` | 0:40 | |
| 16 | 50-context-prune | `cp-hooks` | 0:50 | absorbs `cp-idea` (summarise, index, recover) |
| 17 | 50-context-prune | `cp-walk` | 1:30 | |
| 18 | 50-context-prune | `cp-recover` | 0:30 | |
| 19 | 50-context-prune | `cp-code` | 0:40 | absorbs `cp-takeaway`. Modes and edge cases go in the notes only |
| 20 | 90-outro | `out-zero` | 0:40 | the `tool_call` block demo lives here now |
| 21 | 90-outro | `out-thanks` | Q&A | install lines in the new order |

Dropped: `hn-divider`, `hn-model`, `hn-anatomy`, `hn-bridge`, `lc-run`, `lc-chain`, `lc-block`,
`lc-redact`, `lc-sysprompt`, `lc-catalogue`, `lc-why`, `lc-bridge`, `sp-numbers`, `sp-events`, `sp-takeaway`,
`ck-why`, `ck-map`, `ck-tree`, `ck-takeaway`, `cp-idea`, `cp-modes`, `cp-edges`, `cp-takeaway`, `out-divider`,
`out-ideas`, `out-meta`.

## Editing rules for the short cut

- Keep the animations, illustrations and click-throughs. Only merge or remove steps where they re-explain
  something the audience already saw on an earlier slide.
- Speaker notes: start each slide's notes with its time budget, e.g. `[~0:45]`. Keep only what the speaker needs
  to say in that time. Remove references to dropped slides ("as we saw in the catalogue", "previous section's
  anatomy"), stale ordering ("third and final", "after context-prune") and old section numbers.
- Divider `.num` labels: `02 / Pi's lifecycle`, `03 / pi-speedometer`, `04 / pi-checklist`, `05 / pi-context-prune`.
  There is no 01 divider: `hn-loop` follows the agenda directly.
- Accuracy rules are unchanged: everything must still match `research/*.md`.
