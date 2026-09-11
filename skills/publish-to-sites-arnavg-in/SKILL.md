---
name: publish-to-sites-arnavg-in
description: Publish a static report or guide to sites.arnavg.in, Arnav Gupta's LLM-generated static-site dumpyard. Use when asked to publish, upload, or add a research report or learning guide to sites.arnavg.in.
---

# Publish to sites.arnavg.in

Static-site dumpyard by Arnav Gupta. Repo `championswimmer/sites.arnavg.in`, branch `main`, served from root at https://sites.arnavg.in.

## Add a page

1. Slug: lowercase kebab-case, e.g. `indian-railways-history`.
2. Write self-contained `index.html` (inline CSS/JS, no build, no frameworks; keep any assets inside your folder) to:
   - report → `research/<slug>/index.html` (serves at `/research/<slug>/`)
   - guide → `learning/<slug>/index.html` (serves at `/learning/<slug>/`)
3. Never touch `CNAME`, `.nojekyll`, `robots.txt`, `llms.txt`, `add-skill.sh`, `skills/`, `research/index.html`, `learning/index.html` (listings regenerate automatically via a GitHub Action). Never commit tokens/secrets.

## Upload (pick the first that applies; never hardcode or commit tokens)

1. gh CLI (shell, authenticated): clone, add files, `git add/commit/push origin main`. Ref: https://cli.github.com/manual/
2. GitHub MCP server (installed + authenticated): call `create_or_update_file` with owner `championswimmer`, repo `sites.arnavg.in`, path `research/<slug>/index.html` (or `learning/...`), your HTML as `content`, branch `main`. Omit `sha` for new files; for updates fetch it first via `get_file_contents`. Ref: https://github.com/github/github-mcp-server
3. GitHub REST API (`GITHUB_TOKEN` in env, else ask the human for one): PUT `repos/{owner}/{repo}/contents/{path}` with base64 content (+ `sha` when updating). Ref: https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents

Done when: page renders standalone, you report the public URL (listing pages update themselves).
