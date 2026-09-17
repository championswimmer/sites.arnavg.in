# 08 — Enterprise sandbox services: pause/resume + pricing (Sep 2026)

Rule of thumb: **true suspend/resume with RAM = E2B, Daytona VM sandboxes, Fly Machines suspend**.
Vercel = filesystem persistence across sessions. Modal = terminate + explicit snapshot/restore.

| Platform | Survives pause | Resume claim | Idle timeout / max life | Parked cost | Concurrency |
|---|---|---|---|---|---|
| Vercel Sandbox | FS + config (persistent); resume = **new session**, not live RAM | ms boot; snapshot resume "even faster", no SLA | 5 min default; max 45 min Hobby, 24 h Pro/Ent; snapshots 30 d TTL | snapshot storage $0.08/GB-mo | 10 / 10k / 10k |
| Daytona | container stop = FS only; **Linux VM/Windows pause = RAM + FS + processes**; GPU deleted on stop | "milliseconds", no numeric SLA | container/GPU auto-stop 15 min; VM auto-pause 60 min; archive after 7 d stopped | stopped/paused = disk only; archived free | pool-based, no fixed count |
| E2B | default pause = **RAM + FS + processes**; `keepMemory:false` = FS-only | **~1 s resume**; pause ~4 s/GiB RAM | SDK default 5 min; kill or pause on timeout; max 1 h Hobby, 24 h Pro; paused kept indefinitely | **paused free** | 20 / 100–1,100 / 1,100+ |
| Fly Machines | **suspend = full VM incl. RAM/rootfs**; stop = cold | few hundred ms from suspend; cold ~2 s+ | proxy stops/suspends on no traffic + spare capacity; no fixed timeout | $0.15/GB-mo rootfs + volumes | UNVERIFIED cap |
| Modal | no native pause; explicit FS snapshot or experimental memory snapshot into a **new** sandbox | boot in seconds; no pause SLA | default max 5 min, up to 24 h; FS snapshot TTL 30 d, memory 7 d | terminated = no bill | 100+10GPU / 5000+50GPU / custom |

## Pricing dimensions

- Vercel: $0.128/CPU-hr active + $0.0212/GB-hr provisioned (Pro/Ent), $0.15/GB transfer. Ent: SSO/SAML,
  audit, Secure Compute VPC/VPC peering, BYOC; SOC 2 II, ISO 27001, GDPR, HIPAA. 2026: Sandbox GA,
  persistence GA, 24 h sessions, global regions.
- Daytona: $0.0504/vCPU-hr, $0.0162/GiB-hr, disk $0.000108/GiB-hr; Windows $0.0858/vCPU-hr. OIDC SSO,
  audit, BYOC regions, VPN/private; SOC 2 II, HIPAA, ISO 27001, GDPR. 2026: VM auto-pause intervals,
  Windows snapshots/forks.
- E2B: $0.000014/vCPU-s, $0.0000045/GiB-s, disk included. Ent: BYOC, OTEL, webhooks, SOC 2 II, HIPAA
  BAA/DPA on request; SSO/SCIM planned. No static egress IPs. 2026: fork from live in-memory state.
- Fly: per-second named presets + ~$5/30 d per extra GB RAM; egress $0.02–0.12/GB public. Org SSO,
  WireGuard private nets, SOC 2 II. 2026: volume snapshot billing from Jan 1.
- Modal: $0.00003942/core-s, $0.00000667/GiB-s; egress billed from Oct 1 2026 (1/10/100 TiB incl.).
  Audit logs, Okta/SAML, SOC 2 II, HIPAA. Caveat: logs/snapshots stay US-based.

## Sources

- https://vercel.com/docs/sandbox/concepts/persistent-sandboxes · https://vercel.com/docs/sandbox/pricing
- https://www.daytona.io/docs/en/persistence/ · https://www.daytona.io/docs/en/billing/
- https://docs.e2b.dev/sandbox/persistence · https://www.e2b.dev/docs/billing
- https://fly.io/docs/reference/suspend-resume/ · https://fly.io/docs/about/pricing/
- https://modal.com/docs/guide/sandboxes.md · https://modal.com/pricing
