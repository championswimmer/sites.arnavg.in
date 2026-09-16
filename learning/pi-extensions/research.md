# Pi extension talk — research and speaker prep

Checked against the three local extension repositories and Pi's published extension documentation on 17 September 2026. The deck is a speaker-led visual explanation; this file carries implementation detail intentionally left off the projected slides.

## The coding harness

A coding harness surrounds the model with a loop: take input, assemble instructions and conversation context, call a provider, stream the assistant's response, execute any requested tools, add their results, repeat until the agent stops, and record/render the session. Pi describes itself as a minimal terminal coding harness and offers extensions to change this behavior without editing the core.

Pi's [extension guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) documents an event timeline that includes input, before_agent_start, agent_start, turn_start, context, before_provider_request, message events, tool events, turn_end, agent_end, and session events. The slide's timeline is simplified: a real run can contain several turns; Pi also emits events not shown there.

An extension is a TypeScript module with a default factory receiving ExtensionAPI. It may register event handlers with pi.on, agent tools with pi.registerTool, user commands with pi.registerCommand, and UI via ctx.ui. Some hooks only observe; others allow a return value to modify context or a tool result or block a tool call. The exact contract belongs to each event. The official guide gives [locations and a quick start](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#quick-start). The local example repositories import the Pi package names used by their versions; avoid implying that one import path applies to every Pi release.

Suggested opening: click the harness stages on slide 2; click context, message_update, and tool_call on slide 5; let the audience answer the slide 7 question before clicking context.

## pi-context-prune

Source: [repository](https://github.com/championswimmer/pi-context-prune), especially [index.ts](https://github.com/championswimmer/pi-context-prune/blob/main/index.ts), [src/batch-capture.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/batch-capture.ts), [src/pruner.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/pruner.ts), [src/indexer.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/indexer.ts), [src/query-tool.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/query-tool.ts), and [README.md](https://github.com/championswimmer/pi-context-prune/blob/main/README.md).

The extension captures completed tool call/result pairs at turn_end. The capture code matches an assistant toolCall block's ID to the corresponding result's toolCallId, keeping tool name, arguments, result text, and error status. It can also scan the current session branch for unsummarized completed results before a flush.

By default the pruneOn setting is agent-message: after the agent's final text-only message, the message_end handler flushes pending batches. The enabled setting initially defaults to false; users must enable pruning. Other trigger modes include every-turn, on-context-tag, on-demand, and agentic-auto. The extension normally makes a summarizer provider call per batch (parallel for ordinary flushes; /pruner now runs them sequentially to show progress). It stores a compact summary with short references such as t1 and a session-backed index of originals.

At the context hook, [the filter](https://github.com/championswimmer/pi-context-prune/blob/main/src/pruner.ts) removes only a toolResult message whose toolCallId is marked summarized. The stored session transcript and assistant tool-call blocks remain. context_tree_query lets the model recover indexed original output using the short reference. If a summary is larger than the raw output, the implementation skips pruning for that range and advances its frontier rather than retrying indefinitely.

The deck's interactive states are raw → captured → summarized/indexed → smaller next request → recovered original. Sizes on slide 11 are illustrative, not benchmarks. A pruning policy affects prompt prefix caching: repeated changes to earlier context can reduce cache hits, which is part of the reason for the default end-of-agent-message trigger.

Suggested live Pi demonstration: run /pruner on and /pruner prune-on on-demand. Prompt Pi to produce a few large tool outputs. Then use /pruner now to show flush progress, /pruner tree to browse summaries and originals, and /pruner stats for token/cost figures. These commands are from [src/commands.ts](https://github.com/championswimmer/pi-context-prune/blob/main/src/commands.ts).

## pi-speedometer

Source: [repository](https://github.com/championswimmer/pi-speedometer), especially [src/index.ts](https://github.com/championswimmer/pi-speedometer/blob/main/src/index.ts) and [README.md](https://github.com/championswimmer/pi-speedometer/blob/main/README.md).

before_provider_request records performance.now() and resets per-request state. message_update filters for text, thinking, and tool-call content deltas. At the first delta it records time to first content (TTFT). It calculates output tokens per second from output tokens divided by time since that first delta, and throttles status updates to at most one every 250 ms. During streaming it uses provider-reported partial output token usage when positive; otherwise it estimates from accumulated content length at roughly four characters per token. message_end uses final output usage when available, then leaves the final result in ctx.ui.setStatus("speedometer", ...). agent_end and session_shutdown stop stream tracking. This extension does not register an agent tool.

The slide 15 numbers simulate a response, not measurement data. /speed reports settings or toggles TPS/TTFT and icon/text labels; settings persist globally. A useful question for the audience: “Is it slow before the first token, or while tokens are arriving?”

## pi-checklist

Source: [repository](https://github.com/championswimmer/pi-checklist), especially [src/index.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/index.ts), [src/tools.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/tools.ts), [src/store.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/store.ts), [src/commands.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/commands.ts), and [src/render.ts](https://github.com/championswimmer/pi-checklist/blob/main/src/render.ts).

The extension registers three model-callable tools: checklist_create, checklist_read, and checklist_update. It also registers /checklist for the person using Pi. Tool schemas and prompt guidance make the capability legible to the model; custom renderers make calls and results legible to the person. The display can be a footer, widget, or hidden.

The store supports planned, ongoing, done, and cancelled states. Done is terminal. Dependencies form an acyclic graph; a task cannot move to ongoing or done while dependencies are unfinished. An update batch is all-or-nothing, so the blocked transition on slide 18 leaves state unchanged. The diagram is a simulation of those rules, not a call into Pi.

On mutation, commit writes a snapshot with pi.appendEntry("pi-checklist", snapshot) and refreshes the UI. The same snapshot is returned in tool-result details. session_start and session_tree reconstruct the current branch by walking entries and using the latest valid snapshot. The checklist is branch scoped. Display preferences are stored globally. before_agent_start provides usage guidance and open tasks in the system prompt. turn_start, turn_end, and agent_settled control the end-of-turn widget's timing.

For a live demo, ask Pi to create a three-task checklist where task 2 depends on task 1. Open /checklist; show task IDs and the widget. Ask it to advance task 2 too early, then complete task 1 and retry. If time allows, branch with /tree and show the restored checklist state.

## Speaking and operation

- Reveal controls: right arrow or space advances; left arrow goes back; Escape opens the overview; S opens speaker notes.
- Slides 2, 5, 6, 8, 11, 13, 15, and 18 have controls intended for the presenter to click.
- The deck is 1280 × 720 and uses large display text. Detailed logic and caveats live here and in Reveal speaker notes.
- The deck intentionally says “important boundaries have hooks” rather than claiming literally every internal action has one.
- The three case studies illustrate distinct patterns: transform a future request, observe the stream, and add structured capability plus state.
