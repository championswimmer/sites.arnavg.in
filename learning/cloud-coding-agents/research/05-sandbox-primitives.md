# 05 — Sandbox primitives: Vercel, Cloudflare, E2B, Daytona, Fly, Modal, Railway

For **thousands of truly pausable coding-agent VMs** (RAM/process state preserved),
**E2B** and **Daytona VM sandboxes** are the cleanest fits. Others suit
stop/snapshot/restart patterns.

## Vercel Sandbox

- Primitive: `Sandbox.create()` / `get()` / `getOrCreate()`. Runtime: Firecracker microVMs, Ubuntu 26.04.
- Persistence: persistent by default — `stop()` auto-snapshots filesystem; Drives for mounts.
- Resume is **filesystem-only** (new session from snapshot), not RAM-preserving.
- Timeouts: 5 min default; max 45 min Hobby / 24 h Pro+; resets on resume.
- Pricing: active CPU + provisioned memory + creations + egress + snapshot/drive storage; up to 10k concurrent on Pro.
- Sources: https://vercel.com/docs/sandbox/concepts https://vercel.com/docs/sandbox/pricing

## Cloudflare Sandbox / Containers

- Primitive: `getSandbox(env.Sandbox, id, { sleepAfter, keepAlive })`; lazy start on first exec.
- Runtime: dedicated Linux container tied to a Durable Object.
- In-container state only while active; persistence via `createBackup`/`restoreBackup` to R2
  (default 3-day TTL; restored overlay disappears on next sleep) or `mountBucket()`.
- 10 min idle sleep default; `keepAlive` disables auto-sleep. No RAM-preserving resume.
- Billed every 10 ms; CPU active-use, memory/disk provisioned.
- Sources: https://developers.cloudflare.com/sandbox/api/lifecycle/ https://developers.cloudflare.com/sandbox/concepts/sandboxes/ https://developers.cloudflare.com/sandbox/guides/backup-restore/ https://developers.cloudflare.com/containers/pricing/

## E2B — best fit for pausable agent VMs

- Primitive: `Sandbox.create(...)` from template; `connect()` / auto-resume.
- Runtime: Firecracker microVMs, LTS 6.1 kernel.
- `pause()` saves **filesystem + memory** by default (`keepMemory:false` = fs-only); paused sandboxes kept indefinitely.
- True pause/resume, ~1 s resume; timeout action `kill` or `pause` + `autoResume`.
- Caps: 1 h Hobby / 24 h Pro continuous run (reset on resume). Pricing per-second while
  running; paused not billed. Concurrency: 20 Hobby, 100 Pro (→1,100), Enterprise tens of thousands.
- Sources: https://www.e2b.dev/docs https://docs.e2b.dev/sandbox/persistence https://e2b.dev/docs/faq/calculate-sandbox-price https://www.e2b.dev/pricing

## Daytona — very strong on VM sandboxes

- Primitive: `daytona.create()`; VM semantics via VM snapshot.
- Linux containers default + Linux VM / Windows sandboxes. VM sandboxes preserve fs on
  stop, memory on pause; hot snapshots/forks; volumes persist outside sandbox.
- VM auto-pause default 60 min; container auto-stop 15 min. No fixed max session cap documented.
- Pay-as-you-go reserved vCPU/RAM/disk; paused/stopped VMs bill disk only; archived containers stop billing.
- Sources: https://www.daytona.io/docs/en/sandboxes/ https://www.daytona.io/docs/en/persistence/ https://www.daytona.io/docs/en/billing/

## Fly Machines

- Primitive: `POST /v1/apps/{app}/machines`. Fast VMs; suspend via Firecracker snapshots.
- Suspend preserves full memory + rootfs; rootfs survives, Volumes independent.
- Resume in hundreds of ms; docs discourage suspend above 2 GB RAM and "suspending many at once".
- Running billed by CPU/RAM preset; suspended/stopped pay storage only (+ volumes).
- Sources: https://fly.io/docs/machines/guides-examples/managing-machines-with-the-api/ https://fly.io/docs/reference/suspend-resume/ https://fly.io/docs/about/pricing/

## Modal

- Primitive: `modal.Sandbox.create(...)`. Secure containers on gVisor by default.
- Filesystem/directory/memory snapshots; Volumes/NetworkFileSystems for durable data.
- Sandboxes **terminate** on timeout/idle (5 min default, up to 24 h); memory snapshots are
  restorable clones (7-day TTL); snapshotting currently terminates the sandbox.
- Billed per second at max(request, actual). Great for huge concurrency + snapshot-restart, not live paused RAM.
- Sources: https://modal.com/docs/guide/sandboxes https://modal.com/docs/guide/sandbox-snapshots https://modal.com/docs/guide/sandbox-networking.md https://modal.com/docs/guide/sandbox-resources.md

## Railway Sandboxes

- Primitive: `Sandbox.create()` — isolated Linux VM scoped to a Railway environment.
- Disk-oriented persistence via `checkpoint(name)` + `fork()`; **no live-memory pause/resume**.
- Idle timeout destroys sandboxes (30 min default, 120 min max or 0 to disable on Hobby/Pro; 5 min Trial).
- Per-second VM rates on memory-in-use, CPU-used, egress; caps 50/env Hobby, 100 Pro.
- Good for app-adjacent ephemeral workers, not thousands of pausable agent VMs.
- Sources: https://docs.railway.com/sandboxes https://docs.railway.com/pricing/plans
