#!/usr/bin/env python3
"""Regenerate research/index.html and learning/index.html listings from slug dirs.

Usage: update-listings.py [repo-root]  (defaults to cwd)
"""
import html
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
UL_RE = re.compile(r"<ul>.*?</ul>", re.DOTALL)
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.DOTALL | re.IGNORECASE)
KINDS = {"research": "report", "learning": "guide"}


def title_of(page: Path, slug: str) -> str:
    m = TITLE_RE.search(page.read_text(encoding="utf-8"))
    if not m:
        return slug
    return " ".join(html.unescape(m.group(1)).split())


def update(name: str) -> bool:
    base = ROOT / name
    kind = KINDS[name]
    slugs = sorted(
        p.name for p in base.iterdir() if p.is_dir() and (p / "index.html").is_file()
    )
    if slugs:
        items = "\n".join(
            f'  <li><a href="/{name}/{s}/">'
            f"{html.escape(title_of(base / s / 'index.html', s))}</a></li>"
            for s in slugs
        )
    else:
        items = "  <li><em>Nothing here yet.</em></li>"
    block = (
        "<ul>\n"
        f'  <!-- one <li> per {kind}: <li><a href="/{name}/slug/">Title</a></li> -->\n'
        f"{items}\n"
        "</ul>"
    )
    listing = base / "index.html"
    text = listing.read_text(encoding="utf-8")
    new, n = UL_RE.subn(block, text, count=1)
    if n == 0:
        print(f"error: no <ul> block in {listing}", file=sys.stderr)
        sys.exit(1)
    if new == text:
        print(f"unchanged {listing.relative_to(ROOT)}")
        return False
    listing.write_text(new, encoding="utf-8")
    print(f"updated   {listing.relative_to(ROOT)} ({len(slugs)} entries)")
    return True


if __name__ == "__main__":
    changed = False
    for section in KINDS:
        if (ROOT / section / "index.html").is_file():
            changed |= update(section)
    sys.exit(0)
