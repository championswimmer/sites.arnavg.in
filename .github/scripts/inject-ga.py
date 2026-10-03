#!/usr/bin/env python3
"""Inject the GA4 snippet right after <head> in the HTML files given as args,
skipping any file that already references the GA measurement ID / gtag.js."""
import re
import sys

GA_ID = "G-J2YR2RVR6L"
SNIPPET = f"""<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id={GA_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());

  gtag('config', '{GA_ID}');
</script>
"""
HEAD_RE = re.compile(r"<head(\s[^>]*)?>[ \t]*\r?\n?", re.IGNORECASE)

changed = 0
for path in sys.argv[1:]:
    with open(path, encoding="utf-8", newline="") as f:
        html = f.read()
    if GA_ID in html or "googletagmanager.com/gtag/js" in html:
        print(f"ok (already has GA): {path}")
        continue
    m = HEAD_RE.search(html)
    if not m:
        print(f"skip (no <head>, likely a fragment): {path}")
        continue
    html = html[: m.end()] + SNIPPET + html[m.end():]
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    print(f"injected: {path}")
    changed += 1
print(f"{changed} file(s) modified")
