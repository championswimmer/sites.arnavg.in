# 07 — Cloudflare primitives: the technology layer (Sep 2026)

## Durable Objects (the coordinator)

- A Durable Object = globally addressable actor: one object ID → one active single-threaded instance;
  all requests for that ID serialize on it. Hence "one sandbox, one owner".
- Storage is private, strongly consistent, transactional (SQLite-backed: SQL, KV, PITR to 30 days,
  implicit atomicity, input/output gates against interleaving bugs).
- **Alarms**: one per object, `setAlarm()`, at-least-once with backoff — the built-in "resume work later"
  primitive for the same owner.

## Sandbox lifecycle

- `getSandbox(env.Sandbox, id, { sleepAfter, keepAlive })`: Worker → Durable Object → container.
  Same ID = same sandbox; created lazily on first reference.
- Running: files, processes, shells, env survive. After **10 min idle default** → sleeps; next request
  starts a **fresh container**, container-local state gone.
- `keepAlive: true` heartbeats every 30s (persists across DO hibernation — must explicitly disable or
  `destroy()`). `destroy()` wipes `/workspace`, `/tmp`, `/home`, processes, sessions, ports.
- `createBackup()`: directory → compressed **squashfs** → **R2** (`backups/{id}/data.sqsh` + `meta.json`).
  Default TTL 3 days, enforced only at restore; expired objects linger until deleted/lifecycle-ruled.
- `restoreBackup()`: downloads from R2, mounts as **read-only lower layer with writable upper
  (FUSE overlayfs)**. Re-restore discards the upper layer; overlay vanishes on sleep/restart. Only
  externalized state (R2 objects + handles in KV/D1/DO storage) survives sleep.
- `mountBucket()`: mount Worker R2 / dev / S3-compatible buckets; `credentialProxy` keeps creds out
  of the container via DO request re-signing.

## Containers (the process plane)

- `Container` extends Durable Object: DO = stable routing/state plane, container = ephemeral Linux plane.
- Cold start picks nearest location with pre-fetched image; after stop/restart, placement may move.
  Each container runs in its own VM; all disk ephemeral.
- Sizes `lite` (1/16 vCPU, 256 MiB) → `standard-4` (4 vCPU, 12 GiB); account caps 6 TiB RAM / 1,500 vCPU /
  30 TB disk. Regional placement + `eu`/`fedramp` jurisdictions. Containers + Sandboxes GA Apr 2026.

## Object-storage substrate

- Backups = "freeze a tree, rehydrate later"; bucket mounts = "live external data". Restore is
  object-storage-speed (download + mount), not local-disk resume — no published restore-latency SLA.

## Billing

- Per-10ms while running; memory/disk on provisioned size, CPU on active use ($0.00002/vCPU-s;
  $0.0000025/GiB-s mem; $0.00000007/GB-s disk beyond included). R2 billed separately (no R2 egress fee).

## Sources

- https://developers.cloudflare.com/durable-objects/what-are-durable-objects/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/sandbox/api/lifecycle/ · https://developers.cloudflare.com/sandbox/concepts/sandboxes/
- https://developers.cloudflare.com/sandbox/concepts/architecture/ · https://developers.cloudflare.com/sandbox/api/backups/
- https://developers.cloudflare.com/sandbox/concepts/backup-restore/ · https://developers.cloudflare.com/sandbox/api/storage/
- https://developers.cloudflare.com/containers/concepts/architecture/ · https://developers.cloudflare.com/containers/platform/pricing/
- https://developers.cloudflare.com/containers/platform/limits/ · https://developers.cloudflare.com/r2/platform/pricing/
