# 04 — Warm monorepo + copy-on-write session views

## Pattern

Keep **one warm monorepo checkout on a host/dev server** (fast local SSD, hot in page
cache). Each agent VM gets either an **OverlayFS view** over it or a **ZFS/btrfs
writable clone**. Expose into the microVM via **virtiofs** (preferred) or a cloned disk.
Session startup is near-instant, the base is never recopied, only changed blocks cost space.

## OverlayFS

Merges shared **lowerdir** + private **upperdir**. Reads come from the lower tree until
the session modifies a file → **copy_up** copies that file into the upper layer;
deletions become **whiteouts**. Simple, ubiquitous, great for read-mostly repos — but
CoW is **file-granular**, so rewriting huge files is less efficient than block-level CoW.

## ZFS clones

Snapshot = instant read-only point-in-time; **clone** = writable dataset from a snapshot.
ZFS never overwrites blocks in place, so warm dataset + every clone share blocks until
written. Better for heavy-write workloads + native snapshot/replication; costs operating ZFS.

## btrfs snapshots

Read-write snapshots of subvolumes: fast metadata ops, shared extents initially, CoW
divergence on write. The Linux-native "warm base + cheap clones" option without ZFS.

## Supporting pieces

- **virtiofs over 9p** for modern Linux microVMs; `cache=never` for multi-VM density so
  guests don't each build redundant page caches (host owns caching).
- **FUSE/NFS**: fine as read-mostly lower layer or shared cache; keep writable upper local.
- **Lazy image pull** (eStargz, SOCI, EROFS snapshotters): fetch metadata + needed chunks
  on demand — complements, doesn't replace, the per-session writable layer.
- **Pause/resume**: per-session writable dataset/volume snapshotted locally (ZFS/btrfs)
  or as incremental EBS snapshots; block snapshots preserve **disk, not live RAM** —
  true process resume also needs guest memory capture.

## Sources

- https://docs.kernel.org/filesystems/overlayfs.html
- https://openzfs.github.io/openzfs-docs/Basic%20Concepts/Datasets/Snapshots%20and%20Clones.html
- https://btrfs.readthedocs.io/en/stable/btrfs-subvolume.html
- https://intelkevinputnam.github.io/cloud-hypervisor-docs-HTML/docs/fs.html
- https://docs.aws.amazon.com/ebs/latest/userguide/how_snapshots_work.html
- https://github.com/containerd/stargz-snapshotter/blob/main/docs/estargz.md
