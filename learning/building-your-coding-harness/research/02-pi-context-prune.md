# 02 — pi-context-prune: a step-by-step teardown

Research for the "Building your coding harness" talk. Everything here was checked against source:

- Extension repo: `/Users/championswimmer/Development/Personal/LLM/pi-context-prune` at commit `626f270` (package `pi-context-prune@1.4.0`, clean tree). `dist/index.js` is the esbuild bundle of `index.ts` + `src/` (the local copy is stale; see the end of this file).
- Pi runtime: `@earendil-works/pi-coding-agent@0.85.1` at `~/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent` (with `pi-ai` and `pi-agent-core`).
- `file:line` references are to the extension repo unless they start with `pi:` (the Pi install).

---

## 1. The problem and the pitch

**Why tool results bloat context**

- A coding agent loop is `LLM call → tool calls → tool results appended → LLM call again`. **Every later request re-sends the whole message array.** A 6,000-token `npm test` log you needed once gets paid for on every request after it.
- **Tokens / cost:** input tokens scale with (size of old tool output) × (number of later requests). A 20-request session re-sends that log 20 times.
- **Attention:** the useful signal ("test fails because `verifyToken` compares expiry in seconds vs ms") sits inside thousands of tokens the model has already used. Long, noisy context hurts recall and fills the window faster (PRUNING.md §"What Does a Long Session Look Like?").
- **Context-window limit:** big outputs push the session toward auto-compaction, which is lossy and done all at once.
- **Prompt cache (the twist):** providers cache an *identical prefix*. Changing earlier messages busts the cache from that point on. So pruning **saves** tokens, but pruning **too often** wrecks cache hits. That's why the default mode batches and prunes once per task (README "Cache-aware guidance"; `src/commands.ts:89-95`).

**One-sentence pitch**

> pi-context-prune swaps old tool outputs in the LLM's view for short summaries once a task is done. It keeps every original in a session-backed index, and the model can ask for any of them back with `context_tree_query("t2")`.

Key design rule (`src/types.ts:31-40`): pruning happens **only in the `context` event**, which builds each request. The session file and the original `toolResult` entries are never rewritten. Assistant tool-call blocks stay in place, so the IDs remain as anchors.

---

## 2. Architecture map

| File | Lines | Role (one line) |
|---|---|---|
| `index.ts` | 579 | Entry point. Holds shared state (config, indexer, stats, frontier, `pendingBatches`), registers 8 `pi.on` hooks, defines `flushPending`, and wires the tools and commands. |
| `src/types.ts` | 427 | Constants (`context-prune-summary/index/stats/frontier` custom types, tool names, the agentic-auto system prompt), config type + `DEFAULT_CONFIG`, and the batch/record/frontier interfaces. |
| `src/config.ts` | 55 | Loads and validates `~/.pi/agent/context-prune/settings.json` (falling back to defaults) and saves it. |
| `src/batch-capture.ts` | 235 | Turns a `turn_end` payload or a session-branch scan into a `CapturedBatch`, serializes it for the summarizer (2,000 chars per result), and groups batches by `batchingMode`. |
| `src/summarizer.ts` | 228 | Resolves the summarizer model, gets auth, streams one LLM call per batch (in parallel), and returns `{summaryText, usage}`. |
| `src/indexer.ts` | 139 | `ToolCallIndexer`: `Map<toolCallId, ToolCallRecord>`, the short-alias map (`t1 → toolu_…`), rebuild-from-branch, and `pi.appendEntry` persistence. |
| `src/pruner.ts` | 16 | The whole pruning algorithm: drop `toolResult` messages whose `toolCallId` is indexed. |
| `src/summary-refs.ts` | 116 | Short ref allocation (`t1, t2…`), the `<context-prune-summary>` wrapper, the ref footer text, and the summary `details` payload. |
| `src/query-tool.ts` | 67 | Registers the `context_tree_query` tool (recovery path). |
| `src/context-prune-tool.ts` | 125 | Registers the `context_prune` tool (the model triggers a flush; active only in agentic-auto) and streams progress via `onUpdate`. |
| `src/reminder.ts` | 87 | Agentic-auto only: appends a `<pruner-note>N unpruned…</pruner-note>` to the last toolResult in the request. |
| `src/frontier.ts` | 62 | `PruneFrontierTracker`: remembers the last *attempted* prune boundary (including skipped ones) and persists it as a custom entry. |
| `src/stats.ts` | 139 | `StatsAccumulator` (summarizer tokens/cost, persisted as snapshots) plus the `1.2k` / `$0.003` formatters. |
| `src/progress-text.ts` | 28 | Shared "Context prune running… 1.2k summary chars / 36k raw chars · 2 tool calls" formatter. |
| `src/commands.ts` | 819 | `/pruner` command (12 subcommands), settings overlay, footer status, `/pruner now` progress widget, and the summary message renderer. |
| `src/tree-browser.ts` | 381 | `TreeBrowser` TUI component for `/pruner tree` (summaries → pruned tool calls, char counts, Ctrl-O overlay). |
| `src/multi-batch-loader.ts` | 96 | `MultiBatchLoaderOverlay` spinner-per-batch component. **Not imported anywhere in current code** (dead code; `/pruner now` uses `ctx.ui.setWidget` in `commands.ts:252-349` instead). |

Mental model for slides: **Capture** (batch-capture) → **Summarize** (summarizer) → **Store** (indexer + summary-refs + frontier/stats) → **Filter** (pruner, in `context`) → **Recover** (query-tool). Control plane: config + commands + tree-browser.

---

## 3. Every Pi hook and API the extension uses

### 3a. Event hooks (`pi.on`), all in `index.ts`

| Hook | Where | What the extension does | Return value / effect in Pi |
|---|---|---|---|
| `session_start` | `index.ts:394-422` | `loadConfig()`. Rebuilds the indexer, stats, and frontier from `ctx.sessionManager.getBranch()`. Clears `pendingBatches`, sets the footer status, `syncToolActivation()`, and shows an optional "pruner loaded — pruning ON/OFF \| model: …" notice. | Returns nothing (notification-only event). Fires on startup/reload/new/resume/fork (pi: `docs/extensions.md:393-403`). |
| `session_tree` | `index.ts:425-431` | Rebuilds the indexer, stats, and frontier for the **new branch** and drops pending batches from the old branch. | Returns nothing. Fires after `/tree` navigation (pi: `docs/extensions.md:493-515`). |
| `turn_end` | `index.ts:434-492` | If enabled and the turn had tool results, runs `captureBatch(event.message, event.toolResults, event.turnIndex, Date.now())`. Filters out `context_prune`'s own result, trims against the index/frontier, then pushes to `pendingBatches`. `every-turn` flushes now (awaited). Other modes set status `prune: N pending` and notify "N turns queued — will summarize on …". | Returns nothing. Payload `{turnIndex, message, toolResults}` (pi: `dist/core/extensions/types.d.ts:585-590`). Pi **awaits** handlers before the next LLM call (pi-agent-core `agent-loop.js:147`). |
| `tool_execution_end` | `index.ts:495-500` | If `event.toolName` is `context_checkpoint` or legacy `context_tag` (from the separate pi-context extension), pruning is enabled, and mode is `on-context-tag`: `flushPending(ctx, {delivery:"runtime"})`. | Returns nothing. Payload `{toolCallId, toolName, result, isError}` (pi: `types.d.ts:623-629`). |
| `message_end` | `index.ts:507-512` | In `agent-message` mode, if the finalized message is an assistant message **with no toolCall blocks** (`isFinalAssistantMessage`, `:82-87`): `flushPending(ctx, {delivery:"session"})`. | May return `{message}` to replace the message. **The extension returns nothing.** Pi runs extension handlers *before* persisting the message (pi: `agent-session.js:384-397`). |
| `agent_end` | `index.ts:517-521` | Status update only (`prune: N pending`). It deliberately **doesn't** start LLM work, because in print mode the session may already be shutting down. | Returns nothing. |
| `context` | `index.ts:524-559` | Runs `pruneMessages(event.messages, indexer)`. In agentic-auto mode with `remindUnprunedCount` on, it also appends `<pruner-note>` to the last toolResult. Returns `{messages}` **only if something changed**, else `undefined`. | `ContextEventResult { messages?: AgentMessage[] }` (pi: `types.d.ts:814-816`). Pi deep-clones before calling (`structuredClone`, pi: `runner.js:791-817`), chains the result through each extension's handlers, and sends the result to the provider. **This changes only this request, never the session.** |
| `before_agent_start` | `index.ts:562-569` | In agentic-auto mode: `return { systemPrompt: event.systemPrompt + "\n\n" + AGENTIC_AUTO_SYSTEM_PROMPT }` (text in `types.ts:80-102`). | `BeforeAgentStartEventResult { message?, systemPrompt? }`. The system prompt is replaced for this run and chained across extensions (pi: `types.d.ts:845-849`). |

### 3b. Registration and runtime APIs on `pi` (ExtensionAPI)

| API | Where | Use | Effect |
|---|---|---|---|
| `pi.registerTool({name:"context_tree_query", …})` | `src/query-tool.ts:7-66`, called at `index.ts:572` | Recovery tool, always active. | The LLM can call it. `promptSnippet` + `promptGuidelines` go into the system prompt's tool list and guidelines. `execute()` returns `{content:[{type:"text"}], details}`. |
| `pi.registerTool({name:"context_prune", parameters: Type.Object({})})` | `src/context-prune-tool.ts:42-125`, called at `index.ts:575` | The model calls it to flush in agentic-auto mode. Streams progress with `onUpdate`, and Esc (`signal`) cancels. | Returns a text result like "Context prune completed. Summarized 3 tool calls from 2 batches. Summary size: …". |
| `pi.getActiveTools()` / `pi.setActiveTools()` | `index.ts:379-391` (`syncToolActivation`) | Adds `context_prune` to the active tools only when `enabled && pruneOn==="agentic-auto"` and removes it otherwise. Called on session start and on every config change. | Controls which tools the LLM sees. |
| `pi.registerCommand("pruner", {description, getArgumentCompletions, handler})` | `src/commands.ts:366-802` | `/pruner` with 12 subcommands and tab-completion. | Slash command. The handler gets `ExtensionCommandContext`. |
| `pi.registerMessageRenderer("context-prune-summary", …)` | `src/commands.ts:805-819` | Renders summary messages as `[pruner] Turn 0 summary (2 tools)`, and the unwrapped markdown when expanded. | TUI rendering of the custom message type. Summaries are written with `display:false`, so they are hidden in the main transcript by default. |
| `pi.sendMessage({customType, content, display:false, details}, {deliverAs:"steer"})` | `index.ts:263-266` | **Runtime delivery** of a summary (`on-context-tag`, `agentic-auto`). | While streaming it's queued via `agent.steer()`: added to agent state and the session after the current turn's tool calls and before the next LLM call. Custom messages go to the LLM as **`role:"user"`** text (pi: `core/messages.js:89-96`). |
| `pi.appendEntry(customType, data)` | `src/indexer.ts:137` (index), `src/frontier.ts:60`, `src/stats.ts:102` | Persists index records, frontier, and stats snapshots (runtime path). | Session entry `{type:"custom", customType, data}`. **Not in LLM context** (pi: `docs/extensions.md:1471-1487`). |

### 3c. `ctx` (ExtensionContext / ExtensionCommandContext) APIs

| API | Where | Use |
|---|---|---|
| `ctx.sessionManager.getBranch()` | `indexer.ts:24`, `stats.ts:82`, `frontier.ts:40`, `index.ts:141`, `tree-browser.ts:97` | Walks root→leaf entries of the **current branch** to rebuild state and to find unsummarized tool results at flush time. |
| `ctx.sessionManager.appendCustomMessageEntry(type, content, display, details)` / `.appendCustomEntry(type, data)` | `index.ts:180-193, 270-272, 324-326` (typed via a `SessionAppender` cast, `:64-67`) | **Session delivery** (`agent-message`, `every-turn`). Writes the summary (`custom_message`) and index/frontier/stats (`custom`) straight to the session tree. It grabs the SessionManager *before* awaiting the LLM, so print-mode shutdown can't make `pi.*` stale mid-flush (`index.ts:156-159, 502-506`). |
| `ctx.ui.notify(msg, level)` | many (e.g. `index.ts:417, 485`; `summarizer.ts:46,58,93,99,177`) | Toasts: queue notices, errors, skipped-oversized warnings. Wrapped in `safeNotify` (`index.ts:74-80`) to ignore "ctx is stale" errors. |
| `ctx.ui.setStatus("context-prune", text)` | `commands.ts:58-68` | Footer: `prune: ON (On agent message) │ ↑1.8k ↓270 $0.001`, `prune: 2 pending`, `prune: summarizing…`. |
| `ctx.ui.setWidget("context-prune-progress", factory, {placement:"aboveEditor"})` | `commands.ts:304-333, 346` | Live one-row-per-batch spinner for `/pruner now`. |
| `ctx.ui.select(title, options)` | `commands.ts:380, 692, 711` | Pickers for bare `/pruner`, `prune-on`, and `batching`. |
| `ctx.ui.custom(factory, {overlay:true, overlayOptions})` | `commands.ts:555-564, 610-619` | Settings overlay (`SettingsList`, width 60) and tree browser (80% × 70%, centered). |
| `ctx.model` | `summarizer.ts:41` | The `"default"` summarizer uses the currently active model. |
| `ctx.modelRegistry.find(provider, id)` | `summarizer.ts:56` | Explicit `summarizerModel: "provider/model-id"`, with a warning and fallback if it isn't found. |
| `ctx.modelRegistry.getApiKeyAndHeaders(model)` | `summarizer.ts:90` | Credentials, headers, env, and optional baseUrl for the summarizer call. |
| `ctx.modelRegistry.getProvider(model.provider).stream(model, {messages}, {apiKey, headers, env, signal, reasoningEffort?})` | `summarizer.ts:97-128` | The **side LLM call** that summarizes. It iterates the stream for progress and then calls `await responseStream.result()` (`:140-152`). |
| `ctx.modelRegistry.getAvailable()` | `commands.ts:390` | Model list in the settings submenu. |

### 3d. Library imports from Pi

- `truncateHead`, `DEFAULT_MAX_LINES` (2000), `DEFAULT_MAX_BYTES` (50 KB) in `query-tool.ts:2, 46-49`. These cap a recovered output (keeping the head) exactly like built-in tools do (pi: `dist/core/tools/truncate.js:10-11`).
- `DynamicBorder`, `getSettingsListTheme`, `getMarkdownTheme`, plus `@earendil-works/pi-tui` `Container, Text, SettingsList, Markdown, Loader, getKeybindings, matchesKey…` for UI.
- `Type` from `@sinclair/typebox` for tool parameter schemas.

---

## 4. Full lifecycle with an example scenario

### 4.0 Setup and scenario

Settings: `enabled: true` (default is **false**, so run `/pruner on` first), `pruneOn: "agent-message"` (default), `batchingMode: "turn"` (default), and `summarizerModel: "anthropic/claude-haiku-3-5"` (optional; the default reuses the active model).

Fresh session. Token counts are illustrative (~4 chars/token). The mechanics are exact.

| # | Message | Role | ≈ tokens | ≈ chars |
|---|---|---|---|---|
| — | System prompt + tool definitions | system | 2,500 | — |
| U1 | "Why is the login test failing?" | user | 15 | — |
| A0 | "Let me look at the auth module and run the tests." + `read {path:"src/auth.ts"}` + `bash {command:"npm test"}` (parallel calls, one assistant message) | assistant (**turn 0**) | 60 | — |
| R1 | contents of `src/auth.ts` | toolResult | **3,000** | 12,000 |
| R2 | `npm test` output (jest, 1 failing: `login › rejects expired token`) | toolResult | **6,000** | 24,000 |
| A1 | `bash {command:"grep -rn token src/"}` | assistant (**turn 1**) | 40 | — |
| R3 | grep matches | toolResult | **2,000** | 8,000 |
| A2 | "The test fails because `verifyToken` compares `exp` (seconds) with `Date.now()` (ms)…" | assistant (**turn 2**, text only) | 250 | — |
| U2 | (later) "OK, fix it." | user | 10 | — |

LLM request sizes during the run (no pruning yet): request 1 = 2,515; request 2 = 11,575; request 3 = 13,615. Without the extension, request 4 (after U2) = **13,875**.

### 4.1 Event-by-event trace (agent-message mode)

**Step 0 — `session_start`** (`index.ts:394`). Loads config and rebuilds an empty index. Footer: `prune: ON (On agent message)`. `before_agent_start` does nothing (not agentic-auto).

**Step 1 — request 1 → `context` hook** (`index.ts:524`). The index is empty and the mode isn't agentic-auto, so it returns `undefined` and Pi sends messages unchanged. The model emits A0 with two toolCall blocks, and Pi runs `read` and `bash`.

**Step 2 — `turn_end` (turnIndex 0)** (`index.ts:434-492`). `event.toolResults.length === 2`, so `captureBatch` (`batch-capture.ts:8-51`) produces:

```json
{
  "turnIndex": 0,
  "timestamp": 1789650000000,
  "assistantText": "Let me look at the auth module and run the tests.",
  "toolCalls": [
    { "toolCallId": "toolu_01AuthRead", "toolName": "read",
      "args": { "path": "src/auth.ts" },
      "resultText": "import jwt from 'jsonwebtoken';\nexport function verifyToken(t: string) { … }  /* 12,000 chars */",
      "isError": false },
    { "toolCallId": "toolu_01NpmTest", "toolName": "bash",
      "args": { "command": "npm test" },
      "resultText": "> jest\n PASS src/user.test.ts\n FAIL src/login.test.ts\n  ● login › rejects expired token …  /* 24,000 chars */",
      "isError": false }
  ]
}
```

(`args` comes from `block.input ?? block.args ?? block.arguments`, `batch-capture.ts:44`; Pi's ToolCall uses `arguments`. `resultText` joins only `type:"text"` content, `:34-37`.)

`trimBatchToPendingRange` (`index.ts:89-111`) finds nothing indexed and no frontier yet, so the batch passes. It's pushed to `pendingBatches`. Status: `prune: 1 pending`. Toast: `pruner: 1 turn queued — will summarize on agent's next text response`.

**Step 3 — request 2 → `context`** returns `undefined` (the index is still empty). Model emits A1 (grep). **`turn_end` (turnIndex 1)** queues the second batch `{turnIndex:1, toolCalls:[{toolCallId:"toolu_01Grep", toolName:"bash", args:{command:"grep -rn token src/"}, resultText:"…8,000 chars", isError:false}]}`. Toast: `2 turns queued`.

**Step 4 — request 3 → model emits A2 (text only).**
- `message_end` fires. `isFinalAssistantMessage(A2)` is true, so `flushPending(ctx, {delivery:"session"})` runs (`index.ts:507-512`).
- (`turn_end` for turn 2 has no tool results and returns early, `:439-444`.)

**Step 5 — `flushPending`** (`index.ts:160-374`):
1. `isFlushing` guard (`:161`).
2. `capturePendingBatches(ctx)` (`:138-150`). It **re-scans the session branch** with `captureUnindexedBatchesFromSession` (`batch-capture.ts:61-139`) instead of trusting `pendingBatches`, which is only the fallback if `getBranch()` throws. The scan matches every assistant toolCall block to a persisted `toolResult` that isn't indexed and isn't `context_prune`, and tags each batch with `userTurnGroup`. Then it trims against the frontier and runs `groupBatchesByMode` (with `"turn"`, 2 batches stay 2).
3. Drains `pendingBatches` *before* awaiting (`:175`). Status: `prune: summarizing…` (`:196`).
4. `summarizeBatches` (`summarizer.ts:198-228`) runs **one LLM call per batch, in parallel** (`Promise.all`). `/pruner now` passes `onProgress` and runs them sequentially instead (`index.ts:206-218`).
5. For each result in order (`:237-288`):
   - `indexer.allocateSummaryRefs(batch)`: turn 0 gets `t1, t2`; turn 1 gets `t3` (`indexer.ts:78-83`, `summary-refs.ts:23-32`).
   - `summaryText = wrapSummaryForContext(llmText + formatSummaryToolCallRefs(refs))` (`:247`).
   - **Oversize check** (`:248`): `summaryText.length > rawResultChars` means skip. Turn 0 is ~720 chars vs 36,000 and turn 1 is ~360 vs 8,000, so both are kept.
   - `statsAccum.add(usage)`.
   - Session delivery (`:269-273`) runs `appendCustomMessageEntry("context-prune-summary", summaryText, false, details)`, then `indexer.registerSummaryRefs`, then `persistBatchIndex` (sets the in-memory Map + `appendCustomEntry("context-prune-index", {toolCalls})`).
6. Frontier snapshot → `appendCustomEntry("context-prune-frontier", …)`, stats → `appendCustomEntry("context-prune-stats", …)` (`:305-330`).
7. Footer: `prune: ON (On agent message) │ ↑1.8k ↓270 $0.001` (`:335`).

**Step 6 — Pi persists A2.** Pi's `message_end` runs extension handlers *before* `sessionManager.appendMessage` (pi: `agent-session.js:384-397`). So in the session file, the summary/index entries sit **just before** A2.

**Step 7 — user sends U2 → request 4 → `context` hook** (`index.ts:524-559`). The index now holds 3 IDs, so `pruneMessages` removes R1, R2, and R3 and the hook returns `{messages}`. See the before/after in 4.5.

**Step 8 — recovery (optional).** The model wants the exact jest failure, which the summarizer may not have seen (see 4.3 truncation), so it calls `context_tree_query({toolCallIds:["t2"]})`. See 4.6.

### 4.2 When does the flush fire? All five `pruneOn` modes on this scenario

| Mode | Capture | Flush trigger (exact code) | Delivery | In this scenario |
|---|---|---|---|---|
| `agent-message` (**default**, `types.ts:202`) | `turn_end` queues | `message_end` where the message is an assistant message with **no** toolCall blocks (`index.ts:507-512`) | `session` | Queue T0, queue T1, flush after A2 (2 parallel summarizer calls). Savings show up from **request 4** (after U2). One cache bust per task. |
| `every-turn` | `turn_end` | Same `turn_end` handler, right after push: `await flushPending(ctx,{delivery:"session"})` (`:463-464`). Pi awaits it, so it runs before the next LLM call. | `session` | Flush after T0 (R1+R2 gone from **request 2**), flush after T1 (R3 gone from request 3). 2 summarizer calls, **2 cache busts**. The code labels it "Debugging only" (`commands.ts:90`). |
| `on-context-tag` | `turn_end` queues | `tool_execution_end` with `toolName ∈ ["context_checkpoint","context_tag"]` (`:495-500`). Those tools come from the separate **pi-context** extension. | `runtime` (`pi.sendMessage` steer) | Nothing flushes unless the model calls `context_checkpoint`. If it did so in turn 2, R1–R3 are summarized and the summaries are steered in before the next LLM call. |
| `on-demand` | `turn_end` queues | Only `/pruner now` (`commands.ts:731-788`), which runs sequentially with a progress widget. | `runtime` (default `delivery`, `index.ts:179`) | Stays at `prune: 2 pending` until the user types `/pruner now`. |
| `agentic-auto` | `turn_end` queues (drops `context_prune`'s own result, `:457`) | The model calls the `context_prune` tool (`context-prune-tool.ts:57-70`, `index.ts:575`). Setup: `before_agent_start` appends `AGENTIC_AUTO_SYSTEM_PROMPT` ("A good target is usually about 8–12 related tool calls…", `types.ts:80-102`), `syncToolActivation` enables the tool, and `context` appends `<pruner-note>3 unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–12 related tool calls.</pruner-note>` to the last toolResult (`reminder.ts:56-87`). | `runtime` | With only 3 calls, a well-behaved model **won't** prune ("Do NOT call it for trivial…"). On a longer run, it calls `context_prune` around tool call 10. |

Also:

- `batchingMode: "agent-message"` merges all batches that share `userTurnGroup` into one summary (`batch-capture.ts:201-235`). Our two batches would become one call with refs `t1,t2,t3` and `turnIndex:1`. This only applies to the session-scan path, which every flush uses.
- `agent_end` never flushes (`index.ts:514-521`). If a run ends without a final text message, batches stay pending for `/pruner now`.

### 4.3 The summarizer call

**Prompt** (`src/summarizer.ts:13-19`, verbatim):

```text
You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.
```

**How it's sent** (`summarizer.ts:103-128`): there is no system role. A **single user message** = `SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>"`. It goes through `provider.stream(model, {messages:[…]}, {apiKey, headers, env, signal, ...reasoningEffort})`. `summarizerThinking` maps to `reasoningEffort` unless `"default"` (`:21-32`).

**Model:** `summarizerModel: "default"` uses `ctx.model` (the model you're chatting with). `"provider/id"` uses `ctx.modelRegistry.find` and falls back with a warning (`:39-66`).

**Serialized batch for turn 0** (`batch-capture.ts:142-166`). **Each resultText is cut to its first 2,000 chars**:

```text
Assistant said: Let me look at the auth module and run the tests.

Tool: read({
  "path": "src/auth.ts"
})
Result (OK): import jwt from 'jsonwebtoken'; … ...[10000 chars truncated]
---
Tool: bash({
  "command": "npm test"
})
Result (OK): > jest
 PASS src/user.test.ts … ...[22000 chars truncated]
```

Talking point: the summarizer sees only about 1,000 tokens of the 9,000. If the jest failure details are at the *end* of the log, the summary may miss them. That's exactly why the recovery tool exists.

**What gets stored as the summary content** (LLM text + footer, wrapped; `summary-refs.ts:54-69`). Example for turn 0:

```markdown
<context-prune-summary>
- **read** `src/auth.ts`: read the auth module (~300 lines).
  - `verifyToken()` checks `payload.exp < Date.now()`; `signToken()` sets `exp` in seconds.
- **bash** `npm test`: ran jest; 41 passed, **1 failed**.
  - Failing: `src/login.test.ts › login › rejects expired token`.

---
**Summarized tool refs**: `t1`, `t2`
Use `context_tree_query` with these refs to retrieve the original full outputs.
</context-prune-summary>
```

Turn 1 summary (refs `` `t3` ``): "**bash** `grep -rn token src/`: 23 matches; token expiry is compared in `src/auth.ts:42` and set in `src/session.ts:17`…"

Summarizer usage (illustrative): batch 0 ≈ 1,150 in / 180 out; batch 1 ≈ 650 in / 90 out. Footer `↑1.8k ↓270`.

### 4.4 What gets stored (session entries)

After the flush, the session branch gains these entries (each `{id, parentId, timestamp}` plus the fields below; pi: `session-manager.d.ts:17-22, 69-73, 97-103`):

```jsonc
// 1. custom_message: IS sent to the LLM (as a user-role message), hidden in the transcript
{ "type": "custom_message", "customType": "context-prune-summary", "display": false,
  "content": "<context-prune-summary>\n- **read** `src/auth.ts` …\n</context-prune-summary>",
  "details": {
    "toolCallRefs": [ { "shortId": "t1", "toolCallId": "toolu_01AuthRead" },
                      { "shortId": "t2", "toolCallId": "toolu_01NpmTest" } ],
    "toolNames": ["read", "bash"], "turnIndex": 0, "timestamp": 1789650000000 } }

// 2. custom: NOT sent to the LLM; this is the "vault" of originals
{ "type": "custom", "customType": "context-prune-index",
  "data": { "toolCalls": [
    { "toolCallId": "toolu_01AuthRead", "toolName": "read", "args": {"path":"src/auth.ts"},
      "resultText": "<full 12,000 chars>", "isError": false, "turnIndex": 0, "timestamp": 1789650000000 },
    { "toolCallId": "toolu_01NpmTest", "toolName": "bash", "args": {"command":"npm test"},
      "resultText": "<full 24,000 chars>", "isError": false, "turnIndex": 0, "timestamp": 1789650000000 } ] } }

// 3–4. the same pair for turn 1 (ref t3)

// 5. frontier: last attempted boundary
{ "type": "custom", "customType": "context-prune-frontier",
  "data": { "lastAttemptedToolCallId": "toolu_01Grep", "lastAttemptedToolName": "bash",
            "lastAttemptedTurnIndex": 1, "lastAttemptedTimestamp": 1789650004000,
            "attemptedBatchCount": 2, "attemptedToolCallCount": 3,
            "rawCharCount": 44000, "summaryCharCount": 1080, "outcome": "summarized" } }

// 6. stats snapshot (the last one wins on rebuild)
{ "type": "custom", "customType": "context-prune-stats",
  "data": { "totalInputTokens": 1800, "totalOutputTokens": 270, "totalCost": 0.001, "callCount": 2 } }
```

In-memory state: `index: Map{ toolu_01AuthRead→record, toolu_01NpmTest→record, toolu_01Grep→record }`, `aliasToToolCallId: Map{ t1→…, t2→…, t3→… }`, `nextShortAliasNumber: 4` (`indexer.ts:10-13`). Note that the original R1–R3 `toolResult` entries are **still in the session file, untouched**.

### 4.5 The `context` hook on request 4: before and after

Input `event.messages` is a deep copy of agent state (pi: `runner.js:793`). Output goes to `convertToLlm`, then the provider.

**Before (what Pi would send without the extension), ≈ 13,875 tokens**

| # | role | content | ≈ tok |
|---|---|---|---|
| — | (system + tools) | | 2,500 |
| 1 | user | Why is the login test failing? | 15 |
| 2 | assistant | text + toolCall `read` (toolu_01AuthRead) + toolCall `bash` (toolu_01NpmTest) | 60 |
| 3 | toolResult | toolu_01AuthRead: src/auth.ts contents | **3,000** |
| 4 | toolResult | toolu_01NpmTest: jest output | **6,000** |
| 5 | assistant | toolCall `bash` grep (toolu_01Grep) | 40 |
| 6 | toolResult | toolu_01Grep: grep matches | **2,000** |
| 7 | assistant | "The test fails because…" | 250 |
| 8 | user | OK, fix it. | 10 |

**After `pruneMessages`, ≈ 3,160 tokens (−10,715, ≈ 77% smaller)**

| # | role | content | ≈ tok |
|---|---|---|---|
| — | (system + tools) | | 2,500 |
| 1 | user | Why is the login test failing? | 15 |
| 2 | assistant | text + toolCall `read` + toolCall `bash` (**kept, so the IDs survive**) | 60 |
| ~~3~~ | ~~toolResult~~ | removed (`isSummarized("toolu_01AuthRead")`) | 0 |
| ~~4~~ | ~~toolResult~~ | removed | 0 |
| 5 | assistant | toolCall `bash` grep (kept) | 40 |
| ~~6~~ | ~~toolResult~~ | removed | 0 |
| 7a | custom → **user** | `<context-prune-summary>` turn 0 … refs `t1`,`t2` | ~180 |
| 7b | custom → **user** | `<context-prune-summary>` turn 1 … ref `t3` | ~90 |
| 7 | assistant | "The test fails because…" | 250 |
| 8 | user | OK, fix it. | 10 |
| + | toolResult ×3 (synthetic) | **added by pi-ai, not the extension**: orphaned tool calls get `{role:"toolResult", content:"No result provided", isError:true}` stubs so providers accept the history (pi-ai `dist/api/transform-messages.js:125-183`) | ~15 |

The filter itself is a single `messages.filter` (`src/pruner.ts:8-15`). The rows at 7a/7b show where summaries land when they're in context. Session delivery appends them right before A2 (see Step 6), and runtime/steer delivery appends them at the end of the current turn.

> **Caveat to check before saying this on stage (from reading Pi 0.85.1 source).** In **session delivery** (`agent-message`, `every-turn`), the summary is written only with `sessionManager.appendCustomMessageEntry` (`index.ts:192-193, 270`). That doesn't push into the running agent's in-memory `agent.state.messages`, which is what the `context` event receives (pi: `sdk.js:227-231`, pi-agent-core `agent.js:283`). Compare `sendMessage`'s `_appendCustomMessage`, which does both (pi: `agent-session.js:1134-1139`). Agent state is rebuilt from the session only on compaction, tree navigation, or session load (pi: `agent-session.js:1541, 1828, 2615`). So in the **same live process**, the raw results are removed at once, but the summary text may only show up after a resume/reload/tree navigation. The originals are still recoverable either way: the model still sees its tool calls, and `context_tree_query` takes the full IDs. The runtime/steer path (`on-context-tag`, `agentic-auto`) doesn't have this gap. Check with a live session (e.g. log `event.messages.map(m=>m.role)` in a scratch extension) before showing the "after" slide as literal.

### 4.6 Recovery: `context_tree_query`

**Schema** (`src/query-tool.ts:7-20`):

```ts
name: "context_tree_query",
label: "Query Original Tool History",
description: "Retrieve original tool call results that have been pruned from active context. Pass the short refs from a pruner-summary message to get back the full original outputs.",
promptSnippet: "Retrieve original pruned tool outputs by short ref",
promptGuidelines: ["When you need the full output of a tool call that was summarized and pruned from context, use context_tree_query with the short refs listed in the relevant pruner-summary message."],
parameters: Type.Object({
  toolCallIds: Type.Array(Type.String({ description: "One or more short refs or tool call IDs to retrieve" }),
                          { description: "List of short refs or toolCallIds to look up" }),
}),
```

**Example call** (request 4, the model wants the exact failure):

```json
{ "name": "context_tree_query", "arguments": { "toolCallIds": ["t2", "t9"] } }
```

**Result text** (`query-tool.ts:22-64`). `indexer.getRecord` resolves a full ID or an alias (`indexer.ts:88-100`). The body is `truncateHead` limited to 2,000 lines / 50 KB, with an `[Output truncated: X/Y lines shown]` note when it's cut.

```text
## toolRef: t2
Tool: bash
Args: {
  "command": "npm test"
}
Status: OK
Turn: 0

> jest
 PASS src/user.test.ts
 FAIL src/login.test.ts
  ● login › rejects expired token
    expect(received).toBe(expected)
    Expected: 401   Received: 200
      at src/login.test.ts:57:24
…(full 24,000 chars)

---

## toolRef: t9
(not found in index — may not have been summarized yet)
```

`details: { results: { t2: <ToolCallRecord> } }`. Note that the recovered 6,000 tokens come back as a **new** toolResult. At the next flush, that result is itself summarized and pruned (it gets a new ref such as `t4`).

---

## 5. Edge cases the code handles

| Edge case | Handling | Source |
|---|---|---|
| **Summary bigger than the original** | If `wrapped summary chars > sum(resultText.length)`, the batch is skipped: no summary message and no index entry, so the raw results stay in context. It still counts as "processed": stats are added and the **frontier advances** with `outcome:"skipped-oversized"`, so it isn't retried forever. Warning toast if `notifySkipped` is on: `pruner: skipped pruning turn N (…) — summary was X chars vs Y raw chars; frontier advanced past this range`. | `index.ts:245-248, 274-276, 304-314, 338-348`; `context-prune-tool.ts:92-102` |
| **Summarizer error** (auth, unknown provider, `stopReason:"error"`, exception) | `summarizeBatch` notifies `pruner: summarization failed: …` and returns `null`. `flushPending` stops at the first `null`, keeps the batches before it, and **restores** that batch and the rest to `pendingBatches`. If nothing succeeded it returns `summarizer-failed` and the frontier doesn't advance. | `summarizer.ts:90-101, 160-181`; `index.ts:237-243, 290-299` |
| **User cancels** (Esc during a `context_prune` tool call) | The abort signal propagates and is rethrown instead of being swallowed. `flushPending` restores the batches and returns `aborted` with no error toast. The tool replies "…prune frontier was not advanced. You can call context_prune again when ready." | `summarizer.ts:84-86, 140-159, 174-176`; `index.ts:170, 358-365`; `context-prune-tool.ts:71-79` |
| **Concurrent flushes** | The `isFlushing` flag returns `already-flushing`, and the queue is drained before the first `await`. | `index.ts:161, 175, 177, 371-373` |
| **Stale extension ctx** (print mode tearing down the session mid-flush) | `isStaleContextError` (message contains "This extension ctx is stale") → restore batches, return `stale-context`, and don't throw. `safeNotify` swallows stale errors. The `agent-message` path uses `session` delivery and grabs the SessionManager before awaiting. `agent_end` never starts LLM work. | `index.ts:69-80, 156-159, 181-189, 277-285, 366-368, 514-521` |
| **Frontier tracking** | `trimBatchToPendingRange`: (1) drop tool calls already in the index; (2) with a frontier, drop batches from earlier turns; (3) in the *same* turn as the frontier, keep only calls **after** `lastAttemptedToolCallId`. That handles agentic-auto pruning in the middle of a long tool chain and skipped-oversized ranges. | `index.ts:89-111`; `frontier.ts` |
| **Mid-turn partial results** | The session scan keeps only tool calls whose `toolResult` already exists in the branch, so later unresolved calls in the same assistant message aren't captured as `(no result)`. | `batch-capture.ts:110-134` |
| **Stable turn numbering** | The scan counts **every** assistant message in the branch (`turnCounter`), because pruning never removes assistant messages. The live `turn_end` path uses Pi's `event.turnIndex`, which resets at every `agent_start` (pi: `agent-session.js:470`). After the first prompt those two can differ. That only affects whether the *live* batch shows up in the "N pending" notice. The actual flush always re-scans the session. | `batch-capture.ts:78-105` |
| **Branching / session tree** | All state is rebuilt from `ctx.sessionManager.getBranch()` (root→leaf path only) on `session_start` and `session_tree`, and pending batches are discarded. If you go back to a point *before* a prune, the index on that branch doesn't have those IDs, so the raw results come back into context automatically. Custom entries are appended as children of the current leaf, so they belong to the branch they were created on. | `index.ts:394-431`; `indexer.ts:19-41`; pi `session-manager.d.ts:225-226` |
| **Short refs survive reloads** | Alias mappings live in the summary's `details.toolCallRefs` and are re-registered on rebuild. `nextShortAliasNumber` resumes at max+1. Legacy `details.toolCallIds` is still accepted. | `indexer.ts:36-39, 61-72`; `summary-refs.ts:34-52` |
| **Prompt cache** | (a) The default mode batches: one prefix rewrite per task. (b) Mode guidance ranks `every-turn` as worst ("busts provider prompt caches the most"). (c) The `<pruner-note>` goes on the **last** toolResult, per request, never persisted, so only the tail changes and role alternation holds. (d) The agentic-auto prompt says "calling context_prune after every 2–3 tool calls hurts prompt-cache efficiency". (e) `context` returns `undefined` when nothing changed. | `commands.ts:89-95, 216-224`; `reminder.ts:11-24, 69-87`; `types.ts:92`; `index.ts:557` |
| **Pruner's own tool** | `context_prune` results are never summarized (filtered at `turn_end` and excluded in the session scan). | `index.ts:454-457, 142` |
| **`enabled` default** | `DEFAULT_CONFIG.enabled = false`, so you have to opt in with `/pruner on`. Every hook checks `enabled` first. (The in-memory placeholder before `session_start` is `{...DEFAULT_CONFIG, pruneOn:"every-turn"}`, but it's still disabled and is replaced by `loadConfig()`.) | `types.ts:196-206`; `index.ts:43-45, 396` |
| **Settings persistence** | Global file `~/.pi/agent/context-prune/settings.json` (not per-project). `loadConfig` merges over the defaults and validates each field (invalid `pruneOn` or `summarizerThinking` fall back to defaults). Every `/pruner` change calls `saveConfig` right away. | `config.ts:8, 19-55`; `commands.ts:535, 571, 581, 654, 682, 700, 725` |
| **Session state persistence** | Index, frontier, and stats are `custom` entries (not in LLM context). Summaries are `custom_message` entries (in context). They are rebuilt on load, so pruning survives restarts. | `types.ts:47-57`; `stats.ts:80-103` |
| **Large recovery** | `truncateHead` with 2,000 lines / 50 KB. | `query-tool.ts:46-54` |
| **Summarizer input cap** | 2,000 chars per tool result, with `...[N chars truncated]`. | `batch-capture.ts:153-158` |
| **Doc vs code drift** | README/AGENTS.md say pending batches are summarized "in one LLM call". The code makes **one call per batch** (parallel, or sequential for `/pruner now`). `context_prune` tool text says "8–10" calls while the system prompt/reminder say "8–12". | `README.md` (on-context-tag section); `AGENTS.md:217`; `summarizer.ts:185-228`; `context-prune-tool.ts:47` vs `types.ts:90` |

---

## 6. User-facing commands and UI

`/pruner` (tab-completes subcommands, `commands.ts:368-370`). Bare `/pruner` opens a `ctx.ui.select` picker.

| Subcommand | What it does / shows | Source |
|---|---|---|
| `/pruner settings` | Overlay (width 60) with 8 items: Enabled, Prune status line, Startup notice, Prune trigger (cycles the 5 modes, each with a guidance description), Summarizer model (Enter opens a searchable submenu of `default` + `modelRegistry.getAvailable()`), Summarizer thinking, Remind unpruned count, Batching mode. Each change saves, updates the footer, and resyncs tool activation. | `commands.ts:388-566` |
| `/pruner on` / `off` | Toggles `enabled`, saves, toasts "Context pruning enabled./disabled.", updates the footer, syncs `context_prune` activation. | `:569-586` |
| `/pruner status` | Toast with enabled, model, thinking, trigger, batching, status/startup/remind flags, and summarizer calls/input/output/cost. | `:589-600` |
| `/pruner model [id[:thinking]]` | Shows the model, or sets it, e.g. `openai/gpt-5-mini:low`. | `:637-659`, parser `:119-137` |
| `/pruner thinking [level]` | `default, off, minimal, low, medium, high, xhigh`. | `:662-685` |
| `/pruner prune-on [mode]` | Picker or direct set. Saves, updates the footer, syncs tool activation. (No validation on the direct argument; `loadConfig` repairs invalid values on the next load.) | `:688-704` |
| `/pruner batching [turn\|agent-message]` | Picker or direct set, with validation. | `:707-728` |
| `/pruner stats` | `pruner stats: calls / input tokens / output tokens / cost`. | `:624-634` |
| `/pruner tree` | Foldable **TreeBrowser** overlay (80% × 70%). Root rows look like `[pruner] Turn 0 summary (2 tools · 720 chars · original 36.0k) · <time>`, and children look like `read(path="src/auth.ts") · 12.0k chars`, `bash(command="npm test") · 24.0k chars`. Keys: ↑/↓, Enter/Space expand, **Ctrl-O** opens the full summary in a scrollable bordered markdown overlay, Esc/q closes. | `commands.ts:603-621`; `tree-browser.ts:93-172, 213-248` |
| `/pruner now` | Works in every mode (needs `enabled`). Previews batches, opens a widget **above the editor** with one row per batch (`○ Batch 1/2 · 2 tool calls · pending` → spinner `⠹ Batch 1/2 · 2 tool calls · 412 summary chars / 36.0k raw chars` → `✓ …`), flushes **sequentially**, then toasts `pruner: pruned 3 tool calls from 2 batches — summary 1080 chars vs 44000 raw chars`. | `commands.ts:252-349, 731-788` |
| `/pruner help` | Full usage, mode guidance, and cache explanation. | `:178-230, 791-793` |

**Passive UI**
- Footer status (`setStatus`): `prune: OFF (On agent message)` → `prune: 1 pending` → `prune: summarizing…` → `prune: ON (On agent message) │ ↑1.8k ↓270 $0.001` (`commands.ts:49-68`).
- Toasts: startup notice, "N turns queued — will summarize on {trigger}", skipped-oversized warnings, errors.
- The `context_prune` tool box streams `Context prune running… batch 2/2 · 360 summary chars / 8.0k raw chars · 1 tool call` (`progress-text.ts:10-28`).
- Summary message renderer: `[pruner] Turn 0 summary (2 tools)` (`commands.ts:805-819`).

---

## 7. Slide-ready code excerpts (≤ 12 lines each; lightly trimmed, faithful)

**A. Hook registration: the whole extension is one function** (`index.ts:41-578`, bodies elided)

```ts
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => { /* load config, rebuild index */ }); // :394
  pi.on("session_tree",  async (_e, ctx) => { /* rebuild for new branch */ });     // :425
  pi.on("turn_end",      async (event, ctx) => { /* capture tool batch */ });      // :434
  pi.on("message_end",   async (event, ctx) => { /* agent-message flush */ });     // :507
  pi.on("context",       async (event) => { /* drop summarized results */ });      // :524
  pi.on("before_agent_start", async (event) => { /* agentic-auto prompt */ });     // :562
  registerQueryTool(pi, indexer);                                                  // :572
  registerContextPruneTool(pi, (ctx, o) => flushPending(ctx, { delivery: "runtime", ...o }));
  registerCommands(pi, currentConfig, flushPending, /* … */ indexer);             // :578
}
```

(Also `tool_execution_end` :495 and `agent_end` :517.)

**B. The context filter: the actual "pruning"** (`src/pruner.ts:8-15` + `index.ts:524-558`, trimmed)

```ts
export function pruneMessages(messages: any[], indexer: ToolCallIndexer): any[] {
  return messages.filter((msg) =>
    !(msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId)));
}

pi.on("context", async (event, _ctx) => {
  if (!currentConfig.value.enabled) return undefined;
  const pruned = pruneMessages(event.messages, indexer);
  if (pruned.length === event.messages.length) return undefined; // nothing changed
  return { messages: pruned };               // only this request; session untouched
});
```

**C. Capture at `turn_end`** (`index.ts:434-464`, trimmed)

```ts
pi.on("turn_end", async (event, ctx) => {
  if (!currentConfig.value.enabled) return;
  if (!event.toolResults?.length) return;            // text-only turn
  const batch = trimBatchToPendingRange(
    captureBatch(event.message, event.toolResults, event.turnIndex, Date.now()));
  if (!batch) return;
  pendingBatches.push(batch);
  if (currentConfig.value.pruneOn === "every-turn")
    await flushPending(ctx, { delivery: "session" });
});
```

Companion (`src/batch-capture.ts:24-47`, trimmed):

```ts
const toolCalls = content.filter((b) => b.type === "toolCall").map((block) => {
  const match = toolResults.find((r) => r.toolCallId === block.id);
  return {
    toolCallId: block.id,
    toolName: block.name,
    args: block.input ?? block.args ?? block.arguments ?? {},
    resultText: match ? match.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "(no result)",
    isError: match?.isError ?? false,
  };
});
```

**D. The recovery tool** (`src/query-tool.ts:7-27`, trimmed)

```ts
pi.registerTool({
  name: "context_tree_query",
  label: "Query Original Tool History",
  description: "Retrieve original tool call results that have been pruned from active context…",
  parameters: Type.Object({ toolCallIds: Type.Array(Type.String()) }),
  async execute(_id, params) {
    const blocks = params.toolCallIds.map((id) => {
      const r = indexer.getRecord(id);                 // "t2" → toolu_01NpmTest
      return r ? `## toolRef: ${id}\nTool: ${r.toolName}\n${r.resultText}` : `## toolRef: ${id}\n(not found…)`;
    });
    return { content: [{ type: "text", text: blocks.join("\n\n---\n\n") }] };
  },
});
```

**E (bonus). Summarize → store** (`index.ts:246-273`, trimmed)

```ts
const summaryRefs = indexer.allocateSummaryRefs(batch);                 // t1, t2
const summaryText = wrapSummaryForContext(result.summaryText + formatSummaryToolCallRefs(summaryRefs));
if (summaryText.length > batchRawCharCount) { oversizedBatches.push(batch); }  // don't make it worse
else if (delivery === "runtime") {
  pi.sendMessage({ customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false,
                   details: batchDetails }, { deliverAs: "steer" });
  indexer.registerSummaryRefs(summaryRefs);
  indexer.addBatch(batch, pi);                                          // pi.appendEntry(index)
} else { appendSummaryMessage(summaryText, batchDetails); /* …index via sessionManager */ }
```

**F (bonus). The side LLM call** (`src/summarizer.ts:88-128`, trimmed)

```ts
const model = resolveModel(config, ctx);                     // ctx.model or registry.find
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
const provider = ctx.modelRegistry.getProvider(model.provider);
const userMessage = SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serializeBatchForSummarizer(batch) + "\n</tool-call-batch>";
const stream = provider.stream(model,
  { messages: [{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }] },
  { apiKey: auth.apiKey, headers: auth.headers, signal, ...summarizerThinkingOptions(config) });
for await (const ev of stream) { /* report streamed chars */ }
const response = await stream.result();                    // → { summaryText, usage }
```

---

## 8. Visualisation storyboard

**Visual vocabulary (keep it the same across steps)**
- **Context window** (left, tall): a vertical stack of blocks. Height is proportional to tokens (1 px ≈ 20 tokens, so 6,000 tok = 300 px). Colors: system = slate, user = blue, assistant = violet (thin), toolResult = orange, summary = green, synthetic stub = grey hairline.
- **Token meter** (top of the stack): a horizontal bar plus a number for the next request's input tokens, with a faint 200k ceiling.
- **Event timeline** (bottom): pills `session_start · context · turn_end · message_end · context_tree_query`. The firing hook glows.
- **Pending tray** (middle right): small cards for queued `CapturedBatch`es.
- **Summarizer** (a side LLM icon, dashed box) appears only during a flush.
- **Vault** (right, "session file / index"): a lockbox with rows `t1 read src/auth.ts 12.0k chars`, and so on.
- **Footer ticker** (bottom right, monospace): mimics Pi's status line.

| # | On screen | Change from previous | Caption (≤8 words) | Speaker talking point |
|---|---|---|---|---|
| 1 | Empty stack: system 2,500 + user "Why is the login test failing?" 15. Meter **2,515**. Timeline: `session_start` then `context` glow. Footer `prune: ON (On agent message)`. | First frame. | Every request re-sends everything | "Pi builds this array before every LLM call. Extensions get a hook right here, called `context`." |
| 2 | Assistant block A0 with two tool chips `read`/`bash`. Orange blocks drop in: R1 3,000 and R2 6,000. Meter jumps to **11,575**. `turn_end` glows. A card `turn 0 · 2 calls · 36k chars` slides into the Pending tray. Toast "1 turn queued". | Stack grows 9k, first pending card. | Tool outputs pile up fast | "At `turn_end` we get the assistant message plus its tool results. We just capture them into a batch; nothing is summarized yet." Show the `CapturedBatch` JSON as an overlay. |
| 3 | A1 `grep` + R3 2,000 drop in. Meter **13,615**. Second pending card `turn 1 · 1 call · 8k`. `turn_end` glows again. Footer `prune: 2 pending`. | Third orange block, second card. | Queue, don't prune yet | "Why wait? Prompt caching. Every time you rewrite old context, the cache from that point on is gone. So we batch the whole task." |
| 4 | A2 violet text block "verifyToken compares seconds vs ms". `message_end` glows with a badge "final text: no tool calls". The Pending tray flashes. | Trigger fires. | Final answer triggers the flush | "The default `agent-message` mode flushes on the first assistant message with no tool calls. The agent is done using the raw outputs." |
| 5 | Both pending cards fly into two **parallel** Summarizer boxes. Each shows the prompt head "You are summarizing a batch of tool calls…" and a truncation ribbon "2,000 chars/result". Streaming counters `412 / 36.0k raw chars`. Footer `prune: summarizing…`. | Side LLM calls appear. | A cheap model writes the summaries | "One side call per batch, through the same provider registry Pi uses. You can point it at Haiku or Flash. Note it only sees the first 2,000 chars of each output." |
| 6 | Summarizer outputs green cards: S0 ~180 tok with badges `t1 t2`, S1 ~90 tok with `t3`. Original R1/R2/R3 are **copied** into the Vault as rows (`t1 read src/auth.ts 12.0k`, `t2 bash npm test 24.0k`, `t3 bash grep 8.0k`). Size check `720 < 36,000 ✓`. Frontier flag planted after `t3`. Footer `↑1.8k ↓270 $0.001`. | Vault fills, summaries exist. Stack **unchanged** (still 13,615). | Originals archived, nothing deleted yet | "We write custom entries to the session: summaries that the LLM can see, and an index that it can't. The session file still has every raw result." |
| 7 | User U2 "OK, fix it." Meter would be 13,875 (ghost bar). `context` glows. The three orange blocks **dissolve**. Green S0/S1 slide in. Grey hairline stubs appear under the tool calls ("No result provided", added by pi-ai). Meter animates **13,875 → 3,160**, with a "−77%" badge. | The big payoff. | One filter, 77% smaller request | "The entire pruning algorithm is one `filter` in `context`: drop toolResults whose ID is in the index. We return new messages for this request only." Show excerpt B. |
| 8 | The model emits `context_tree_query {toolCallIds:["t2"]}`. A beam from the chip to Vault row `t2`, then an orange block 6,000 tok flows back into the stack. Meter 3,160 → ~9,200. The timeline highlights the tool. | Recovery. | Lossy summary, lossless escape hatch | "The summary never saw line 57 of the jest output. So the model pages the original back in by its short ref: hot memory versus cold memory." Show excerpt D. |
| 9 | Split screen: same session with **every-turn** (left) vs **agent-message** (right). Cache-bust lightning bolts: left ⚡⚡ (after turns 0 and 1), right ⚡ (after the final answer). Meters show both end up small. | Comparison. | Same savings, fewer cache busts | "Both end up lean, but pruning every turn rewrites the prefix every turn. That's why the code calls it 'Debugging only'." |
| 10 | Wrap: the extension as a hooks diagram, with 8 `pi.on` + 2 tools + 1 command around a ~580-line `index.ts`, plus the `/pruner tree` screenshot mock (`[pruner] Turn 0 summary (2 tools · 720 chars · original 36.0k)`). | Zoom out. | Eight hooks, two tools, one command | "No fork of the agent. A capture hook, a filter hook, a side LLM call, and a tool. That's a harness feature." |

Keep these numbers identical in every frame: R1 3,000 / R2 6,000 / R3 2,000 tokens (12k / 24k / 8k chars); requests 2,515 → 11,575 → 13,615; next request 13,875 vs 3,160; refs t1/t2 (turn 0), t3 (turn 1); summarizer ↑1.8k ↓270.

### Extra interactive widgets

**Widget 1: "When does it flush?" mode switcher.** Tabs for the 5 `pruneOn` modes over a shared horizontal timeline of events: `U1 · T0(read,bash) · T1(grep) · T2(text) · U2 · T3(edit) · T4(bash test) · T5(text)`, plus optional `/pruner now` and `context_checkpoint` markers the viewer can drop in.
- `every-turn`: ✂ + ⚡ right after T0, T1, T3, T4 (the `turn_end` handler).
- `agent-message`: ✂ + ⚡ after T2 and T5 (`message_end`, final text).
- `on-context-tag`: ✂ only where the viewer drops a `context_checkpoint` marker (`tool_execution_end`). Show "requires pi-context".
- `on-demand`: ✂ only at a `/pruner now` marker. Pending counter grows otherwise.
- `agentic-auto`: the model decides. Show a `<pruner-note>N unpruned…</pruner-note>` counter above each tool turn and a ✂ where a "model calls context_prune" marker sits. Show a toggle "disciplined (every ~10 calls)" vs "eager (every 2 calls)".

Readouts per mode: summarizer calls, cache busts (⚡ count), peak request tokens, and a mini stacked area chart of per-request input tokens. Also a `batchingMode` toggle (`turn` / `agent-message`) that merges pending cards per user message and changes the ref labels (`t1,t2` + `t3` vs `t1,t2,t3`).

**Widget 2: savings slider.** Inputs: tool output tokens per task (default 11,000), summary tokens per task (default 270), requests per task (default 3), number of later requests N (slider 0–50), and a cache-hit toggle with a price per MTok for cached vs uncached input.
- Plot cumulative input tokens re-sent: no pruning `Σ (base + 11,000·k)` vs pruning `Σ (base + 270·k)`, where k = tasks completed.
- Shade summarizer cost (↑~1.8k ↓~270 per task) as a small overhead band.
- With the cache toggle on, add a "cache-bust penalty" at each prune point, to show why `agent-message` beats `every-turn` on dollars even though both save tokens.
- Hover shows "you would have re-sent the `npm test` log N times".

---

### Open questions / verify before the talk
1. **Session-delivery summary visibility in the live process** (4.5 caveat). Confirm with a 5-line debug extension that logs roles in `context` after an agent-message flush.
2. The exact size of the pi-ai synthetic "No result provided" stubs per provider (Anthropic/OpenAI both go through `transformMessages`). It's small, but worth a footnote.
3. The local `dist/index.js` (built Aug 29) is **older** than the last source change (commit `49f133e`, Sep 1, "respect skipped notifications"). It contains only 1 of the 2 `currentConfig.value.notifySkipped` checks. Run `npm run build` before a `pi -e .` demo from this checkout.
