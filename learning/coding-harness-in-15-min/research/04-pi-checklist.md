# 04 — pi-checklist: a task list the agent keeps for itself

Source (authoritative): `/Users/championswimmer/Development/Personal/LLM/pi-checklist` @ `68332e2` (v0.3.1, npm `pi-checklist`).
Pi API checked against the installed `@earendil-works/pi-coding-agent` (`docs/extensions.md`, `docs/session-format.md`, `dist/core/extensions/types.d.ts`, `dist/core/session-manager.js`).
All `file:line` refs are `src/…` in the pi-checklist repo unless noted. Error strings and widget output below came from running the real `dist/store.js` / `dist/render.js` in node, not from memory.

---

## 1. What it does, and why

**One-line pitch:** *Three tools, one hook, and the session file as the database. The agent gets a to-do list it can't lose track of.*

The extension gives the model a **session-scoped checklist**: it writes down its plan as tasks, moves each task through `planned → ongoing → done/cancelled`, and can say which tasks depend on others. The human sees the list live in the TUI (a widget plus a `☑ 1/4` footer).

Why a todo list helps an agent:

- **Planning before acting.** `checklist_create` makes the model break "add rate limiting" into concrete steps before it touches code, and the tool's guidelines say to do it "at the start of multi-step work" (`tools.ts:75`).
- **Staying on track.** On every user prompt the open tasks are re-injected into the system prompt (`index.ts:307-323`). After compaction, or 40 tool calls deep, the model still sees "stg ongoing; mid blocked ← stg".
- **Guard rails, not just notes.** Dependencies are enforced. The model can't mark a task started or done while its prerequisites are unfinished. It gets a tool error it can read and fix (`store.ts:394-401`).
- **Visible progress for the human.** Widget, footer and `/checklist` popup show what's done, in progress, ready and blocked. You don't have to scroll the transcript.
- **Survives the session tree.** State is stored as entries in pi's session JSONL, so `/resume`, `/tree`, `/fork` and compaction all put back the right list for that point in the conversation.

It's a small working list for the agent and the human watching it, not a project-management app (`AGENTS.md`).

---

## 2. Every hook and API used

### 2.1 Entry point
`index.ts:56`: `export default function (pi: ExtensionAPI) { … }`. The factory loads global display prefs (`index.ts:61`, `prefs.ts`), keeps an in-memory `state: ChecklistSnapshot` cache (`index.ts:62-70`), then registers everything below. `package.json` sets `"pi": { "extensions": ["./dist/index.js"] }` and `keywords: ["pi-package"]`.

### 2.2 Tools: `pi.registerTool` ×3

| Tool | Registered | Schema | description (sent to the model) |
|---|---|---|---|
| `checklist_create` | `index.ts:179-200` | `tools.ts:27-41` | "Create or extend the session task checklist (replace by default, or append). Returns 3-char task ids. Send an empty tasks array to clear the checklist for the next set of tasks." |
| `checklist_read` | `index.ts:202-215` | `tools.ts:43-50` | "Read the session task checklist with ready/blocked status per task." |
| `checklist_update` | `index.ts:217-238` | `tools.ts:52-67` | "Advance session checklist tasks (all-or-nothing): move status, retitle, edit notes/dependsOn." |

Each registration has `name`, `label`, `description`, `promptSnippet`, `promptGuidelines`, `parameters` (TypeBox), `execute`, `renderCall`, `renderResult`.

**Parameter schemas** (TypeBox + `StringEnum` from `@earendil-works/pi-ai`):

- `checklist_create` (`tools.ts:27-41`)
  - `title?: string`: "Optional session/goal name shown in the widget header"
  - `mode?: "replace" | "append"`: "replace (default) wipes the list; append adds to it"
  - `tasks: Array<{ id?: string; title: string; notes?: string; dependsOn?: string | string[] }>`
    - `id`: "Optional explicit 3-char id (e.g. "k7q") for same-batch DAGs"
    - `dependsOn` (shared, `tools.ts:21-25`): "3-char task ids that must be done first (single id or array)". It accepts a string or an array because models send both.
    - array description: "…An empty array with mode replace clears the checklist…"
- `checklist_read` (`tools.ts:43-50`): `status?: planned|ongoing|done|cancelled` (filter), `includeDone?: boolean` (default true)
- `checklist_update` (`tools.ts:52-67`): `updates: Array<{ id: string; status?; title?; notes?; dependsOn? }>`, described as "All-or-nothing batch of updates". `status` description: "Move through planned → ongoing → done/cancelled (done is terminal)".

**Prompt metadata** (`tools.ts:73-89`). `promptSnippet` adds a one-line entry under "Available tools". `promptGuidelines` bullets are appended flat to the system prompt's Guidelines section (pi docs `extensions.md:1373-1375`, which also says each bullet must name the tool, never "this tool"):

```
CREATE_SNIPPET  = "Create or replace the session task checklist."
 - Use checklist_create at the start of multi-step work; use mode replace when the plan changes substantially and mode append when new work appears mid-session.
 - checklist_create task ids are exactly 3 lowercase alphanumeric chars: omit id unless you need a same-batch DAG, then pass explicit 3-char ids. Always copy the returned ids; never invent them.
READ_SNIPPET    = "Read the session task checklist."
 - Use checklist_read after compaction or whenever unsure of task ids, statuses, or what is blocked.
UPDATE_SNIPPET  = "Advance tasks through the session checklist."
 - Use checklist_update to mark a task ongoing before starting work and done as soon as the work is actually done; cancel tasks the new plan made irrelevant.
 - checklist_update cannot start a task whose blockedBy is non-empty: finish every dependsOn task first. Keep at most one ongoing task (or a tight parallel set).
 - checklist_update transitions: planned → ongoing/done/cancelled, ongoing → done/cancelled/planned, cancelled → planned. done is terminal and frozen.
```

**execute contract** (`index.ts:186-197`, `224-235`): run a pure store function, `commit()` the new snapshot, then return `{ content: [{type:"text", text}], details: snapshot }`. `content` is what the LLM reads. `details` is structured data that isn't sent to the LLM but is saved on the tool-result entry, and it's what the renderer and reconstruction use. **Errors are thrown** from the store (e.g. `store.ts:398`). Pi turns a thrown error into `isError: true` and reports the message to the LLM (pi `extensions.md:2017`). The throw happens before `commit()`, so a failed call persists nothing and leaves state unchanged.

### 2.3 Custom renderers: `renderCall` / `renderResult` (`render.ts:320-361`)
- `renderCreateCall` (`render.ts:320-323`): bold `checklist create ` + muted `4 task(s)`
- `renderReadCall` (`render.ts:325-327`): bold `checklist `
- `renderUpdateCall` (`render.ts:329-336`): bold `checklist ` + accent list of ids, e.g. `stg, mid`
- `renderChecklistResult` (`render.ts:338-361`), shared by all three tools. It reads `result.details` (the snapshot). Collapsed it shows one line, `0/4 done  1 ongoing  0 ready  3 blocked`. Expanded it adds up to 10 sorted rows with pill, glyph, id, title and `← blockedBy`. If there's no snapshot (e.g. an error) it falls back to the first line of `content` in dim text (`render.ts:346-348`).

### 2.4 Command: `pi.registerCommand("checklist", …)` (`commands.ts:300-385`)
- `/checklist` or `/checklist show` opens a centred overlay via `ctx.ui.custom(factory, { overlay: true, overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" } })` (`commands.ts:150-159`). The component is `ChecklistOverlay` (`render.ts:372-454`): j/k or arrow keys to move, Esc/q to close, rounded `╭─╮` frame drawn by `frameDialog` (`render.ts:236-251`). In print mode it falls back to `ctx.ui.notify` (`commands.ts:130-143`).
- `/checklist hide` sets display mode to hidden.
- `/checklist clear` asks via `ctx.ui.confirm(…)` (`commands.ts:334`), then `deps.clear` appends a `checklist: null` snapshot (`index.ts:274-286`).
- `/checklist settings [display] [style] [icons] [usage]` opens a `SettingsList` screen with live preview, or quick-sets values inline. Tab completion comes from `getArgumentCompletions` (`commands.ts:303-315`).

### 2.5 Event handlers (`index.ts:292-323`)

| Event | Line | What it does |
|---|---|---|
| `session_start` | `index.ts:292` | `reconstruct(ctx)`: rebuild state from the current branch (startup, `/resume`, `/new`, `/fork`) |
| `session_tree` | `index.ts:293` | `reconstruct(ctx)` after `/tree` navigation moves the leaf |
| `turn_start` | `index.ts:294-297` | `inTurn = true`; refresh UI (in `end-of-turn` mode the widget hides mid-turn) |
| `turn_end` | `index.ts:298-301` | `inTurn = false`; refresh UI |
| `agent_settled` | `index.ts:302-305` | `inTurn = false`; refresh UI (pi will not auto-continue) |
| `before_agent_start` | `index.ts:307-323` | returns `{ systemPrompt }` with the usage hint and a live snapshot of open tasks appended |

**`before_agent_start` injection.** It fires once per user prompt, before the agent loop. The return type is `BeforeAgentStartEventResult { message?; systemPrompt? }` (pi `types.d.ts:845-849`), and system-prompt changes chain across extensions. The injected text is:

- Hint, moderate (default) (`index.ts:315`):
  > Checklist available: for long-running or multi-step work (refactors, audits, multi-part features), track it with checklist_create/read/update and mark progress as you go. Skip it for quick one-shot questions.
- Hint, aggressive (`index.ts:314`):
  > Checklist expected: use checklist_create/read/update for almost every task, even small ones, and mark progress as you go. Only skip it for trivial single-step questions.
- If any task is still planned or ongoing, `buildInjectSnippet` is added (`store.ts:467-480`), capped at 8 open tasks. This is real output from the walkthrough state:
  > Current checklist (0/4 done): stg ongoing "Pick rate-limit strategy + store"; mid blocked ← stg; wir blocked ← mid; tst blocked ← wir. Use checklist_update as work progresses. Do not start blocked tasks. Copy 3-char ids; never invent them.

The usage mode is captured once at load (`usageGuidanceAtLoad`, `index.ts:75`), so changing it mid-session only takes effect after `/reload`.

### 2.6 Persistence: `pi.appendEntry` (`index.ts:122-134`)
`persistSnapshot` calls `pi.appendEntry("pi-checklist", snapshot)` inside a try/catch, because print or ephemeral sessions have no file. `commit()` does three things: set the cache, append the entry, refresh the UI. In the JSONL this becomes `{"type":"custom","customType":"pi-checklist","data":{…},"id":…,"parentId":…}` (pi `session-format.md:263-268`). Custom entries are **not sent to the LLM** (pi `extensions.md:1473`).

A snapshot is written in two places: the tool result's `details` and the custom entry. The custom entry matters for human actions such as `/checklist clear` or settings changes, which never produce a tool result (`AGENTS.md`).

### 2.7 Reconstruction (`index.ts:146-175`, `store.ts:424-441`)
`ctx.sessionManager.getBranch()` returns the entries on the path from the **root to the current leaf**. It walks `parentId` from the leaf and then reverses (pi `dist/core/session-manager.js:958-968`). `loadFromBranch` scans oldest → newest and keeps the **last** entry that is either a `custom` entry with `customType === "pi-checklist"`, or a `toolResult` message from one of the three checklist tools whose `details` is a snapshot. It deliberately avoids `getEntries()`, which would mix in other branches. Display prefs are then merged in with precedence global file > snapshot > defaults (`index.ts:153-162`).

### 2.8 UI surfaces (`index.ts:86-119`)
- `ctx.ui.setStatus("checklist", "☑ 1/4")`: footer text from `footerText` (`render.ts:128-132`). Cancelled tasks don't count toward the total.
- `ctx.ui.setWidget("checklist", (tui, theme) => ({ render: w => paintWidget(…), invalidate }), { placement: "belowEditor" })`: a component factory with the snapshot frozen at call time. In `statusbar` mode it sits below the editor. In `end-of-turn` mode it uses the default placement (above the editor) and hides while `inTurn`. It's cleared with `setWidget(key, undefined)`. The API is overloaded for `string[]` or a component factory (pi `types.d.ts:97-98`).
- The whole refresh is wrapped in try/catch with the comment "UI refresh must never break a turn" (`index.ts:115-118`), and it returns early if `!ctx.hasUI`.

---

## 3. Data model

### 3.1 Shapes (`types.ts`)
```ts
type TaskStatus = "planned" | "ongoing" | "done" | "cancelled";      // types.ts:3
interface Task { id; title; notes?; status; dependsOn: string[]; createdAt; updatedAt }  // types.ts:5-17
interface Checklist { title?; tasks: Task[]; updatedAt }             // types.ts:19-24
interface ChecklistSnapshot { v: 1; checklist: Checklist | null;     // types.ts:94-109
  widgetVisible?; displayMode?; statusStyle?; iconSet?; usage? }
interface TaskView extends Task { ready; blockedBy: string[]; blocked }  // computed, never stored (types.ts:125-132)
```
- **Ids**: exactly 3 chars `[a-z0-9]` (`store.ts:27`). If omitted, the id is FNV-1a of the normalised title, base36, re-salted on collision (`store.ts:37-67`). `"all"` is reserved. Example hashed ids: "Add rate-limit middleware" → `q6z`, "Add tests for 429 responses" → `jrv`. Short ids cost few tokens, and the guidelines tell the model to copy them.
- **Derived states** (`store.ts:158-167`): `blockedBy` = deps not `done`; `ready` = planned and not blocked. The UI splits planned into **REDY** and **BLCK** (`render.ts:60-65`, `92-105`).

### 3.2 State machine (`store.ts:99-122`)
```
planned  → ongoing | done | cancelled
ongoing  → done | cancelled | planned
cancelled→ planned
done     → (terminal, frozen)
same→same is a no-op
```

### 3.3 Dependency rules
- At create or update time, every `dependsOn` id must exist, a task can't depend on itself, and the graph must stay acyclic (DFS, `store.ts:191-215`).
- **The guard** (`store.ts:392-402`): moving **planned → ongoing** or **planned → done** needs every dependency `done`, checked against the final dependencies in the batch. Moving `ongoing → done` isn't re-checked, since the task already passed the guard when it started.

### 3.4 Validation errors (exact text; ones marked * were confirmed by running the code)
| Situation | Message | Where |
|---|---|---|
| Update before create | `no checklist yet: use checklist_create first`* | `store.ts:316` |
| Blocked transition | `task wir is blocked by [mid]: cannot move planned → done until every dependency is done`* | `store.ts:398-400` |
| Touching a done task | `task tst is done (frozen in v1): cannot edit; create a new task instead (update at index 0)`* | `store.ts:353` |
| Illegal move | `illegal transition for task ${id}: ${from} → ${to}` | `store.ts:120` |
| Bad id | `invalid task id "ab": must be exactly 3 alphanumeric chars [a-z0-9] (e.g. "k7q")`* | `store.ts:72-74` |
| Unknown id | `unknown task id "xyz" (update at index 1)`* | `store.ts:333` |
| Same id twice in one batch | `duplicate update for task "${id}": send one update per task` | `store.ts:341` |
| Unknown dependency | `task ${id} depends on unknown task "${dep}"` | `store.ts:277`, `375` |
| Self-dependency | `task ${id} cannot depend on itself` | `store.ts:275`, `373` |
| Cycle | `dependency cycle detected: dependsOn would create a loop`* | `store.ts:213` |

### 3.5 Atomic batches (`store.ts:314-411`)
`applyUpdates` deep-copies the task list, validates **everything** on the copy (ids, duplicates, field edits, transitions, dependency guards, cycles), and only then returns a new checklist. Any throw discards the copy, and `commit()` never runs. So "all-or-nothing" really means nothing partial reaches the session.
Nuance, confirmed by running it: status moves are applied **in input order**. `[{stg: done}, {mid: ongoing}]` succeeds in one call, while `[{mid: ongoing}, {stg: done}]` fails with `task mid is blocked by [stg]…`.

### 3.6 Example snapshot (as stored in `details` and in the `custom` entry `data`)
```json
{
  "v": 1,
  "checklist": {
    "title": "API rate limiting",
    "tasks": [
      { "id": "stg", "title": "Pick rate-limit strategy + store", "status": "done",    "dependsOn": [],      "createdAt": 1000, "updatedAt": 3000 },
      { "id": "mid", "title": "Add rate-limit middleware",        "status": "ongoing", "dependsOn": ["stg"], "createdAt": 1000, "updatedAt": 3000 },
      { "id": "wir", "title": "Wire middleware into routes",      "status": "planned", "dependsOn": ["mid"], "createdAt": 1000, "updatedAt": 1000 },
      { "id": "tst", "title": "Test 429 + Retry-After",           "status": "planned", "dependsOn": ["wir"], "createdAt": 1000, "updatedAt": 1000 }
    ],
    "updatedAt": 3000
  },
  "widgetVisible": true, "displayMode": "statusbar", "statusStyle": "pill", "iconSet": "nerd-font"
}
```
As a JSONL line: `{"type":"custom","id":"…","parentId":"…","timestamp":"…","customType":"pi-checklist","data":{ …above… }}`

---

## 4. Walkthrough: "add rate limiting to the API"

All widget text and error strings below are real output from `dist/store.js` + `dist/render.js` (pill style; `[REDY]` stands for a coloured-background pill).

**Step 0: system prompt.** The user presses Enter and `before_agent_start` fires. There's no checklist yet, so only the moderate hint is appended: *"Checklist available: for long-running or multi-step work … track it with checklist_create/read/update …"*. The tool guidelines from `promptGuidelines` are already in the Guidelines section.

**Step 1: model calls `checklist_create`.** It passes explicit ids because the dependencies point at tasks created in the same call, which is what the guideline recommends:
```json
{
  "title": "API rate limiting",
  "tasks": [
    { "id": "stg", "title": "Pick rate-limit strategy + store" },
    { "id": "mid", "title": "Add rate-limit middleware",   "dependsOn": "stg" },
    { "id": "wir", "title": "Wire middleware into routes", "dependsOn": ["mid"] },
    { "id": "tst", "title": "Test 429 + Retry-After",      "dependsOn": ["wir"] }
  ]
}
```
(Without deps it could omit ids and get hashed ones such as `9ce`, `q6z`, `9ac`, `jrv`.)
The text the LLM receives (`tools.ts:133-136`):
```
checklist: 4 task(s) installed (0/4 done)
  stg "Pick rate-limit strategy + store"
  mid "Add rate-limit middleware"
  wir "Wire middleware into routes"
  tst "Test 429 + Retry-After"
```
`commit()` then appends the `pi-checklist` entry and repaints. In the TUI it looks like this:
```
 checklist create 4 task(s)                          ← renderCall
 0/4 done  0 ongoing  1 ready  3 blocked             ← renderResult (collapsed)
 ...
 ┌ editor ───────────────────────────────────────────┐
 │ >                                                 │
 └───────────────────────────────────────────────────┘
 checklist API rate limiting  0/4 done   0 ongoing   1 ready   3 blocked
 [REDY] ○ stg  Pick rate-limit strategy + store
 [BLCK] ⊘ mid  Add rate-limit middleware ← stg
 [BLCK] ⊘ wir  Wire middleware into routes ← mid
 [BLCK] ⊘ tst  Test 429 + Retry-After ← wir
                                              footer: ☑ 0/4
```

**Step 2: start task 1.** `checklist_update {"updates":[{"id":"stg","status":"ongoing"}]}`. The call renders as `checklist stg`. The LLM receives `checklist (0/4 done):\n  stg planned → ongoing`. The widget row becomes `[PROG] ● stg  Pick rate-limit strategy + store`. The model then reads the code and picks a token bucket in Redis.

**Step 3: the model jumps ahead and tries to mark task 3 done.**
`checklist_update {"updates":[{"id":"stg","status":"done"},{"id":"wir","status":"done"}]}`
`stg` passes validation. `wir` is still planned and depends on `mid`, which isn't done, so the store throws. Pi marks the tool result `isError: true`, and the model sees:
```
task wir is blocked by [mid]: cannot move planned → done until every dependency is done
```
Because the batch is all-or-nothing, **`stg` is not marked done either**, no entry is appended, and the widget doesn't change. The transcript result row falls back to the dim error text.

**Step 4: recovery.** The error names the blocker, so the model does the work in order:
`checklist_update {"updates":[{"id":"stg","status":"done"},{"id":"mid","status":"ongoing"}]}` → `stg ongoing → done`, `mid planned → ongoing`
```
 checklist API rate limiting  1/4 done   1 ongoing   0 ready   2 blocked
 [PROG] ● mid  Add rate-limit middleware
 [BLCK] ⊘ wir  Wire middleware into routes ← mid
 [BLCK] ⊘ tst  Test 429 + Retry-After ← wir
 [DONE] ✓ stg  Pick rate-limit strategy + store
                                              footer: ☑ 1/4
```
It carries on: `mid` done with `wir` ongoing, then `wir` done with `tst` ongoing, then `tst` done.

**Step 5: end state.**
```
 checklist API rate limiting  4/4 done   0 ongoing   0 ready   0 blocked
 [DONE] ✓ stg  Pick rate-limit strategy + store
 [DONE] ✓ mid  Add rate-limit middleware
 [DONE] ✓ wir  Wire middleware into routes
 [DONE] ✓ tst  Test 429 + Retry-After
                                              footer: ☑ 4/4
```
On the next user prompt nothing is planned or ongoing, so `before_agent_start` adds only the hint and no checklist snippet (`index.ts:317-321`).

**Step 6: branching with `/tree`.** The user thinks "fixed window would have been simpler", opens `/tree`, and picks the user message just after **Step 2**, when `stg` was ongoing.
1. Pi moves the session **leaf** to that entry. Nothing is deleted; the later entries stay in the file on the old branch (pi `session-format.md:305-318`).
2. Pi fires `session_tree` and the handler calls `reconstruct(ctx)` (`index.ts:293`).
3. `ctx.sessionManager.getBranch()` returns only root → new leaf. That path contains Step 1's tool result and custom entry and Step 2's, but not the Step 4 or 5 entries, which sit on the other branch.
4. `loadFromBranch` takes the last snapshot on that path, the Step 2 one: `stg ongoing, mid/wir/tst blocked`.
5. `refreshUi` repaints the widget to `0/4`, and the next `before_agent_start` injects `stg ongoing "…"; mid blocked ← stg; …`. The model on the new branch sees the plan as it was at that point.
If the user branches from before Step 1, there's no snapshot on the path, `checklist` is `null`, and the widget and footer are cleared. `/resume` and `/fork` use the same code path through `session_start`. Compaction only appends a summary entry, so the snapshot lines stay on the path.

---

## 5. Slide-ready code excerpts

**A. registerTool skeleton** (`index.ts:179-200`, lightly condensed: the `executeCreate` argument list is collapsed)
```ts
pi.registerTool({
  name: "checklist_create",
  label: "Checklist Create",
  description: "Create or extend the session task checklist (replace by default, or append). Returns 3-char task ids. …",
  promptSnippet: CREATE_SNIPPET,
  promptGuidelines: CREATE_GUIDELINES,
  parameters: ChecklistCreateParams,
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const mutation = executeCreate(state.checklist, state.widgetVisible, params, /* prefs */);
    commit(mutation.snapshot, ctx);
    return { content: [{ type: "text", text: mutation.text }], details: mutation.snapshot };
  },
  renderCall: (args, theme) => renderCreateCall(args, theme),
  renderResult: (result, { expanded }, theme) => renderChecklistResult(result, expanded, theme),
});
```
(14 lines. For ≤12, drop `label` and `renderCall`.)

**A′. Schema** (`tools.ts:27-41`, condensed)
```ts
export const ChecklistCreateParams = Type.Object({
  title: Type.Optional(Type.String({ description: "Optional session/goal name…" })),
  mode: Type.Optional(StringEnum(["replace", "append"] as const)),
  tasks: Type.Array(Type.Object({
    id: Type.Optional(Type.String({ description: 'Optional explicit 3-char id (e.g. "k7q")' })),
    title: Type.String({ description: "Short task title (required)" }),
    notes: Type.Optional(Type.String()),
    dependsOn: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  })),
});
```

**B. before_agent_start injection** (`index.ts:307-323`, comments removed, hint strings shortened)
```ts
pi.on("before_agent_start", async (event, ctx) => {
  const hint = usageGuidanceAtLoad === "aggressive"
    ? "Checklist expected: use checklist_create/read/update for almost every task…"
    : "Checklist available: for long-running or multi-step work … track it with checklist_create/read/update…";
  const checklist = state.checklist;
  const open = !!checklist && checklist.tasks.length > 0 &&
    checklist.tasks.some((t) => t.status === "planned" || t.status === "ongoing");
  const extra = open ? ` ${buildInjectSnippet(checklist!)}` : "";
  return { systemPrompt: `${event.systemPrompt}\n\n${hint}${extra}` };
});
```

**C. appendEntry commit** (`index.ts:121-134`, verbatim minus doc comment)
```ts
function persistSnapshot(snapshot: ChecklistSnapshot): void {
  try {
    pi.appendEntry(CUSTOM_TYPE, snapshot);   // "pi-checklist"
  } catch {
    // Ephemeral/print sessions have no session file — in-memory still works.
  }
}
function commit(snapshot: ChecklistSnapshot, ctx: ExtensionContext): void {
  state = snapshot;
  persistSnapshot(snapshot);
  refreshUi(ctx);
}
```

**D. Session reconstruction** (`store.ts:424-441` + `index.ts:292-293`, condensed)
```ts
export function loadFromBranch(branch: BranchLike[]): ChecklistSnapshot {
  let found: ChecklistSnapshot = { v: 1, checklist: null };
  for (const entry of branch) {                       // root → leaf
    if (entry.type === "custom" && entry.customType === "pi-checklist") found = entry.data;
    else if (entry.type === "message" && entry.message?.role === "toolResult"
      && CHECKLIST_TOOLS.has(entry.message.toolName)) found = entry.message.details;
  }
  return found;                                       // last snapshot wins
}
pi.on("session_start", async (_e, ctx) => reconstruct(ctx));   // uses ctx.sessionManager.getBranch()
pi.on("session_tree",  async (_e, ctx) => reconstruct(ctx));
```
(The real code also checks `isChecklistSnapshot(...)` on each candidate.)

**E. The dependency guard** (`store.ts:392-406`, trimmed)
```ts
for (const m of statusMoves) {
  if (m.from === "planned" && (m.to === "ongoing" || m.to === "done")) {
    const blockedBy = m.task.dependsOn.filter((dep) => finalById.get(dep)?.status !== "done");
    if (blockedBy.length > 0) {
      throw new Error(
        `task ${m.task.id} is blocked by [${blockedBy.join(", ")}]: cannot move planned → ${m.to} until every dependency is done`,
      );
    }
  }
  m.task.status = m.to;
}
```

**F. Widget + footer** (`index.ts:98`, `107-114`)
```ts
ctx.ui.setStatus(STATUS_KEY, footerText(checklist) ?? undefined);      // "☑ 1/4"
ctx.ui.setWidget(
  WIDGET_KEY,
  (_tui, theme) => ({
    render: (width: number) => paintWidget(frozen, theme, width, frozenOpts),
    invalidate: () => {},
  }),
  { placement: "belowEditor" },
);
```

---

## 6. Line counts (`wc -l src/*.ts`)

| File | Lines | Role |
|---|---|---|
| `src/types.ts` | 158 | Task/Checklist/Snapshot types, enums, guards (no pi imports) |
| `src/store.ts` | 480 | Pure logic: ids, state machine, deps, cycles, atomic update, branch reconstruction, inject snippet |
| `src/tools.ts` | 174 | TypeBox schemas, prompt snippets/guidelines, execute helpers |
| `src/index.ts` | 324 | Wiring: registerTool×3, command, events, appendEntry, widget/status |
| `src/render.ts` | 454 | Widget lines, pills/glyphs, tool renderers, overlay component, dialog frame |
| `src/commands.ts` | 386 | `/checklist` show/hide/clear/settings, settings screen |
| `src/prefs.ts` | 81 | Global display prefs file `<agentDir>/pi-checklist.json` |
| **Total** | **2057** | |

Talking point: the pi-specific wiring is basically `index.ts` (324 lines). The rules (`store.ts` + `types.ts`, about 640 lines) are plain TypeScript with no pi imports and can be tested with plain node. Everything else is display polish. A minimal version (3 tools, the hook, the append and the reconstruct) would be well under 300 lines.

---

## 7. Visualisation storyboard (interactive slide)

**Layout:** three panes. Left is a fake **transcript** (user bubble plus tool-call chips). Centre is the **checklist panel** styled like the TUI widget with pills and a `☑ n/m` footer. Right is a **session tree** (JSONL entries as nodes; `pi-checklist` custom entries and tool results with `details` are shown as small teal "snapshot" diamonds). A dependency DAG (`stg → mid → wir → tst`) sits above the checklist panel. Advance with the arrow keys or reveal.js fragments.

| # | State | Caption (≤8 words) | Speaker notes |
|---|---|---|---|
| 1 | Transcript shows the user's "add rate limiting to the API". A system prompt box slides in with the hint line highlighted. Checklist panel is empty. Tree has a single user node. | Hook injects the hint before thinking | `before_agent_start` returns `{ systemPrompt }`. No list yet, so only the one-line hint. The tools' `promptGuidelines` are already in the Guidelines section. It's plain text and costs almost nothing. |
| 2 | Chip `checklist create 4 task(s)` appears with its JSON args on hover. Four rows animate into the panel: `stg` REDY, three BLCK. DAG edges are grey. Tree gains a tool-result node plus a teal diamond. Footer `☑ 0/4`. | Model writes its plan as tool call | One tool call and the plan is data. Explicit ids because deps point at tasks in the same batch. `content` goes to the model; `details` is the snapshot, saved but not sent to the model. The diamond is `appendEntry`. |
| 3 | Chip `checklist stg`. `stg` pill turns amber PROG with glyph ●. DAG node `stg` pulses amber. New diamond. | Mark ongoing before touching code | The guideline says mark ongoing *before* starting, so the human knows what the agent is doing right now. Each mutation appends a snapshot. |
| 4 | Chip `checklist stg, wir`. The DAG edge `mid → wir` flashes **red**, the `wir` node shakes, and a red toast shows the exact error: `task wir is blocked by [mid]: cannot move planned → done…`. The checklist panel doesn't change, and `stg` stays PROG as a "rolled back" ghost. No diamond. | Blocked transition: whole batch rejected | The store threw, pi set `isError`, and the model read the message. It's all-or-nothing, so even the valid `stg → done` was dropped and nothing was persisted. This is the extension enforcing order, not just recording it. |
| 5 | Chip `checklist stg, mid`. `stg` goes to green DONE and sinks to the bottom, `mid` goes PROG, the `stg → mid` edge turns green. Footer `☑ 1/4`. Then fast-forward: rows turn green in sequence until `☑ 4/4`. | Error text becomes the recovery plan | The error names the blocker, so the model fixes itself without a human stepping in. Fast-forward to 4/4. On the next prompt the injected snippet disappears because nothing is open. |
| 6 | Viewer clicks the tree node after step 3. The branch path lights up and the later nodes grey out. A "scanner" dot walks root → leaf over the diamonds and stops at the last lit one. The checklist rewinds with animation to `stg` PROG, `☑ 0/4`. | /tree rewinds the checklist too | `session_tree` → `getBranch()` returns root→leaf only → last snapshot wins. Nothing is deleted; the old branch still exists. Click the greyed branch to jump back to 4/4. The session file is the database. |
| 7 (optional) | Code overlay: the 4 excerpts (register, inject, append, reconstruct) with a line counter reading `index.ts 324 lines`. | Four APIs, one afternoon, your harness | Recap: registerTool, before_agent_start, appendEntry, getBranch on session_start/session_tree. Pure logic lives outside pi (`store.ts` has no pi imports). Try `pi install npm:pi-checklist`, or write your own. |

Interaction details for the implementer:
- Keep data in one JS array of snapshots `S0..S5` plus a tree `{id,parent,snapshotIdx|null}`. Clicking a tree node takes the last non-null `snapshotIdx` on its ancestor path, which mirrors `loadFromBranch` exactly.
- Pill colours map to theme tokens in `render.ts:92-105`: PROG=warning/amber, REDY=accent, BLCK=error/red bg, DONE=success/green, DROP=dim.
- Glyphs (classic): ● ongoing, ○ ready, ⊘ blocked, ✓ done, ✕ cancelled (`render.ts:18-26`).
- Sort order in the panel: ongoing, ready, blocked, done, cancelled (`store.ts:175-184`). Animate rows moving when the order changes.
