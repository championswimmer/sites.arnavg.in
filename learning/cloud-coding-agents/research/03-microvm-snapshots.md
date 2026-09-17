# 03 — Lightweight VMs: pause / resume via snapshots

## Split state into two layers

- **Execution state**: RAM + VM/device state.
- **Filesystem state**: writable disk/overlay.
- Pause = capture both to cheap storage, release CPU/RAM, pay storage-only while idle.

## Firecracker (best fit when KVM is available)

- Advertised **<125 ms startup**, **<5 MiB VMM overhead**.
- Snapshot saves guest memory + microVM/device state into a memory file + state file;
  disk files are separate, user-managed artifacts.
- Restore **mmaps** the memory file or serves pages via **userfaultfd** — pages load on
  demand, so resume approaches ~1 s even for many paused sessions.
- Caveat: **vsock resets** across snapshot/restore; TAP/vsock/disk resources must exist again.

## Alternatives

- **Kata Containers**: VM-isolated pools; density via **template cloning** (shared
  read-only kernel/initramfs; example: 100 VMs at 128 MiB saved ~9 GiB / ~72%).
  Cloning, not arbitrary suspend/resume.
- **gVisor**: non-KVM fallback; userspace-kernel checkpoint/restore, `--background`
  lets app start before all pages load. Viable for warm pools, not full microVM snapshots.
- **CRIU**: process-level checkpoint/restore; preserves process state but **not block
  devices** — snapshot the filesystem separately; established TCP needs care.

## Platform pattern

- Base rootfs immutable + shared; persist only per-session memory snapshot + small
  writable overlay/block volume.
- Hot snapshots on local NVMe / attached block storage; cold ones to object storage.
- On AWS, volume-from-snapshot hydrates from S3 — large-disk restore is the latency
  bottleneck; use Fast Snapshot Restore or keep resumed disks small for ~1 s resume.

## Sources

- https://github.com/firecracker-microvm/firecracker/blob/main/FAQ.md
- https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
- https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/what-is-vm-templating-and-how-do-I-use-it.md
- https://gvisor.dev/docs/user_guide/checkpoint_restore/
- https://criu.org/Advanced_usage
- https://docs.aws.amazon.com/ebs/latest/userguide/initalize-volume.html
