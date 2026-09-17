# 01 — How cloud coding agents work: the loop, code mode, MCP

## Architecture of one agent session

A cloud coding agent is not "LLM + diff". It is a long-lived session backed by a real
machine: repo checkout, shell, runtimes, network policy, tool adapters. The core loop is
closed-loop control:

1. **Provision** — clone repo/worktree, load instructions/rules/skills, wire built-in tools + MCP servers.
2. **Plan** — model decides what to inspect and how to approach the task.
3. **Act** — edit files, write/run code, invoke package managers, run tests/builds, call MCP tools.
4. **Observe** — harness returns stdout/stderr, exit codes, diffs, logs, screenshots.
5. **Repair / continue** — model updates plan, repeats until acceptance criteria pass.
6. **Handoff** — PR, patch, artifact, or status summary for review.

## Code mode

"Code mode" = the model may **write executable code or shell commands and run them**,
instead of only chatting or making tiny fixed tool calls. Code is a compact action
language: one script expresses loops, branching, retries, parsing, orchestration.

Why agents use it:
- Leverages model priors (bash, Python, Playwright, test runners already known).
- Token-efficient: one script replaces dozens of tool calls.
- Persistent state: shell/REPL preserves variables, files, servers across iterations.
- Composability: agent calls existing CLIs, compilers, linters instead of bespoke tools.

## MCP servers inside the VM

MCP servers are **tool adapters**: they expose docs, GitHub, databases, ticketing,
internal APIs as callable tools through a standard interface. A local MCP server is just
another process in/near the VM; a remote one is reached over HTTP. Because local MCP
servers share repo context, filesystem, and network, they need sandboxing too.

## Why lint / compile / test in-loop matters

Without in-loop verification, agents optimise for plausible-looking diffs, not working
software. Lint/typecheck catches static errors; build catches integration breakage;
tests/browser checks catch runtime failures. This prevents error compounding over long runs.

## Concrete examples

- Claude Code / on the web: sandboxed bash; cloud sessions in isolated sandboxes.
- OpenAI Codex cloud: durable sessions, managed harness, MCP support.
- Devin: shell + editor + browser in sandboxed compute.
- Cursor background agents: one isolated VM per agent, artifact capture.
- Jules: clones repo into a cloud VM, proposes plan, opens PR.
- Replit Agent: code-executed browser testing, long self-test loops.

## Sources

- https://www.anthropic.com/engineering/claude-code-sandboxing
- https://developers.openai.com/api/docs/guides/agents-api/overview
- https://cognition.com/blog/introducing-devin
- https://cursor.com/blog/agent-computer-use
- https://jules.google/
- https://replit.com/blog/automated-self-testing
