# 02 — The cost wall: why one full VM per chat breaks

Speaker math: **500 developers × 3–4 concurrent sessions ≈ 1,500–2,000 live sandboxes**.
If each chat gets its own always-on VM, cost scales with **open sessions**, not useful work.

## Floor pricing (AWS small VMs, ~730 h/month)

- 4 GiB VM (`t3.medium` $0.0418/hr ≈ $30.5/mo; `t3a.medium` $0.0376/hr) → **≈ $7/GiB-month**.
- 8 GiB VM (`t3.large` $0.0835/hr ≈ $61/mo).
- 4 GiB is a plausible minimum for an agent (repo + language server + tools); 8 GiB is comfortable.

## Illustrative scenarios (compute only; excludes disks, egress, NAT, logs)

| Scenario | Math | Est. monthly compute | Idle burn if 75% idle |
|---|---:|---:|---:|
| 1,500 sessions × 4 GiB | 1,500 × 4 × $7 | ~$42k/mo | ~$31k/mo |
| 2,000 sessions × 4 GiB | 2,000 × 4 × $7 | ~$56k/mo | ~$42k/mo |
| 2,000 sessions × 8 GiB | 2,000 × 8 × $7 | ~$112k/mo | ~$84k/mo |

Cross-check: 2,000 always-on `t3.medium` ≈ **$61k/month**; 2,000 × `t3.large` ≈ **$122k/month**.

## The core argument

An agent session is idle most of its wall-clock life — human reads, thinks, reviews
diffs, switches tasks — but the VM bills from launch until stopped. Most spend is
**paying to hold RAM/CPU open during waiting time**. Pausable designs change billing
from "one VM per open tab" to "pay when compute actually runs" (cf. Cloud Run's
vCPU-seconds / GiB-seconds). Pausing doesn't make compute free (state storage remains),
but it kills the idle burn.

## Sources

- https://aws.amazon.com/ec2/instance-types/t3/
- https://aws.amazon.com/ec2/pricing/on-demand/
- https://cloud.google.com/products/compute/pricing/general-purpose
- https://cloud.google.com/run/pricing
- https://azure.microsoft.com/en-gb/pricing/details/virtual-machines/series/
