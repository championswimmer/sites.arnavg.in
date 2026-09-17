# 06 — Railway sandboxes (deep brief, Sep 2026)

## Primitive

- `Sandbox.create()` makes a fresh sandbox, builds from a **sandbox template**, restores from a
  **checkpoint name**, or clones via `Sandbox.create(source)` (= `fork()`). Resolves when `RUNNING`.
  A sandbox is an **isolated Linux VM scoped to a Railway environment** on Railway's VM primitive.
- Networking is explicit: `ISOLATED` default (egress/NAT only); `PRIVATE` joins the environment's
  private network → the sandbox reaches project Postgres/Redis/internal APIs. Port forwarding +
  Railway HTTPS domains supported.
- Base image: docs surfaces disagree (clean Debian vs. git/Node/agents + Docker daemon since Jun 2026)
  — treat exact distro as UNVERIFIED; "Linux VM with dev tooling" is verified.
- **Sandbox templates** = ordered, content-addressed, cached build-step recipes (cache ~7 days).
  Distinct from the Template Marketplace for deployable app stacks.

## Lifecycle: create → checkpoint → fork → destroy

- **Create:** region-selectable via SDK; default `us-west2`. Regions: US West, US East, EU West, SE Asia.
- **Checkpoint:** `checkpoint(name)` captures a **named, server-side, bootable disk snapshot** from a
  **running** sandbox; synchronous, source keeps running, name reuse replaces. Preserves **files/disk,
  not processes/RAM**.
- **Fork:** needs source `RUNNING`; clones **filesystem** into a new sandbox, same env + region, boots
  fresh. No live processes/memory; does NOT inherit idle timeout, network mode, domains, env vars.
- **Destroy:** explicit or via idle timeout. Compute billing stops on destroy.

## Billing & caps

- Per-second **VM rates**: CPU actually used, memory in use (incl. OS + page cache), egress.
  Published VM rates: **$50/GB-month RAM, $50/vCPU-month, $0.05/GB egress**.
- Sizes: Trial/Free 2vCPU/2GB; Hobby 4/4 default, 8/8 max; Pro 8/8 default, 32/32 max.
- Idle timeout: Hobby/Pro 30 min default (1–120, 0 = off); Trial/Free 5 min (1–5, cannot disable).
  Active `exec`/SSH/port-forwarding keeps alive.
- Concurrency per environment: Trial/Free 10, Hobby 50, Pro 100, Enterprise 100+.

## Side-project story

- Solo-dev loop: create → configure/auth once → save **checkpoint** or **template** → one sandbox per
  task/agent/test/worker, `PRIVATE` net to dev DB, destroy when done. Railway's "Repo Review Agent"
  fans out one sandbox per agent from a repo-ready checkpoint. Hobby = indie-hacker plan.
- 2026 launches: sandboxes in dashboard/CLI/SDK (Jun 5), Docker + CLI checkpoints + port forwarding
  (Jun 12), preinstalled coding agents (Jun 24/26), `ssh sandbox@railway.new` (Jun 26).

## Limits (honest)

- **No documented live-RAM pause/resume** — checkpoint/fork are disk/filesystem-only.
- No official cold-start SLO or absolute max lifetime (UNVERIFIED).
- Sleep/wake ("Serverless") applies to **services, not sandboxes** (>10 min no outbound packets;
  wake on traffic; first request may 502).
- Sandbox GA formally UNVERIFIED (docs say every plan; changelogs said Priority Boarding).

## Sources

- https://docs.railway.com/sandboxes · https://docs.railway.com/guides/agents-in-sandboxes
- https://docs.railway.com/guides/code-execution-sandboxes · https://docs.railway.com/reference/pricing/plans
- https://docs.railway.com/deployments/serverless · https://docs.railway.com/deployments/regions
- https://railway.com/changelog/2026-06-05-sandboxes.md · https://railway.com/changelog/2026-06-12-docker-in-sandboxes.md
- https://railway.com/changelog/2026-06-26-railway-over-ssh.md · https://blog.railway.com/p/agents-in-the-sandbox
