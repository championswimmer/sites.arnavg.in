# Pi extension talk — research and speaker prep

Checked against the three local extension repositories and Pi's published extension documentation on 17 September 2026. The slides are there to support the talk. These notes hold the implementation details, demo commands, and caveats you'll want nearby.

## The coding harness

A coding harness runs the loop around the model. It takes your prompt, assembles instructions and conversation history, calls the provider, and streams the response. If the model asks to use a tool, the harness runs it and feeds the result back into the next request. It also saves the session and shows you what's happening. Pi describes itself as a minimal terminal coding harness; extensions let you change parts of that behavior without editing its core.

Pi's [extension guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) documents an event timeline that includes input, before_agent_start, agent_start, turn_start, context, before_provider_request, message events, tool events, turn_end, agent_end, and session events. The slide's timeline is simplified: a real run can contain several turns; Pi also emits events not shown there.

An extension is a TypeScript module whose default export is a function that receives ExtensionAPI. Use pi.on to listen for events, pi.registerTool to give the model a tool, pi.registerCommand to add a user command, and ctx.ui to show something on screen. What a handler can change depends on the event: some only let you observe, while others let you change context, modify a tool result, or block a tool call. The official guide gives [locations and a quick start](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#quick-start). Check import paths against the Pi version you're using; the example repositories reflect their own versions.

Suggested opening: click through the harness stages, then show context, message_update, and tool_call on the lifecycle slide. At “Where would you hook in?”, let the audience answer before clicking context.

## pi-context-prune

Source: [repository](https://github.com/championswimmer/pi-context-prune), especially [index.ts](https://github.com/championswimmer/pi-context-prune/blob/main/index.ts), [src/batch-capture.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/batch-capture.ts), [src/pruner.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/pruner.ts), [src/indexer.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/indexer.ts), [src/query-tool.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/query-tool.ts), and [README.md](https://github.com/championswimmer/pi-context-prune/blob/main/README.md).

The extension captures completed tool call/result pairs at turn_end. The capture code matches an assistant toolCall block's ID to the corresponding result's toolCallId, keeping tool name, arguments, result text, and error status. It can also scan the current session branch for unsummarized completed results before a flush.

By default the pruneOn setting is agent-message: after the agent's final text-only message, the message_end handler flushes pending batches. The enabled setting initially defaults to false; users must enable pruning. Other trigger modes include every-turn, on-context-tag, on-demand, and agentic-auto. The extension normally makes a summarizer provider call per batch (parallel for ordinary flushes; /pruner now runs them sequentially to show progress). It stores a compact summary with short references such as t1 and a session-backed index of originals.

At the context hook, [the filter](https://github.com/championswimmer/pi-context-prune/blob/main/src/pruner.ts) removes only a toolResult message whose toolCallId is marked summarized. The stored session transcript and assistant tool-call blocks remain. context_tree_query lets the model recover indexed original output using the short reference. If a summary is larger than the raw output, the implementation skips pruning for that range and advances its frontier rather than retrying indefinitely.

Click through the pruning demo in order: raw results, capture, summary and index, next request, then recovery. The sizes illustrate the idea; they aren't benchmark results. There's a caching tradeoff to explain aloud: changing earlier messages can reduce prompt-prefix cache hits. Batching summaries until the agent's final reply helps avoid changing that prefix after every turn.

Suggested live Pi demonstration: run /pruner on and /pruner prune-on on-demand. Prompt Pi to produce a few large tool outputs. Then use /pruner now to show flush progress, /pruner tree to browse summaries and originals, and /pruner stats for token/cost figures. These commands are from [src/commands.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/commands.ts).

## pi-speedometer

Source: [repository](https://github.com/championswimmer/pi-speedometer), especially [src/index.ts](https://github.com/championswimmer/pi-speedometer/blob/main/src/index.ts) and [README.md](https://github.com/championswimmer/pi-speedometer/blob/main/README.md).

before_provider_request records performance.now() and resets per-request state. message_update filters for text, thinking, and tool-call content deltas. At the first delta it records time to first content (TTFT). It calculates output tokens per second from output tokens divided by time since that first delta, and throttles status updates to at most one every 250 ms. During streaming it uses provider-reported partial output token usage when positive; otherwise it estimates from accumulated content length at roughly four characters per token. message_end uses final output usage when available, then leaves the final result in ctx.ui.setStatus("speedometer", ...). agent_end and session_shutdown stop stream tracking. This extension does not register an agent tool.

The timeline uses made-up numbers to show the calculation. /speed reports settings or toggles TPS/TTFT and icon/text labels; settings persist globally. Ask the audience: “Are we waiting for the response to start, or is it slow once it starts?”

## pi-checklist

Source: [repository](https://github.com/championswimmer/pi-checklist), especially [src/index.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/index.ts), [src/tools.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/tools.ts), [src/store.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/store.ts), [src/commands.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/commands.ts), and [src/render.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/render.ts).

The extension gives the model three tools: checklist_create, checklist_read, and checklist_update. It also adds /checklist for the person using Pi. Tool schemas and prompt instructions tell the model how to use the checklist; custom renderers show the calls and results to the user. You can show it in a footer or widget, or hide it.

Tasks can be planned, ongoing, done, or cancelled. Once a task is done, it stays done. Dependencies cannot contain cycles, and a task cannot become ongoing or done until its prerequisites are finished. Updates in a batch either all succeed or all fail. In the dependency demo, trying to start task 2 too soon therefore changes nothing. The diagram simulates the store's rules; it doesn't call Pi.

When the checklist changes, commit saves a snapshot with pi.appendEntry("pi-checklist", snapshot) and refreshes the UI. The tool result's details include that same snapshot. On session_start and session_tree, the extension walks the current branch and restores its latest valid snapshot. Each branch therefore has its own checklist, while display preferences are global. before_agent_start adds usage guidance and open tasks to the system prompt. turn_start, turn_end, and agent_settled control when the end-of-turn widget appears.

For a live demo, ask Pi to create a three-task checklist where task 2 depends on task 1. Open /checklist; show task IDs and the widget. Ask it to advance task 2 too early, then complete task 1 and retry. If time allows, branch with /tree and show the restored checklist state.

## Speaking and operation

- Reveal controls: right arrow or space advances; left arrow goes back; Escape opens the overview; S opens speaker notes.
- Slides 2, 5, 6, 8, 11, 13, 15, and 18 have controls intended for the presenter to click.
- The deck is 1280 × 720 and uses large display text. Detailed logic and caveats live here and in Reveal speaker notes.
- Keep the promise specific: Pi exposes hooks at useful points in the loop. That doesn't mean every internal action has a hook.
- Bring the three examples back to their jobs: change the next request, measure the response, and give the agent a checklist it can manage.
