# 01 — The pi harness, its agent loop, and the extension lifecycle

Research for the talk **"Building your coding harness"**. Verified against the locally installed **pi v0.85.1** on 2026-09-17.

**Path abbreviations used below**

| Short | Absolute path |
|---|---|
| `PKG/` | `/Users/championswimmer/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/` |
| `CORE/` | `PKG/node_modules/@earendil-works/pi-agent-core/dist/` |
| `AI/` | `PKG/node_modules/@earendil-works/pi-ai/dist/` |

Line numbers refer to the files as installed (`dist/*.js` is compiled JS, and the line numbers are real). The docs in `PKG/docs/` match v0.85.1. **Where the docs and the compiled source disagree, this file follows the source** (see the note in section 3).

---

## 1. What a coding harness is, as pi builds it

A **coding harness** is everything around the LLM that turns a chat model into an agent: the loop, the tools, the context, the session history, the UI, and the provider plumbing. pi describes itself this way:

> "Pi is a minimal terminal coding harness." (`PKG/README.md:15`, `PKG/docs/index.md:3`)

The default system prompt describes the same thing to the model:

> "You are an expert coding assistant operating inside pi, a coding agent harness." (`PKG/dist/core/system-prompt.js:81`)

### 1.1 The layers (npm packages)

| Layer | Package | Key files | Responsibility |
|---|---|---|---|
| Provider abstraction | `@earendil-works/pi-ai` | `AI/models.js` (`streamSimple`, `applyAuth`), `AI/api/anthropic-messages.js`, `openai-responses.js`, `openai-completions.js`, `google-*.js`, `bedrock-converse-stream.js`, … | Turns a provider-neutral `Context {systemPrompt, messages, tools}` into a provider HTTP request. Streams back a normalized `AssistantMessageEvent` stream: `start`, `text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end`, `done`, `error` (`AI/types.d.ts:410-463`). |
| Agent loop | `@earendil-works/pi-agent-core` | `CORE/agent-loop.js`, `CORE/agent.js` | Generic, UI-free loop: stream the assistant message, run tool calls, append results, repeat. Exposes hook points (`transformContext`, `convertToLlm`, `beforeToolCall`, `afterToolCall`, `onPayload`, `onResponse`, `prepareNextTurn`, steering/follow-up queues). |
| Coding agent | `@earendil-works/pi-coding-agent` | `PKG/dist/core/agent-session.js`, `sdk.js`, `session-manager.js`, `system-prompt.js`, `tools/*.js`, `compaction/*.js`, `extensions/{loader,runner,types}.js` | `AgentSession` connects the generic loop to the coding tools, JSONL sessions, compaction, retries, the system prompt, and the **extension runner**. |
| Terminal UI | `@earendil-works/pi-tui` + `PKG/dist/modes/interactive/` | `interactive-mode.js`, `components/tool-execution.js`, `components/footer.js` | Renders the transcript, the editor, the footer and widgets. Built-in slash commands live here. |
| Other front-ends | `PKG/dist/modes/print-mode.js`, `modes/rpc/`, `json-event.js`, SDK `createAgentSession()` | The same `AgentSession` without the TUI. |

### 1.2 The agent loop, step by step (real code path)

1. **User input**: `InteractiveMode` handles built-in commands (`/model`, `/tree`, `/compact`, `/reload`, … at `PKG/dist/modes/interactive/interactive-mode.js:2367-2496`). Anything else goes to `session.prompt(text)` (`:2523`).
2. **`AgentSession.prompt()`** (`PKG/dist/core/agent-session.js:821-955`):
   - Extension `/commands` are checked first (`_tryExecuteExtensionCommand`, `:830-837`).
   - The `input` event fires (`:841-852`).
   - Skills (`/skill:name`) and prompt templates are expanded (`:853-858`).
   - While streaming, the text is queued as steer or followUp (`:860-872`).
   - The model and auth are validated, with a pre-prompt compaction check (`:874-898`).
   - The user message is built, and `before_agent_start` runs (`:915`). It can add custom messages and override the system prompt (`:916-941`).
   - `_runAgentPrompt()` is called (`:772-786`).
3. **System prompt**: `buildSystemPrompt()` (`PKG/dist/core/system-prompt.js`) combines the tool snippets, guidelines, `AGENTS.md` context files, skills, cwd, and any `SYSTEM.md`/`APPEND_SYSTEM.md` overrides. It is cached as `_baseSystemPrompt` (`agent-session.js:671`, `738-767`).
4. **`Agent.prompt()` → `runAgentLoop()`** (`CORE/agent.js:226-274`, `CORE/agent-loop.js:43-57`) emits `agent_start` and `turn_start`, emits message events for the prompt messages, then calls `runLoop()`.
5. **`runLoop()`** (`CORE/agent-loop.js:78-171`): the inner `while (hasMoreToolCalls || pendingMessages.length > 0)`:
   - **Build context and call the provider** with `streamAssistantResponse()` (`:176-253`):
     - `transformContext(messages)` runs. This is pi's `context` extension event (`PKG/dist/core/sdk.js:227-232`).
     - `convertToLlm(messages)` turns pi-only message roles into LLM messages. For example, `custom` becomes `user` (`PKG/dist/core/messages.js:89-96`).
     - `streamFn(model, {systemPrompt, messages, tools})` runs. In pi this is `modelRuntime.streamSimple(...)` (`sdk.js:183-208`).
     - Inside pi-ai, `applyAuth` runs `transformHeaders` (`AI/models.js:372-373`), which is the `before_provider_headers` event.
     - The provider builds its payload and calls `onPayload` (the `before_provider_request` event), sends the HTTP request, then calls `onResponse` (the `after_provider_response` event). See `AI/api/anthropic-messages.js:378-393`.
   - **Streamed assistant message**: `start` becomes `message_start`; each delta becomes `message_update`; `done` or `error` becomes `message_end` (`agent-loop.js:199-240`).
   - **Tool calls**: `executeToolCalls()` (`:285-292`) runs in **parallel mode by default** (`CORE/agent.js:134`), and sequential mode is available if any tool sets `executionMode: "sequential"`. For each call:
     - `prepareToolCall` looks up the tool, runs `prepareArguments`, validates the arguments against the TypeBox schema, then calls `beforeToolCall`, which is the `tool_call` event (`:400-459`).
     - `executePreparedToolCall` runs `tool.execute(id, args, signal, onUpdate)`. Each `onUpdate` produces a `tool_execution_update` (`:460-490`).
     - `finalizeExecutedToolCall` calls `afterToolCall`, which is the `tool_result` event (`:491-525`).
   - **Tool results appended**: `createToolResultMessage` builds a `toolResult` message and emits `message_start/end` for it, then pushes it into the context (`:141-146`, `541-559`).
   - `turn_end` fires (`:147`).
   - If there were tool calls (and they did not all set `terminate`), the loop runs again. Before the next turn, `prepareNextTurn` runs, where pi may **auto-compact** (`agent-session.js:274-306`), and steering messages are polled.
6. **No more tool calls**: the follow-up queue is checked (`:161-166`). If it is empty, `agent_end` fires (`:170`).
7. **After the run** (`agent-session.js:772-819`): `_handlePostAgentRun()` may auto-retry a retryable error, compact on overflow or threshold and continue, or process messages queued by `agent_end` handlers. Finally `agent_settled` fires.

### 1.3 The surrounding pieces

- **Session storage / branching tree**: JSONL files under `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` (`PKG/docs/session-format.md:5-11`). Every entry has `id`/`parentId`, so one file holds a **tree**. `/tree` moves the leaf, `/fork` and `/clone` create new files (`session-format.md:306-318`, `README.md:256-271`). Messages are persisted on `message_end`, **after** extension handlers have run (`agent-session.js:383-399`). Entry types: `message`, `model_change`, `thinking_level_change`, `compaction`, `branch_summary`, `custom` (extension state, not in context), `custom_message` (extension message, in context), `label`, `session_info` (`session-format.md:187-305`). `buildSessionContext()` walks leaf→root to produce the LLM message list (`:320-342`).
- **Compaction**: triggers when `contextTokens > contextWindow - reserveTokens` (default reserve 16384). It keeps roughly `keepRecentTokens` (20k) and summarizes the rest into a `CompactionEntry` with `firstKeptEntryId` (`PKG/docs/compaction.md:27-80`). It runs between turns, before a new prompt, and after an agent run, and it recovers from overflow. Code: `PKG/dist/core/compaction/compaction.js`, `branch-summarization.js`.
- **Model/provider abstraction**: `ModelRuntime` / `ModelRegistry` choose the provider API (`anthropic-messages`, `openai-responses`, …). Every provider emits the same `AssistantMessageEvent` stream, so the loop and extensions never see provider-specific wire formats except through `before_provider_request`.
- **Tools**: `PKG/dist/core/tools/` has `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell` (`ToolName`, `tools/index.d.ts:23`). **Active by default: `read`, `bash`, `edit`, `write`** (`agent-session.js:2208-2210`). README: "By default, pi gives the model four tools: `read`, `write`, `edit`, and `bash`." (`README.md:91`). File-mutating tools share a per-file queue, `withFileMutationQueue`, because tool calls run in parallel.
- **TUI rendering**: `InteractiveMode` subscribes to `AgentSession` events (`interactive-mode.js:2553-2557`). **Extension handlers run before the TUI sees each event**: `_handleAgentEvent` awaits `_emitExtensionEvent(event)`, then notifies listeners (`agent-session.js:383-386`). Tool rows are rendered by `components/tool-execution.js`, which uses a tool's `renderCall`/`renderResult` when it has them.

---

## 2. Complete list of extension events (v0.85.1)

Source of truth: the `ExtensionAPI.on(...)` overloads in `PKG/dist/core/extensions/types.d.ts:907-942`. There are **36 events**. Payload interfaces are at `types.d.ts:387-777` and result types at `:814-874`. The dispatch logic lives in `PKG/dist/core/extensions/runner.js:623-1010`.

**General dispatch rules** (`runner.js`)
- Handlers run **sequentially in extension load order** and are **awaited**. A slow handler slows the loop, and that includes `message_update`.
- Each handler gets `(event, ctx: ExtensionContext)`. `ExtensionHandler<E, R> = (event, ctx) => Promise<R | void> | R | void` (`types.d.ts:902`).
- An error thrown by a handler is caught, reported through `emitError`, and the agent continues (`docs/extensions.md:2924`). **The exception is `tool_call`**: `emitToolCall` has no try/catch (`runner.js:745-763`), so a throw fails the tool call safely. It becomes an error tool result (`agent-loop.js:452-458`, `docs/extensions.md:2925`).
- For plain `emit()`, return values are ignored **except** for `session_before_*` events, where the last non-undefined result is kept and `{cancel:true}` short-circuits (`runner.js:617-653`).

### 2.1 Startup / resources

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `project_trust` | Startup, before project-local resources load, and when `/resume` enters an unresolved cwd. Only user/global and `-e` extensions participate. | `cwd`. `ctx` is a limited `ProjectTrustContext` (`cwd, mode, hasUI, ui.select/confirm/input/notify`). | **Required**: `{ trusted: "yes" \| "no" \| "undecided"; remember?: boolean }`. The first yes/no wins (`types.d.ts:387-402`). |
| `resources_discover` | After `session_start` (startup) and on `/reload` (`agent-session.js:1926-1933`) | `cwd`, `reason: "startup" \| "reload"` | `{ skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }`, merged across extensions (`runner.js:935-973`) |

### 2.2 Session events

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `session_start` | A session starts, loads, reloads, or is replaced | `reason: "startup" \| "reload" \| "new" \| "resume" \| "fork"`, `previousSessionFile?` | nothing |
| `session_info_changed` | `/name`, RPC, `pi.setSessionName()` (fire-and-forget, `agent-session.js:2453-2455`) | `name: string \| undefined` | nothing |
| `session_before_switch` | Before `/new` or `/resume` (`agent-session-runtime.js:80-90`) | `reason: "new" \| "resume"`, `targetSessionFile?` | `{ cancel?: boolean }` |
| `session_before_fork` | Before `/fork` or `/clone` (`agent-session-runtime.js:92-102`) | `entryId`, `position: "before" \| "at"` | `{ cancel?: boolean; skipConversationRestore?: boolean }` |
| `session_before_compact` | Before manual or auto compaction (`agent-session.js:1497`, `1758`) | `preparation: CompactionPreparation`, `branchEntries`, `customInstructions?`, `reason: "manual" \| "threshold" \| "overflow"`, `willRetry`, `signal` | `{ cancel?: boolean; compaction?: CompactionResult }` (supply your own summary) |
| `session_compact` | After compaction succeeds | `compactionEntry`, `fromExtension`, `reason`, `willRetry` | nothing |
| `session_compact_failed` | Compaction fails or is aborted | `reason`, `errorMessage?`, `aborted`, `willRetry`, `fromExtension` | nothing |
| `session_before_tree` | Before `/tree` navigation (`agent-session.js:2511`) | `preparation: TreePreparation {targetId, oldLeafId, commonAncestorId, entriesToSummarize, userWantsSummary, customInstructions?, replaceInstructions?, label?}`, `signal` | `{ cancel?; summary?: {summary, details?, usage?}; customInstructions?; replaceInstructions?; label? }` |
| `session_tree` | After tree navigation (`agent-session.js:2618`) | `newLeafId`, `oldLeafId`, `summaryEntry?`, `fromExtension?` | nothing |
| `session_shutdown` | Before a runtime is torn down: quit, `/reload`, new/resume/fork (`agent-session.js:2220`, `agent-session-runtime.js:107`, `298`) | `reason: "quit" \| "reload" \| "new" \| "resume" \| "fork"`, `targetSessionFile?` | nothing |

### 2.3 Input events (before the agent runs)

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `input` | After extension `/commands` are checked and before skill/template expansion (`agent-session.js:841-852`) | `text`, `images?`, `source: "interactive" \| "rpc" \| "extension"`, `streamingBehavior?: "steer" \| "followUp"` | `{action:"continue"}` \| `{action:"transform"; text; images?}` \| `{action:"handled"}`. Transforms chain; `handled` stops processing so no LLM call is made (`types.d.ts:669-677`, `runner.js:974-1008`). |
| `user_bash` | User runs `!cmd` or `!!cmd` in the TUI or RPC (`interactive-mode.js:5456`, `rpc-mode.js:442`) | `command`, `excludeFromContext`, `cwd` | `{ operations?: BashOperations; result?: BashResult }`. The first non-undefined result wins. |

### 2.4 Agent / turn events

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `before_agent_start` | After the prompt is expanded and **before** the loop starts (`agent-session.js:915`) | `prompt`, `images?`, `systemPrompt` (chained), `systemPromptOptions: BuildSystemPromptOptions` | `{ message?: {customType, content, display, details?}; systemPrompt?: string }`. Messages accumulate; the system prompt chains across handlers and applies **for this run only** (`runner.js:881-934`, reset at `agent-session.js:781` and `:937`). |
| `agent_start` | Start of a low-level run (`agent-loop.js:49`) | none | nothing |
| `turn_start` | Start of each turn. Turn 0 fires **before** the user message events (`agent-loop.js:50`); later turns fire after `prepareNextTurn` (`:109`) | `turnIndex`, `timestamp` | nothing |
| `turn_end` | After the assistant message and all its tool results (`agent-loop.js:147`) | `turnIndex`, `message` (assistant), `toolResults: ToolResultMessage[]` | nothing (custom messages queued here are flushed right after, `agent-session.js:449-451`) |
| `agent_end` | The low-level run ends (`agent-loop.js:170`) | `messages: AgentMessage[]` (all new messages from this run) | nothing. pi may still retry, compact, or continue afterwards. |
| `agent_settled` | Nothing left to run automatically: no retry, compaction, or queued follow-up (`agent-session.js:347-356`, `784`) | none | nothing |

### 2.5 Message events

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `message_start` | user, custom, assistant (on stream `start`), and toolResult messages | `message: AgentMessage` | nothing |
| `message_update` | Every assistant stream delta (`text_*`, `thinking_*`, `toolcall_*`) (`agent-loop.js:207-225`) | `message` (partial), `assistantMessageEvent` | nothing |
| `message_end` | A message is finalized, **before** it is persisted to JSONL | `message` | `{ message?: AgentMessage }` with the **same role**. It replaces the message in place, including in agent state and the session file (`runner.js:654-692`, `agent-session.js:510-526`). |

### 2.6 Tool events

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `tool_execution_start` | Per tool call, before arguments are prepared and validated (`agent-loop.js:333-338`) | `toolCallId`, `toolName`, `args` | nothing |
| `tool_call` | After `tool_execution_start` and schema validation, **before** `execute` (`agent-loop.js:412-436`, `agent-session.js:224-243`) | `toolName`, `toolCallId`, `input` (**mutable**: edit it in place to patch arguments). Narrow with `isToolCallEventType("bash", e)`. | `{ block?: boolean; reason?: string; terminate?: boolean }` (`types.d.ts:818-827`). The first `block` wins. A blocked call becomes an error tool result with `reason` as its text. |
| `tool_execution_update` | Each `onUpdate(partial)` from `execute` (`agent-loop.js:464-474`) | `toolCallId`, `toolName`, `args`, `partialResult` | nothing |
| `tool_result` | After `execute` finishes, before `tool_execution_end` (`agent-loop.js:494-513`, `agent-session.js:244-268`). **Only fires for executed calls**: not for blocked, not-found, or invalid-argument calls. | `toolName`, `toolCallId`, `input`, `content`, `details`, `isError`, `usage?` | `{ content?; details?; isError?; usage? }`, a partial patch chained like middleware (`types.d.ts:835-840`, `runner.js:693-744`) |
| `tool_execution_end` | The tool is finalized. In parallel mode this is in completion order. | `toolCallId`, `toolName`, `result`, `isError` | nothing |

### 2.7 Provider / context events (every LLM call)

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `context` | Before every LLM call, through `transformContext` and before `convertToLlm` (`agent-loop.js:179-183`, `sdk.js:227-232`) | `messages: AgentMessage[]`, a **deep copy** (`structuredClone`, `runner.js:793`) | `{ messages?: AgentMessage[] }`. Chained. Non-destructive: the session file is untouched. |
| `before_provider_headers` | Once per provider request, when auth headers are assembled (`AI/models.js:372`, `sdk.js:200-205`) | `headers: ProviderHeaders` | **Return value ignored.** Mutate `event.headers` in place; set a header to `null` to delete it (`types.d.ts:523-531`, `runner.js:852-880`). |
| `before_provider_request` | The provider-specific payload is built, just before it is sent (`AI/api/anthropic-messages.js:378-382`, `sdk.js:209-215`) | `payload: unknown` (for example, an Anthropic Messages body) | `unknown`: **any non-undefined value replaces the payload** for later handlers and for the real request (`runner.js:820-851`) |
| `after_provider_response` | The HTTP response arrives, before its stream is consumed (`anthropic-messages.js:393`, `sdk.js:216-226`) | `status`, `headers` | nothing |

### 2.8 Model and UI events

| Event | When it fires | Key payload | Can return |
|---|---|---|---|
| `model_select` | `/model`, Ctrl+P cycling, or restore (`agent-session.js:1238-1248`) | `model`, `previousModel`, `source: "set" \| "cycle" \| "restore"` | nothing |
| `thinking_level_select` | Thinking level changes (fire-and-forget, `agent-session.js:1373`) | `level`, `previousLevel` | nothing |
| `ui_prompt_start` | Around `ctx.ui.select/confirm/input/editor/custom`. Nested prompts are coalesced. Emitted through `queueMicrotask`, **not awaited** (`runner.js:283-314`). | `reason: "ui_prompt"`, `kind`, `title?` | nothing |
| `ui_prompt_end` | The outer prompt span closes | same | nothing |

**Events whose return value changes behaviour (14)**: `project_trust`, `resources_discover`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_before_tree`, `input`, `user_bash`, `before_agent_start`, `message_end`, `tool_call`, `tool_result`, `context`, `before_provider_request`. **By in-place mutation instead**: `before_provider_headers` (headers) and `tool_call` (`event.input`). The other 20 events are notification-only.

---

## 3. Exact firing order: one prompt, 2 tool calls, then a text answer (2 turns)

Scenario: interactive mode, idle agent. The user types `why is the test failing?`. In turn 0 the model calls `read` and `bash` in one assistant message. In turn 1 it answers in text. The default parallel tool execution applies.

Sources: `PKG/dist/core/agent-session.js` (prompt, hooks, mapping), `CORE/agent-loop.js` (loop), `CORE/agent.js` (`processEvents` awaits every listener in order, `:377-420`), `PKG/dist/core/sdk.js:176-232` (provider/context hooks), and `AI/models.js` plus `AI/api/*.js` (header → payload → response order).

> **Docs vs source**: the lifecycle diagram at `PKG/docs/extensions.md:285-313` puts `message_start/update/end` before the turn box and `turn_start` inside it. In the source, `turn_start` for turn 0 fires **before** the user message's `message_start/end` (`agent-loop.js:49-54`). Everything else in the diagram matches.

| # | Event | Notes / what an extension can do here |
|---|---|---|
| — | *(TUI: not a built-in command → `session.prompt()`)* | `interactive-mode.js:2367-2523` |
| — | *(extension `/command` lookup: no match)* | `agent-session.js:830-837` |
| 1 | **`input`** `{text, source:"interactive"}` | Can transform the text or mark it `handled` |
| — | *(skill/template expansion; model/auth check; compaction check on the previous assistant message, which could fire `session_before_compact`/`session_compact`)* | `:855-896` |
| 2 | **`before_agent_start`** `{prompt, systemPrompt, systemPromptOptions}` | Can inject a custom message or replace the system prompt |
| 3 | **`agent_start`** | `agent-loop.js:49` |
| 4 | **`turn_start`** `{turnIndex:0}` | `:50` |
| 5 | **`message_start`** `{role:"user"}` | `:52` |
| 6 | **`message_end`** `{role:"user"}` | Can replace the message. The user message is then written to JSONL. |
| 6a | *(`message_start`/`message_end` again for each custom message from step 2 or queued `nextTurn` messages)* | They are part of `prompts` (`agent-session.js:904-929`) |
| 7 | **`context`** `{messages}` (deep copy) | Can rewrite what the LLM sees. `convertToLlm` runs next. |
| 8 | **`before_provider_headers`** `{headers}` | Mutate headers |
| 9 | **`before_provider_request`** `{payload}` | Replace the payload |
| — | *(HTTP request sent)* | |
| 10 | **`after_provider_response`** `{status, headers}` | |
| 11 | **`message_start`** `{role:"assistant"}` (partial) | On stream `start` |
| 12 | **`message_update`** × N | `assistantMessageEvent.type`: `thinking_*`, `text_*`, `toolcall_start/delta/end` for `read`, then for `bash` |
| 13 | **`message_end`** `{assistant, stopReason:"toolUse"}` | Can replace it. Persisted. |
| 14 | **`tool_execution_start`** `{read}` | Preflight, in source order |
| 15 | **`tool_call`** `{toolName:"read", input}` | Can block or mutate input. The session is synced through the assistant message. |
| 16 | **`tool_execution_start`** `{bash}` | |
| 17 | **`tool_call`** `{toolName:"bash", input}` | |
| — | *(both `execute()` calls now run **concurrently**, `agent-loop.js:372`)* | |
| 18 | **`tool_execution_update`** × M `{bash, partialResult}` | Streaming bash output; can interleave across tools |
| 19 | **`tool_result`** `{read, content, details}` | Can patch the result |
| 20 | **`tool_execution_end`** `{read}` | |
| 21 | **`tool_result`** `{bash, …}` | 19–22 run in **completion order**, so bash could finish first |
| 22 | **`tool_execution_end`** `{bash}` | |
| 23 | **`message_start`** `{role:"toolResult", toolName:"read"}` | Result messages follow **assistant source order** |
| 24 | **`message_end`** `{toolResult read}` | Can replace it. Persisted. |
| 25 | **`message_start`** `{toolResult bash}` | |
| 26 | **`message_end`** `{toolResult bash}` | |
| 27 | **`turn_end`** `{turnIndex:0, message: assistant, toolResults:[read, bash]}` | Pending custom messages are flushed |
| — | *(`prepareNextTurn`: threshold auto-compaction check, which could fire `session_before_compact`/`session_compact`; the steering queue is polled)* | `agent-loop.js:89-108`, `agent-session.js:274-306` |
| 28 | **`turn_start`** `{turnIndex:1}` | `agent-loop.js:109` |
| 29 | **`context`** | Now includes both tool results |
| 30 | **`before_provider_headers`** | |
| 31 | **`before_provider_request`** | |
| 32 | **`after_provider_response`** | |
| 33 | **`message_start`** `{assistant}` | |
| 34 | **`message_update`** × K | `text_start`, `text_delta`…, `text_end` |
| 35 | **`message_end`** `{assistant, stopReason:"stop"}` | |
| 36 | **`turn_end`** `{turnIndex:1, toolResults:[]}` | No tool calls, so the inner loop exits |
| — | *(follow-up queue polled: empty)* | `agent-loop.js:161` |
| 37 | **`agent_end`** `{messages:[user, assistant₀, toolResult read, toolResult bash, assistant₁]}` | |
| — | *(`_handlePostAgentRun`: retry? overflow or threshold compaction? messages queued by `agent_end`? none)* | `agent-session.js:788-819` |
| 38 | **`agent_settled`** | `ctx.isIdle()` is true |

Counting only events: **38 named firings, plus N+K `message_update`s and M `tool_execution_update`s**.

**Variants worth knowing**
- **Sequential mode** (`toolExecution: "sequential"`, or any tool with `executionMode: "sequential"`): each tool runs its full block (`start → tool_call → updates → tool_result → end → message_start/end(toolResult)`) before the next tool starts (`agent-loop.js:293-329`).
- **Blocked call**: `tool_call` returns `{block:true}`. That call skips `execute` **and `tool_result`**, goes straight to `tool_execution_end` (isError), and the LLM receives `reason` as an error tool result (`agent-loop.js:426-436`, `341-351`).
- **Error or abort from the provider**: `message_end` with `stopReason: "error" | "aborted"`, then `turn_end`, then `agent_end` right away (`agent-loop.js:124-128`). pi may then auto-retry, which starts a new `agent_start…` sequence, before `agent_settled`.
- **Truncated output** (`stopReason: "length"`): tool calls get `tool_execution_start → tool_execution_end` with an error, and no `tool_call`/`tool_result` (`agent-loop.js:261-281`).

---

## 4. ExtensionAPI surface (`pi.*`) and ExtensionContext (`ctx.*`)

Declared in `PKG/dist/core/extensions/types.d.ts:906-1084` (`ExtensionAPI`), `:209-249` (`ExtensionContext`), `:254-291` (`ExtensionCommandContext`), and `:68-192` (`ExtensionUIContext`). The implementation is `PKG/dist/core/extensions/loader.js:208` (`createExtensionAPI`).

### 4.1 `pi` (passed to the factory)

| Method | Signature (short) | What it does |
|---|---|---|
| `pi.on(event, handler)` | 36 typed overloads | Subscribe to lifecycle events (section 2) |
| `pi.registerTool(def)` | `ToolDefinition<TParams extends TSchema, TDetails, TState>` | Adds an LLM-callable tool. It has `name, label, description, parameters` (a **TypeBox** schema), `execute(toolCallId, params, signal, onUpdate, ctx) → {content, details, usage?, terminate?}`, and optional `promptSnippet`, `promptGuidelines`, `prepareArguments`, `executionMode`, `renderCall`, `renderResult`, `renderShell`. It works at load time or later without `/reload`. Registering a built-in name (`read`, `bash`, …) **overrides** that tool (`docs/extensions.md:2080-2111`). Throw from `execute` to signal an error. |
| `defineTool(def)` | exported helper | Keeps parameter type inference for tools defined outside the call (`types.d.ts:386`, example `examples/extensions/hello.ts`) |
| `pi.registerCommand(name, {description?, getArgumentCompletions?, handler})` | `handler(args: string, ctx: ExtensionCommandContext) => Promise<void>` | Adds `/name` to the editor, with autocomplete. Duplicate names get `/name:1`, `/name:2`. |
| `pi.registerShortcut(keyId, {description?, handler(ctx)})` | | Adds a keyboard shortcut, for example `"ctrl+shift+p"` |
| `pi.registerFlag(name, {type:"boolean"\|"string", default?, description?})` / `pi.getFlag(name)` | | Adds a CLI flag, such as `pi --plan` |
| `pi.sendMessage({customType, content, display, details?}, {triggerTurn?, deliverAs?: "steer"\|"followUp"\|"nextTurn"})` | | Injects a **custom message** that is part of LLM context (sent as the `user` role) |
| `pi.sendUserMessage(content, {deliverAs?: "steer"\|"followUp", expandPromptTemplates?})` | | Sends a real user message and always triggers a turn |
| `pi.appendEntry(customType, data?)` | | Persists extension state in the session JSONL. **Not** sent to the LLM. Read it back with `ctx.sessionManager.getEntries()`. |
| `pi.registerMessageRenderer(customType, fn)` / `pi.registerEntryRenderer(customType, fn)` | | TUI rendering for custom messages and custom entries |
| `pi.registerMarkdownTransformer(fn)` | | Display-only rewrite of user and assistant markdown |
| `pi.setSessionName` / `getSessionName` / `setLabel(entryId, label)` | | Session metadata and `/tree` bookmarks |
| `pi.exec(cmd, args, opts?)` | `→ {stdout, stderr, code, killed}` | Runs a shell command |
| `pi.getActiveTools()` / `getAllTools()` / `setActiveTools(names)` | | Turns tools on or off at runtime, for example a read-only mode |
| `pi.getCommands()` | | Lists extension, prompt, and skill commands |
| `pi.setModel(model)` / `getThinkingLevel()` / `setThinkingLevel(level)` | | Model control |
| `pi.registerProvider(name, config)` / `registerProvider(provider)` / `unregisterProvider(name)` | | Adds or overrides an LLM provider (proxy, OAuth, custom stream) |
| `pi.events` | `EventBus` (`on`/`emit`) | Communication between extensions |

### 4.2 `ctx` (every handler, tool, and shortcut)

- `ctx.ui`: see 4.3
- `ctx.mode` (`"tui" | "rpc" | "json" | "print"`), `ctx.hasUI`, `ctx.cwd`
- `ctx.sessionManager`: read-only `SessionManager` with `getEntries()`, `getBranch()`, `buildContextEntries()`, `getLeafId()`, `getSessionFile()`, `getSessionId()`, `getLabel()` …
- `ctx.model`, `ctx.modelRegistry`, `ctx.scopedModels`, `ctx.thinkingLevel`
- `ctx.signal` (abort signal while a turn is active), `ctx.abort()`, `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.shutdown()`
- `ctx.getContextUsage()` → `{tokens, contextWindow, percent}`, `ctx.compact(opts)`, `ctx.getSystemPrompt()`, `ctx.isProjectTrusted()`

**Command-only** (`ExtensionCommandContext`, because these can deadlock inside event handlers): `waitForIdle()`, `newSession({setup, withSession})`, `fork(entryId, {position})`, `navigateTree(id, {summarize,…})`, `switchSession(path)`, `reload()`, `getSystemPromptOptions()`.

### 4.3 `ctx.ui` (`types.d.ts:68-192`)

| Kind | Methods |
|---|---|
| Dialogs (awaitable) | `select(title, options)`, `confirm(title, message)`, `input(title, placeholder?)`, `editor(title, prefill?)`. All accept `{signal?, timeout?}`. |
| Fire-and-forget | `notify(msg, "info"\|"warning"\|"error")`, `setStatus(key, text\|undefined)` (footer), `setWidget(key, string[] \| factory, {placement:"aboveEditor"\|"belowEditor"})`, `setTitle`, `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator({frames, intervalMs})`, `setHiddenThinkingLabel` |
| Full TUI | `custom(factory(tui, theme, keybindings, done), {overlay?, overlayOptions?})` (keyboard-focused component or overlay; Doom runs here), `setFooter(factory)`, `setHeader(factory)`, `setEditorComponent(factory)` (for example a vim editor extending `CustomEditor`), `addAutocompleteProvider`, `onTerminalInput` |
| Editor | `getEditorText`, `setEditorText`, `pasteToEditor` |
| Theme | `theme`, `getAllThemes`, `getTheme`, `setTheme`, `getToolsExpanded`, `setToolsExpanded` |

### 4.4 Renderers
- `renderCall(args, theme, context)` and `renderResult(result, {expanded, isPartial}, theme, context)` return a pi-tui `Component` (for example `new Text(...)`). `context` includes `state` shared between the two slots, `lastComponent`, `invalidate()`, `argsComplete`, `isPartial`, `isError`, and more (`types.d.ts:315-340`, `docs/extensions.md:2240-2317`).
- A tool that overrides a built-in and omits a renderer slot **inherits** the built-in renderer for that slot (`docs/extensions.md:2101`).

---

## 5. How extensions are loaded and installed

- **Auto-discovered locations** (`PKG/docs/extensions.md:115-121`, `PKG/dist/core/extensions/loader.js:569-634`):
  - `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts` (global)
  - `.pi/extensions/*.ts` and `.pi/extensions/*/index.ts` (project-local; **loaded only after the project is trusted**)
  - A subdirectory with a `package.json` that has a `"pi": {"extensions": [...]}` manifest (`loader.js:539-556`)
  - Discovery goes one level deep only.
- **Extra paths**: `settings.json` → `"extensions": [paths]` and `"packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"]` (`docs/extensions.md:122-135`).
- **Quick test**: `pi -e ./my-extension.ts` (also `pi -e npm:@foo/bar`, which installs to a temp dir for that run only, `docs/packages.md`).
- **Install packages**: `pi install npm:@foo/pi-tools[@ver]`, `pi install git:github.com/user/repo[@ref]`, `https://…`, `ssh://…`, or a local path. Also `pi remove`, `pi list`, `pi update --extensions`, and `pi config` to enable or disable resources. Add `-l` for a project-local install (`.pi/npm/`, `.pi/git/`). Global installs go to `~/.pi/agent/npm/` and `~/.pi/agent/git/` (`README.md:408-459`).
- **Package manifest**:
  ```json
  { "name": "my-pi-package", "keywords": ["pi-package"],
    "pi": { "extensions": ["./extensions"], "skills": ["./skills"], "prompts": ["./prompts"], "themes": ["./themes"] } }
  ```
  Without a `pi` key, pi auto-discovers the conventional `extensions/`, `skills/`, `prompts/`, `themes/` directories. Runtime dependencies go in `dependencies`, because installs use `npm install --omit=dev`. Core pi packages and `typebox` should be `peerDependencies: "*"` (`docs/packages.md:118-171`).
- **TypeScript without a build**: "Extensions are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation." (`docs/extensions.md:179`). `loader.js:409-429` calls `createJiti(..., { moduleCache: false, alias | virtualModules })`, then `jiti.import(path, {default: true})`. The default export must be a function (the factory), which can be sync or `async`, and pi awaits it.
- **Imports resolve to pi's own bundled copies** through jiti aliases (`loader.js:32-56`, `66-117`): `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` (compat entry), `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox` (+`/compile`, `/value`), and legacy `@sinclair/typebox` and `@mariozechner/*` aliases. A standalone `.ts` file in `~/.pi/agent/extensions/` needs **no `npm install`** to use these.
- **Reload**: `/reload` (or `ctx.reload()` from a command) emits `session_shutdown{reason:"reload"}`, invalidates the old runtime, clears the jiti extension cache (`resource-loader.js:263-267`), re-imports everything, and emits `session_start{reason:"reload"}` and `resources_discover{reason:"reload"}` (`agent-session.js:2217-2240`). This is a **manual hot reload: there is no file watcher**, so edit the file, type `/reload`, and the new code is live in the same session. The docs say: "Extensions in auto-discovered locations can be hot-reloaded with `/reload`." (`docs/extensions.md:7`)
- **Trust and security**: "Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust." (`docs/extensions.md:111`)
- **Load order** matters because handlers run in load order. `discoverAndLoadExtensions` adds project-local, then global, then configured paths (`loader.js:623-645`). In the resource-loader path, CLI `-e` extensions are merged before package/settings extensions (`resource-loader.js:414-420`).

---

## 6. Hello-world snippets (slide-ready, v0.85.1, each ≤ 10 lines)

All imports were checked against `PKG/dist/index.d.ts:7-8` (types plus `isToolCallEventType`, `defineTool`) and the jiti alias table. Drop any snippet into `~/.pi/agent/extensions/<name>.ts` and run `/reload`.

**(a) Block `rm -rf`** (`tool_call` → `{block, reason}`)
```ts
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event) && event.input.command.includes("rm -rf")) {
      return { block: true, reason: "rm -rf is not allowed here" };
    }
  });
}
```
*Why `isToolCallEventType`: `event.toolName === "bash"` does not narrow the union (`types.d.ts:797-799`). `BashToolInput = {command: string; timeout?: number}`.*

**(b) A footer status line on every turn** (`turn_end` + `ctx.ui.setStatus`)
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("turn_end", (event, ctx) => {
    const tools = event.toolResults.length;
    ctx.ui.setStatus("turns", `turn ${event.turnIndex + 1} · ${tools} tool calls`);
  });
}
```

**(c) Register a tool** (TypeBox schema; `details` is required in the result type)
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "roll_dice", label: "Roll dice", description: "Roll an N-sided die",
    parameters: Type.Object({ sides: Type.Number() }),
    async execute(_id, { sides }) {
      const n = 1 + Math.floor(Math.random() * sides);
      return { content: [{ type: "text", text: `Rolled ${n}` }], details: { n } };
    },
  });
}
```
*(11 lines including the import. For a 10-line version, drop the blank line. `import { Type } from "@earendil-works/pi-ai"` also works, as in `examples/extensions/hello.ts`, because pi-ai re-exports `Type`.)*

**(d) Register a `/command`**
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => ctx.ui.notify(`Hello ${args || "world"}!`, "info"),
  });
}
```

**(e) Rewrite context before every provider request** (`context` → `{messages}`, non-destructive)
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("context", (event) => ({
    messages: event.messages.map((m) => m.role !== "toolResult" ? m : {
      ...m, content: m.content.map((c) => c.type !== "text" ? c : { ...c, text: c.text.replace(/sk-[\w-]{10,}/g, "sk-***") }),
    }),
  }));
}
```
*It redacts API-key-looking strings from tool output before the model sees them. The JSONL session still holds the original text.*

**(f) Bonus: change the system prompt per run** (`before_agent_start` → `{systemPrompt}`)
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\n\nAlways answer like a pirate.",
  }));
}
```
*(A full toggle version is `PKG/examples/extensions/pirate.ts`.)*

**Real examples shipped in the package** (`PKG/examples/extensions/`): `hello.ts` (a 26-line tool), `permission-gate.ts`, `protected-paths.ts`, `status-line.ts`, `pirate.ts`, `input-transform.ts`, `provider-payload.ts`, `custom-compaction.ts`, `git-checkpoint.ts`, `todo.ts`, `plan-mode/`, `subagent/`, `snake.ts`, `doom-overlay/` (full table at `docs/extensions.md:2939-3023`).

---

## 7. Why pi is easy to extend

1. **Minimal core, and features are left out on purpose.**
   > "Pi is a minimal terminal coding harness. Adapt pi to your workflows, not the other way around, without having to fork and modify pi internals." (`PKG/README.md:15`)

   > "Pi ships with powerful defaults but skips features like sub agents and plan mode. Instead, you can ask pi to build what you want or install a third party pi package that matches your workflow." (`README.md:17`)

   > "Pi is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with extensions, skills, or installed from third-party pi packages. This keeps the core minimal while letting you shape pi to fit how you work." (`README.md:497`; the markdown link syntax is stripped here)

   > "**No permission popups.** Run in a container, or build your own confirmation flow with extensions inline with your environment and security requirements." (`README.md:503`)

   > "**No plan mode.** Write plans to files, or build it with extensions, or install a package." (`README.md:505`)

   > "**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way." (`README.md:501`)
2. **Every important boundary is an event.** There are 36 typed events covering input, prompt, context, headers, payload, response, stream deltas, tool call, tool result, message finalization, turns, compaction, and session tree moves. The core itself wires its hooks through the same seams (`beforeToolCall`, `afterToolCall`, `transformContext`, `onPayload` in `sdk.js`/`agent-session.js`), so extensions are not a bolted-on plugin layer.
3. **Plain TypeScript, no build step.** "Extensions are loaded via jiti, so TypeScript works without compilation." (`docs/extensions.md:179`) pi's own packages and `typebox` are aliased in, so a single `.ts` file works with no `npm install`.
4. **Everything is swappable**: tools (overriding `read`/`bash`), providers (`registerProvider`), the footer, header, and editor, the compaction summary, and bash execution (`user_bash`, tool `operations` for SSH or containers).
5. **No fork, and fast iteration**: drop a file in `~/.pi/agent/extensions/`, type `/reload`, and the change is live in the same session. Share it with `pi install npm:…` or `git:…`.
6. **The agent can write its own extensions.** The first line of the docs is "pi can create extensions. Ask it to build one for your use case." (`docs/extensions.md:1`). The system prompt points the model at its own docs: "When asked about: extensions (docs/extensions.md, examples/extensions/)…" (`dist/core/system-prompt.js`, inside the `You are an expert…` template).
7. **Safe by default for the hook author**: a crashing handler is logged and the agent continues. A crashing `tool_call` handler blocks the tool, so it fails safe (`docs/extensions.md:2922-2926`).

---

## 8. Visualisation ideas for slides

Each concept uses big-font labels (≤ 3 words where possible) and a clear sequence of presenter clicks.

### V1. Clickable agent loop, with hooks lighting up
- **Drawn**: a circular loop of 6 stage nodes: `Input` → `Prompt` → `Context` → `LLM call` → `Stream` → `Tools` → back to `Context`, with an exit arrow to `Done`. Around each node, dim hook "chips".
- **Clicks**: each click moves a glowing token to the next stage, and that stage's chips light up:
  - `Input`: `input`
  - `Prompt`: `before_agent_start`, `agent_start`
  - `Context`: `turn_start`, `context`
  - `LLM call`: `before_provider_request`, `after_provider_response`
  - `Stream`: `message_update`, `message_end`
  - `Tools`: `tool_call`, `tool_result`, `turn_end`
  - Loop back once (the "2nd turn" label appears), then exit to `Done`: `agent_end`, `agent_settled`
- **Labels**: stage names; chip names in monospace. Chips that **can change behaviour** get a small "✎" badge; observe-only chips get "👁" (or render as outline vs filled if emoji is unwanted).

### V2. "Hook radar": the event timeline for one real run
- **Drawn**: a horizontal timeline with swimlanes: `Agent`, `Turn`, `Message`, `Tool`, `Provider`. The 38 events from section 3 are dots, with `message_update` and `tool_execution_update` shown as dense tick marks.
- **Clicks**: (1) only agent/turn brackets show, as 2 turn boxes; (2) message dots appear (user, assistant, toolResult×2, assistant); (3) provider dots appear before each assistant message; (4) tool dots appear, with parallel bars overlapping for `read` and `bash`; (5) "writable" hooks pulse in accent color.
- **Labels**: `Turn 0`, `Turn 1`, `read ∥ bash`, `38 events`, `1 prompt`.

### V3. Before/after: a return value mutates state
- **Drawn**: split screen. The left panel is an event card (`tool_call {toolName:"bash", input:{command:"rm -rf dist"}}`). The right panel is the "what happens next" lane: `execute()` → `tool_result` → `LLM sees output`.
- **Clicks**: (1) the handler code slides in (snippet (a)); (2) `return {block:true, reason}` appears; (3) the right lane re-routes: `execute()` is crossed out, `tool_result` greys out, and a red toolResult card "rm -rf is not allowed here" flows to the LLM; (4) repeat with `context` → a redacted `sk-***` card; (5) repeat with `before_agent_start` → the system prompt gains a pirate line.
- **Labels**: `Event in`, `Return`, `New reality`, `Blocked`, `Redacted`, `Rewritten`.

### V4. Onion of layers: where your extension sits
- **Drawn**: concentric rings, innermost first: `pi-ai (providers)` → `agent-core (loop)` → `AgentSession (tools, sessions, compaction)` → `TUI / RPC / SDK`. Extension "plugs" pierce the rings at hook points.
- **Clicks**: highlight one ring at a time and show which hooks pierce it. `pi-ai` ring: `before_provider_headers`, `before_provider_request`, `after_provider_response`. Loop ring: `context`, `tool_call`, `tool_result`, `turn_*`. Session ring: `session_before_compact`, `session_tree`, `appendEntry`. UI ring: `ctx.ui.*`, `registerCommand`, `renderResult`.
- **Labels**: `Provider`, `Loop`, `Session`, `UI`, `Your .ts file`.

### V5. Session tree with extension state riding along
- **Drawn**: the JSONL tree: `user` → `assistant` → `toolResult` → … with one branch point, and `custom` entries (from `appendEntry`) as small diamonds and a `compaction` node as a folded card.
- **Clicks**: (1) a linear conversation grows; (2) `/tree` moves the leaf back, and a new branch grows (`session_before_tree` → `session_tree` flash); (3) diamonds on the active branch light up to show state rebuilt in `session_start`/`session_tree`; (4) a compaction folds older nodes into a summary card (`session_before_compact` lets you write the summary).
- **Labels**: `One file`, `Branches`, `Your state`, `Compaction`.

### V6. From zero to live in 3 steps (the extension workflow)
- **Drawn**: three big cards: `1. Write .ts`, `2. /reload`, `3. It's live`. Under each card is a terminal mockup.
- **Clicks**: (1) a snippet types itself into `~/.pi/agent/extensions/guard.ts`; (2) `/reload` flashes `session_shutdown` → `session_start{reason:"reload"}`; (3) the model tries `rm -rf`, and a red "Blocked" row appears in the TUI; (4) a bonus card: `pi install npm:your-pkg` → "share it".
- **Labels**: `No build`, `No fork`, `No restart`, `Ship via npm`.

---

## Appendix: quick fact sheet for speaker notes

- Version: `@earendil-works/pi-coding-agent@0.85.1` (`PKG/package.json`); bin `pi`; config dir `.pi` (`piConfig.configDir`).
- Events: 36. Behaviour-changing by return value: 14. By mutation: `before_provider_headers` and `tool_call.input`.
- Default tools: `read`, `bash`, `edit`, `write` (plus optional `grep`, `find`, `ls`, `powershell`).
- Default tool execution: **parallel** (preflight in source order, execute concurrently, result messages in source order).
- Handlers are awaited in load order; extension handlers run **before** the TUI renders the event and **before** JSONL persistence.
- `context` gets a `structuredClone` of the messages, so it is safe to mutate, and the session file never changes.
- `before_agent_start` system-prompt overrides last for one agent run and are reset in `_runAgentPrompt`'s `finally` (`agent-session.js:781`).
- Extensions load through jiti with `moduleCache: false`; `/reload` clears the cache. There is no file watcher.
