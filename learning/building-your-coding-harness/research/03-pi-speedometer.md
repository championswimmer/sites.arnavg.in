# 03 — pi-speedometer: watching the stream

Source (authoritative): `/Users/championswimmer/Development/Personal/LLM/pi-speedometer`
- `src/index.ts` (the entire extension, 233 lines)
- `package.json` (`@championswimmer/pi-speedometer` v0.1.3), `README.md`, `AGENTS.md`, `.agents/plans/001-*.md`, `002-speedometer-style-toggle.md`
- Repo: https://github.com/championswimmer/pi-speedometer — install: `pi install npm:@championswimmer/pi-speedometer`

Pi API checked against installed `@earendil-works/pi-coding-agent` **v0.85.1**:
`docs/extensions.md`, `dist/core/extensions/types.d.ts`, and bundled `@earendil-works/pi-ai` `dist/types.d.ts` + `dist/api/*.js`.

---

## 1. What it does and why it's useful

**One-line pitch:** A 233-line extension that puts a live speedometer for your LLM in pi's status bar: `⚡ 42.1 t/s ⏱ 412ms`.

**Plain-words definitions**
- **TTFT (time to first token)**: how long you stare at nothing. The clock starts when pi sends the request and stops when the first piece of the answer arrives. It covers network time, queueing at the provider and the model reading your whole prompt (prefill). A big context means a big TTFT.
- **TPS (tokens per second)**: how fast the answer comes out once it has started. Output tokens divided by the seconds since the first token. It shows how fast the model decodes.

**Why it's useful (the talk angle):** "Is it slow before the first token, or while tokens are arriving?" These are two different problems.
- High TTFT points to a huge context, a cold cache, a busy provider or a slow network.
- Low TPS points to a big or slow model, heavy thinking, or an overloaded endpoint.

You can compare models and providers on your real workload, inside your real harness, rather than trusting a benchmark page.

**Pattern it illustrates:** *observe the stream*. The extension doesn't change what the agent does. It only listens to lifecycle events and paints the UI.

**Provider nuance (README "Notes" + code header, `src/index.ts:14-16`):**
- Some providers stream a running (cumulative) output-token count: `partial.usage.output` grows during the stream. In that case live TPS is exact.
- OpenAI chat-completions sends usage only in the final chunk. Until then the extension estimates tokens as `chars / 4`, then snaps to the exact count at `message_end`.
- Google typically sends `usageMetadata` on every chunk (`pi-ai/dist/api/google-generative-ai.js:165-172`).

> **Verification caveat (Anthropic):** The README says Anthropic streams cumulative output counts mid-stream. In pi-ai's Anthropic adapter, though, `usage.output` is set only in two places:
> - from `message_start`: `output.usage.output = event.message.usage.output_tokens || 0` (`anthropic-messages.js:410`)
> - from `message_delta` (`:574-575`)
>
> The Anthropic API normally sends `message_delta` once, near the end of the stream, and `message_start` usually reports `output_tokens: 1`. If that holds, `tokenCount()` sees `usage.output = 1 > 0` for the whole stream and skips the chars/4 fallback. Mid-stream TPS would then read very low (for example `⚡ 3.8 t/s`) until `message_end` snaps it to the real value. **Check this with a live Claude run before claiming "exact live TPS on Anthropic" on stage.** The final number is correct either way.

---

## 2. Every hook / API used

All in `src/index.ts`. Imports are type-only from pi (`:19-20`) plus Node builtins (`:21-23`). There are no runtime dependencies and no build step: pi loads the `.ts` directly via jiti. `package.json` declares `"pi": { "extensions": ["./src/index.ts"] }`.

| API | Line | What the handler does |
|---|---|---|
| `export default function (pi: ExtensionAPI)` | 116 | Entry point. Loads settings (`:117`) and sets up per-call state in the closure. |
| `pi.on("before_provider_request", …)` | 144-151 | **Start the clock.** `requestStart = performance.now()`. Resets `firstDeltaTime=null`, `lastStatusUpdate=0`, `streaming=true`, `lastTokens=0`, `lastTtftMs=null`. Ignores `event.payload` and returns `undefined`, so the payload is unchanged. |
| `pi.on("message_update", …)` | 153-170 | **Watch tokens.** Ignores the event unless `streaming` is true and `event.assistantMessageEvent.type` is one of `text_delta`, `thinking_delta` or `toolcall_delta` (`CONTENT_DELTAS`, `:77`). On the first such delta it records `firstDeltaTime` and computes `lastTtftMs = now - requestStart`. Every delta: `lastTokens = tokenCount(streamEvent.partial)`. Calls `renderStatus` only if 250 ms have passed since the last write. |
| `pi.on("message_end", …)` | 172-184 | **Stop the clock.** Ignores non-assistant messages (`message_end` also fires for user and toolResult messages). Sets `streaming=false`. If `message.usage.output > 0`, snaps `lastTokens` to it. If no delta ever arrived (empty or errored stream), returns without rendering. Otherwise does a final, unthrottled `renderStatus(…, now)`. |
| `pi.on("agent_end", settle)` / `pi.on("session_shutdown", settle)` | 186-192 | `streaming=false; lastStatusUpdate=0`. Leaves the final numbers in the status bar. |
| `ctx.ui.setStatus(STATUS_KEY, text \| undefined)` | 141, 215, 225 | Writes the footer entry under key `"speedometer"` (`:78`). `undefined` clears it (when both metrics are off). Typed at `types.d.ts:80`: "Set status text in the footer/status bar. Pass undefined to clear." Works in TUI and RPC modes and does nothing in print/JSON mode (`docs/extensions.md:974`). |
| `pi.registerCommand("speed", { description, handler })` | 194-232 | The `/speed` command. The handler gets the raw `args: string` (`types.d.ts:896`) and parses it by hand. |
| `ctx.ui.notify(msg, "info" \| "warning")` | 200, 213, 223, 230 | Command feedback toasts. |

### State kept (closure variables, `:117-126`)
| Var | Meaning |
|---|---|
| `settings` | `{showTps, showTtft, tpsStyle, ttftStyle}`, loaded from disk |
| `requestStart` | `performance.now()` at `before_provider_request` |
| `firstDeltaTime` | `performance.now()` at the first content delta, or `null` |
| `lastStatusUpdate` | timestamp of the last throttled `setStatus` |
| `streaming` | guard flag: true between the request and `message_end`/`agent_end` |
| `lastTokens` | latest token count (exact or estimated), kept so `/speed` can re-render |
| `lastTtftMs` | computed TTFT, kept so `/speed` can re-render |

### Helpers
- `contentChars(message)` `:82-90`: sums `text.length`, `thinking.length` and `JSON.stringify(toolCall.arguments).length` over `message.content`.
- `tokenCount(message)` `:93-96`: returns `usage.output` if > 0, else `Math.ceil(chars / 4)`.
- `formatTps` `:98-100`: `≥100` gives an integer (`"123"`); otherwise one decimal (`"92.3"`).
- `formatMetricLabel` `:102-105`: icon style gives `⚡` / `⏱`; text style gives `TPS` / `TTFT`.
- `formatDuration` `:108-110`: `<1000` gives `"840ms"`; otherwise two decimals in seconds (`"1.23s"`).
- `renderStatus(ctx, tokens, ttftMs, endTime)` `:128-142`:
  - TPS part only if `showTps`, `firstDeltaTime !== null`, `durationSec > 0` and `tokens > 0`. Format: `` `${label} ${formatTps(tokens/durationSec)} t/s` ``
  - TTFT part only if `showTtft` and `ttftMs !== null`. Format: `` `${label} ${formatDuration(ttftMs)}` ``
  - Parts are joined with a single space; an empty result becomes `undefined`, which clears the entry.

### Where it sits in pi's lifecycle (`docs/extensions.md:280-310`)
Per turn:

`turn_start → context → before_provider_headers → before_provider_request → after_provider_response → message_start / message_update* / message_end → (tools) → turn_end`

The agent loops turns while the model calls tools. Each LLM call fires `before_provider_request` again, which re-anchors the clock, so the display always shows the *current* call (README Notes).

### Event payload shapes (exact, v0.85.1)
```ts
// dist/core/extensions/types.d.ts:519
interface BeforeProviderRequestEvent { type: "before_provider_request"; payload: unknown }
// return undefined = keep payload; return anything else = replace it

// :597
interface MessageUpdateEvent { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
// :603
interface MessageEndEvent { type: "message_end"; message: AgentMessage }   // user | assistant | toolResult
```

`AssistantMessageEvent` (`pi-ai/dist/types.d.ts:410-463`) is a discriminated union. Every variant except `done`/`error` carries `partial: AssistantMessage` (the message so far):

| type | extra fields | counted by speedometer? |
|---|---|---|
| `start` | — | no |
| `text_start` | `contentIndex` | no |
| `text_delta` | `contentIndex, delta: string` | **yes** |
| `text_end` | `contentIndex, content: string` | no |
| `thinking_start` | `contentIndex` | no |
| `thinking_delta` | `contentIndex, delta: string` | **yes** |
| `thinking_end` | `contentIndex, content: string` | no |
| `toolcall_start` | `contentIndex` | no |
| `toolcall_delta` | `contentIndex, delta: string` (partial JSON args) | **yes** |
| `toolcall_end` | `contentIndex, toolCall: ToolCall` | no |
| `done` | `reason: "stop"\|"length"\|"toolUse"\|"deferred", message` | no |
| `error` | `reason: "aborted"\|"error", error: AssistantMessage` | no |

`AssistantMessage.usage: Usage` (`types.d.ts:265-285`) has fields `input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost{…}`. `output` already includes reasoning tokens.

Implications:
- A **thinking** token counts as the "first token" for TTFT, so TTFT here means "first sign of life", not "first visible answer text".
- Tool-call argument streaming also counts toward TPS.

---

## 3. Walkthrough: one streamed response (invented, realistic timings)

**Scenario:**
- t = 0: `before_provider_request`.
- First `text_delta` at **840 ms**; after that a delta every **20 ms** until the last one at 4180 ms, giving 168 deltas.
- `message_end` at **4200 ms** with `usage.output = 310`.
- Tokens arrive evenly, about 1.85 per delta.
- Times are relative to `requestStart`. In reality `performance.now()` is milliseconds since the process started, so `lastStatusUpdate = 0` makes the first delta always pass the throttle check.

Default settings (both on, icon style).

### Step by step

**t = 0 — `before_provider_request` (`:144-151`)**
`requestStart = 0`, `firstDeltaTime = null`, `lastStatusUpdate = 0`, `streaming = true`, `lastTokens = 0`, `lastTtftMs = null`.
The status bar still shows the previous call's final value, or nothing. The handler doesn't clear it.

**t = 0 → 840 ms — nothing counted.**
`message_update` events of type `start` / `text_start` may fire. They aren't in `CONTENT_DELTAS`, so the handler returns at `:156`.

**t = 840 ms — first `text_delta`**
- `firstDeltaTime = 840`; `lastTtftMs = 840 - 0 = 840`.
- `lastTokens = tokenCount(partial)`: about 2.
- Throttle: `840 - 0 ≥ 250`, so render with `endTime = 840`.
- TPS: `durationSec = (840 - 840)/1000 = 0`, so the `durationSec > 0` guard **skips TPS** (no divide by zero).
- TTFT: `formatDuration(840)` gives `"840ms"`.
- **Status: `⏱ 840ms`**, with TTFT alone for one frame.

**t = 860 … 1080 ms**: deltas update `lastTokens`, but `now - 840 < 250`, so there's no render.

**t = 1100 ms — 14th delta, first throttled render** (1100 − 840 = 260 ≥ 250; deltas land on a 20 ms grid, so renders happen every 260 ms)
- Exact path (usage streamed): tokens = 26. `26 / 0.26 = 100.0`, and `formatTps` switches to integer at ≥100. **Status: `⚡ 100 t/s ⏱ 840ms`**
- Fallback path (no mid-stream usage; say ~7 chars/delta, so 98 chars): `ceil(98/4) = 25`, `25 / 0.26 = 96.15`. **Status: `⚡ 96.2 t/s ⏱ 840ms`**

The TTFT part stays frozen at 840ms from here on. Only TPS moves.

### Render table (every 260 ms)

| t (ms) | delta # | exact tokens | TPS exact → status | chars | chars/4 est | TPS est → status |
|---|---|---|---|---|---|---|
| 840 | 1 | 2 | (skipped) `⏱ 840ms` | 7 | 2 | (skipped) `⏱ 840ms` |
| 1100 | 14 | 26 | 26/0.26 → `⚡ 100 t/s ⏱ 840ms` | 98 | 25 | `⚡ 96.2 t/s ⏱ 840ms` |
| 1360 | 27 | 50 | 50/0.52 → `⚡ 96.2 t/s ⏱ 840ms` | 189 | 48 | `⚡ 92.3 t/s ⏱ 840ms` |
| 1620 | 40 | 74 | `⚡ 94.9 t/s ⏱ 840ms` | 280 | 70 | `⚡ 89.7 t/s ⏱ 840ms` |
| 2140 | 66 | 122 | `⚡ 93.8 t/s ⏱ 840ms` | 462 | 116 | `⚡ 89.2 t/s ⏱ 840ms` |
| 2660 | 92 | 170 | `⚡ 93.4 t/s ⏱ 840ms` | 644 | 161 | `⚡ 88.5 t/s ⏱ 840ms` |
| 3180 | 118 | 218 | `⚡ 93.2 t/s ⏱ 840ms` | 826 | 207 | `⚡ 88.5 t/s ⏱ 840ms` |
| 3700 | 144 | 266 | `⚡ 93.0 t/s ⏱ 840ms` | 1008 | 252 | `⚡ 88.1 t/s ⏱ 840ms` |
| 3960 | 157 | 290 | `⚡ 92.9 t/s ⏱ 840ms` | 1099 | 275 | `⚡ 88.1 t/s ⏱ 840ms` |
| 4180 | 168 (last) | 310 | no render (4180−3960 = 220 < 250) | 1176 | 294 | no render |

That is 13 `setStatus` calls for 168 deltas.

**t = 4200 ms — `message_end` (`:172-184`)**
- The message is an assistant message and `streaming` is true, so set `streaming = false`.
- `message.usage.output = 310 > 0`, so `lastTokens = 310`. This is the **snap to exact**; in the fallback scenario, OpenAI's final usage chunk also provides 310.
- `firstDeltaTime` isn't null, so do an unthrottled render with `endTime = 4200`.
- TPS = `310 / ((4200 − 840)/1000) = 310 / 3.36 = 92.26`, shown as `"92.3"`.
- **Final status: `⚡ 92.3 t/s ⏱ 840ms`**. It stays there after the turn.
- In the estimate path the live value (88.1) jumps to 92.3. If a provider never reports usage, the display stays estimated: `ceil(1176/4) = 294`, `294/3.36 = 87.5`, shown as `⚡ 87.5 t/s ⏱ 840ms`.
- Duration runs to `message_end`, not to the last delta, so the 20 ms of trailing time is included.

**Then `agent_end`** → `settle()`. If the model had called a tool, the next LLM call's `before_provider_request` would re-anchor everything, and the new call's first frame would again be just `⏱ …`.

### Formatting variants (same final moment)
| Settings | Status string |
|---|---|
| default (both on, icon) | `⚡ 92.3 t/s ⏱ 840ms` |
| `/speed tps text`, `/speed ttft text` | `TPS 92.3 t/s TTFT 840ms` |
| `/speed tps off` | `⏱ 840ms` |
| `/speed ttft off` | `⚡ 92.3 t/s` |
| both off | entry cleared (`setStatus("speedometer", undefined)`) |
| slow provider, TTFT 1234 ms | `⚡ 92.3 t/s ⏱ 1.23s` |
| fast provider, 350 t/s | `⚡ 350 t/s ⏱ 210ms` |

Note that `t/s` is always present, even in text style (`TPS 92.3 t/s`).

### Anthropic caveat applied to this timeline
If `message_start` reported `output_tokens: 1` and no `message_delta` arrives until the end, mid-stream tokens = 1. The display would read `⚡ 3.8 t/s` at 1100 ms and `⚡ 0.3 t/s` at 3960 ms, then jump to `⚡ 92.3 t/s` at `message_end`. Verify live (see §1).

---

## 4. Settings, `/speed`, persistence

- **File:** `~/.pi/agent/pi-speedometer.json` (`:44`)
- **Shape:** `{ "showTps": true, "showTtft": true, "tpsStyle": "icon", "ttftStyle": "icon" }`. Defaults are at `:38-43`.
- **Load** (`:50-62`): happens once, at extension load (`:117`). Each field is validated separately: a non-boolean falls back to the default, and `coerceStyle` accepts only `"icon"` or `"text"`. A missing or corrupt file gives the defaults.
- **Save** (`:64-71`): `mkdirSync(recursive)` then pretty JSON plus a newline. Best effort: write errors are swallowed.
- **Scope:** global, the same for every project and session. It isn't stored in the session.

| Command | Effect (handler `:196-231`) |
|---|---|
| `/speed` | `notify("pi-speedometer: tps=on(icon) ttft=on(icon)")` |
| `/speed tps on\|off` | Toggle TPS, save, `notify("pi-speedometer: tps off")`, re-render right away |
| `/speed ttft on\|off` | Same for TTFT |
| `/speed tps icon\|text` | Set the label style, save, notify, re-render |
| `/speed ttft icon\|text` | Same |
| anything else | `notify("Usage: /speed [tps\|ttft] [on\|off\|icon\|text]", "warning")` |

- Arguments are lowercased and split on whitespace (`:197`).
- Re-render condition: if `lastTokens > 0 || lastTtftMs !== null`, call `renderStatus(ctx, lastTokens, lastTtftMs, performance.now())`; otherwise clear the entry.

> **Small gotcha worth knowing (not necessarily for stage):** the re-render after `/speed` passes `performance.now()` as `endTime` (`:214`, `:224`), not the time the stream ended. Suppose you toggle `/speed ttft text` 60 s after a response finished: TPS gets recalculated as `310 / 63.36 s`, shown as `⚡ 4.9 t/s`. The fix is to store `endTime` at `message_end`. This is a nice "even tiny extensions have edge cases" aside, and a one-line PR.

---

## 5. Size: "this is tiny"

- `src/index.ts`: **233 lines total**. Without blank and comment lines: **166**.
- The extension function itself (`:116-233`, all hooks, rendering and the command) is **~98 code lines**.
- Of that, settings load/save is ~45 lines and the `/speed` command is ~40. The actual measurement logic (the three hooks plus `renderStatus`) is **about 55 lines**.
- The whole repo is **one source file** plus `package.json` (23 lines). No dependencies, no build.

Slide line: **"TTFT + TPS for every provider pi supports: one file, ~230 lines, zero dependencies."**

---

## 6. Slide-ready code excerpts (faithful; tabs → 2 spaces)

### A. The skeleton: every hook in ~15 lines (bodies elided)
```ts
// src/index.ts:116-194 (bodies elided)
export default function (pi: ExtensionAPI) {
  let requestStart = 0;
  let firstDeltaTime: number | null = null;

  pi.on("before_provider_request", () => { /* start the clock */ });

  pi.on("message_update", (event, ctx) => { /* first delta → TTFT; tokens → TPS */ });

  pi.on("message_end", (event, ctx) => { /* snap to exact usage, final render */ });

  pi.on("agent_end", settle);
  pi.on("session_shutdown", settle);

  pi.registerCommand("speed", { description: "…", handler: async (args, ctx) => { /* … */ } });
}
```

### B. Start the clock — `src/index.ts:144-151`
```ts
pi.on("before_provider_request", () => {
  requestStart = performance.now();
  firstDeltaTime = null;
  lastStatusUpdate = 0;
  streaming = true;
  lastTokens = 0;
  lastTtftMs = null;
});
```

### C. First delta → TTFT, throttled render — `src/index.ts:153-170` (12 lines, comment dropped)
```ts
pi.on("message_update", (event, ctx) => {
  const streamEvent = event.assistantMessageEvent;
  if (!streamEvent || !CONTENT_DELTAS.has(streamEvent.type)) return;
  const now = performance.now();
  if (firstDeltaTime === null) {
    firstDeltaTime = now;
    lastTtftMs = now - requestStart;
  }
  lastTokens = tokenCount(streamEvent.partial);
  if (now - lastStatusUpdate >= THROTTLE_MS) {
    lastStatusUpdate = now;
    renderStatus(ctx, lastTokens, lastTtftMs, now);
  }
});
```
(For the slide, the `if (!streaming) return;` guard, the `as AssistantMessageEvent | undefined` cast and the `requestStart > 0 ? … : null` guard are simplified away. Mention "simplified" in small type, or use the verbatim version below.)

Verbatim core, `:158-163`:
```ts
const now = performance.now();
if (firstDeltaTime === null) {
  firstDeltaTime = now;
  lastTtftMs = requestStart > 0 ? now - requestStart : null;
}
lastTokens = tokenCount(streamEvent.partial);
```

### D. Token count with fallback — `src/index.ts:93-96`
```ts
function tokenCount(message: AssistantMessage): number {
  if (message.usage && message.usage.output > 0) return message.usage.output;
  return Math.ceil(contentChars(message) / 4);
}
```

### E. TPS computation + `setStatus` — `src/index.ts:128-142` (lightly trimmed to 12 lines)
```ts
function renderStatus(ctx, tokens: number, ttftMs: number | null, endTime: number) {
  const parts: string[] = [];
  if (settings.showTps && firstDeltaTime !== null) {
    const durationSec = (endTime - firstDeltaTime) / 1000;
    if (durationSec > 0 && tokens > 0)
      parts.push(`${formatMetricLabel("tps", settings.tpsStyle)} ${formatTps(tokens / durationSec)} t/s`);
  }
  if (settings.showTtft && ttftMs !== null)
    parts.push(`${formatMetricLabel("ttft", settings.ttftStyle)} ${formatDuration(ttftMs)}`);

  ctx.ui.setStatus("speedometer", parts.length > 0 ? parts.join(" ") : undefined);
}
```
(The original uses a `label` local plus braces, and `STATUS_KEY` rather than the literal `"speedometer"`. Semantics are identical.)

### F. Stop the clock — `src/index.ts:172-184` (trimmed)
```ts
pi.on("message_end", (event, ctx) => {
  const message = event.message;
  if (!message || message.role !== "assistant") return;
  streaming = false;
  const now = performance.now();
  if (message.usage && message.usage.output > 0) lastTokens = message.usage.output;
  if (firstDeltaTime === null) return;
  renderStatus(ctx, lastTokens, lastTtftMs, now);
});
```

---

## 7. Visualisation storyboard: "Race the stream"

**Layout (16:9):**
- **Top band:** a horizontal timeline from 0 to 4.5 s, with hook markers that drop in as they fire.
- **Middle:** the "token track". Token chips (short words like `Sure`, `,`, ` here`, `'s`, ` the`, ` fix`) spawn at the right edge on each delta and slide left into a growing response line. A big stopwatch sits top right.
- **Bottom:** a mock pi footer, a dark bar with `~/project · main · claude-…`, plus the speedometer entry on the right: `⚡ … t/s ⏱ …`.
- **Side mini-panel ("under the hood"):** the four state variables `requestStart`, `firstDeltaTime`, `tokens`, `lastStatusUpdate`, lighting up as they change.

Drive the whole thing with the §3 numbers. Real time works fine: it is only 4.2 s, and a replay button helps. You can also add a 0.25× slow-mo toggle.

**Fidelity notes for the simulation:**
- Emit `message_update` events shaped `{ type: "text_delta", contentIndex: 0, delta: " the", partial: {…} }`.
- Optionally start with 3–4 `thinking_delta`s (grey chips) to show that thinking counts toward TTFT.
- Include non-counted `start` / `text_start` events as faint ghost ticks at about 830 ms that don't stop the stopwatch.
- Render the footer only on throttled ticks: 840, 1100, 1360 … 3960, then 4200. The chips move every 20 ms, but the footer text visibly changes only about 4 times per second. That mismatch *is* the throttling lesson.
- Toggle "provider streams usage" on/off: on uses exact counts, off shows the chars/4 estimate (the live numbers in the right-hand columns of the table) with a visible snap at `message_end`.

### States

| # | State | Caption (≤8 words) | What's on screen | Speaker notes |
|---|---|---|---|---|
| 1 | **Idle / request sent** (t=0) | "Request leaves. Stopwatch starts." | Prompt bubble flies off-screen. Timeline marker **`before_provider_request`** drops at 0. `requestStart = 0` lights up. Stopwatch starts. Footer shows the old value, dimmed. | "pi fires `before_provider_request` right before the HTTP call. It's meant for inspecting or rewriting the payload, but we just use it as a starting gun: one line, `performance.now()`." |
| 2 | **The wait** (0→840 ms) | "Nothing yet. This is TTFT." | Empty token track with a pulsing cursor. A shaded bar grows along the timeline, labelled "TTFT". Faint ghost ticks for `start`/`text_start` get ignored with a small "not content" tag. | "This dead air is network, queueing and the model reading your 80k-token context. Big contexts and cold caches live here. Note that the events that arrive with no content don't count." |
| 3 | **First token** (840 ms) | "First delta: TTFT locked at 840ms." | First chip `Sure` lands. Marker **`message_update · text_delta`** at 840. `firstDeltaTime = 840`. Footer snaps to **`⏱ 840ms`**, with no TPS yet. | "First content delta, which can be text, thinking or tool-call args. We freeze TTFT. There's no TPS yet because zero seconds have passed, and the code guards against divide-by-zero, so for one frame you see only the stopwatch." |
| 4 | **Tokens flowing** (840→4180 ms) | "Tokens pour in; footer updates 4×/sec." | Chips stream every 20 ms and a token counter climbs. A small "tick" flashes on each 260 ms render. Footer goes `⚡ 100 t/s ⏱ 840ms`, then `⚡ 96.2`, `⚡ 94.9` … `⚡ 92.9`. Optional split: the "usage off" row shows `⚡ 96.2`, `⚡ 92.3` … `⚡ 88.1` with an "≈ chars/4" badge. | "Deltas arrive about 50 times a second. Repainting the footer that often is waste, so we throttle to 250 ms. TPS is tokens divided by the time since the first token. Some providers tell us the token count live. Others, like OpenAI chat completions, don't, so we guess about four characters per token." |
| 5 | **message_end** (4200 ms) | "Stream ends. Snap to exact: 92.3." | Marker **`message_end`** at 4.2 s. Stopwatch stops. Counter flips to "310 (exact)". The estimate row visibly jumps 88.1 → 92.3. Footer: **`⚡ 92.3 t/s ⏱ 840ms`**, which stays there. | "`message_end` gives us the real usage. 310 tokens over 3.36 seconds is 92.3 t/s. The final number stays in the status bar after the turn, so you can glance at it any time." |
| 6 | **Tool loop + /speed** (optional) | "Next call re-anchors. Configure with /speed." | Model calls a tool, a new `before_provider_request` marker appears, and the footer resets to `⏱ 1.12s`. Then someone types `/speed tps text` and the footer becomes `TPS 88.0 t/s TTFT 1.12s`. Code overlay: "3 hooks + 1 command = 233 lines". | "Every LLM call in an agent loop fires the hook again, so the numbers are always for the current call. There's a `/speed` command for toggles and labels, saved to one JSON file. That's the whole extension: three event hooks, one `setStatus`." |

### Timeline graphic (static fallback / final frame)
```
t=0            840ms                                        4180  4200ms
│               │ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ │
before_         message_update (text_delta #1)                  message_end
provider_request   ↑ renders @ 840, 1100, 1360 … 3960 (every 260ms)   ↑ final render
└──── TTFT = 840ms ┘└──────── generation = 3.36s ──────────────────────┘
                     TPS = 310 / 3.36 = 92.3 t/s
Footer: ⏱ 840ms → ⚡ 100 t/s ⏱ 840ms → … → ⚡ 92.9 t/s ⏱ 840ms → ⚡ 92.3 t/s ⏱ 840ms
```

### Audience hook question
"Your agent feels slow. Is it slow **before** the first token or **while** tokens arrive?" Two numbers answer that, and one small extension gives you both.
