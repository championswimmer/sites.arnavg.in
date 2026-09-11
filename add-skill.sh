#!/usr/bin/env bash
# add-skill.sh — install the sites.arnavg.in publisher skill into your AI agents.
#
# One-liner (installs into all detected agents):
#   curl -fsSL https://sites.arnavg.in/add-skill.sh | bash
#
# Pick specific agents:
#   curl -fsSL https://sites.arnavg.in/add-skill.sh | bash -s -- --only claude,pi
#
# Remove it again:
#   curl -fsSL https://sites.arnavg.in/add-skill.sh | bash -s -- --uninstall
#
# Off-the-shelf alternative (skills.sh package manager, same skill):
#   npx skills add championswimmer/sites.arnavg.in --skill publish-to-sites-arnavg-in
#   Ref: https://github.com/vercel-labs/skills
set -euo pipefail

SKILL="publish-to-sites-arnavg-in"
BASE_URL="${ADD_SKILL_BASE_URL:-https://sites.arnavg.in}"
SRC_URL="${ADD_SKILL_URL:-$BASE_URL/skills/$SKILL/SKILL.md}"

ONLY=""
SKIP=""
UNINSTALL=0

usage() {
  cat <<EOF
Usage: add-skill.sh [--only a,b] [--skip c,d] [--uninstall] [--url URL]

Installs the '$SKILL' skill (SKILL.md) into personal skill folders for:

  generic          ~/.agents/skills                  (covers Codex, Muse, OpenCode, Pi, Copilot, Cursor, Antigravity IDE)
  claude           ~/.claude/skills                  (Claude Code — no generic-path support)
  antigravity-cli  ~/.gemini/antigravity-cli/skills  (Antigravity CLI — no generic-path support)
  grok             ~/.grok/skills                    (xAI Grok CLI — no generic-path support)

Aliases accepted for --only/--skip: codex, muse, copilot, opencode, pi, cursor (= generic);
antigravity = generic + antigravity-cli; grok = generic + grok.

Options:
  --only a,b     install/uninstall only these agents (comma-separated)
  --skip a,b     skip these agents
  --uninstall    remove the skill instead of installing it
  --url URL      fetch SKILL.md from URL instead of $SRC_URL
  -h, --help     show this help
EOF
}

# install units: only agents WITHOUT generic-path (~/.agents/skills) support get their own dir
target_dirs() {
  case "$1" in
    generic)         printf '%s\n' "$HOME/.agents/skills" ;;
    claude)          printf '%s\n' "$HOME/.claude/skills" ;;
    antigravity-cli) printf '%s\n' "$HOME/.gemini/antigravity-cli/skills" ;;
    grok)            printf '%s\n' "$HOME/.grok/skills" ;;
    *) echo "unknown agent: $1 (see --help)" >&2; exit 1 ;;
  esac
}
ALL_AGENTS="generic claude antigravity-cli grok"

resolve_agent() {  # alias → install unit(s), one per line
  case "$1" in
    generic) printf 'generic\n' ;;
    claude) printf 'claude\n' ;;
    codex|muse|copilot|opencode|pi|cursor) printf 'generic\n' ;;  # covered by the generic path
    antigravity) printf 'generic\nantigravity-cli\n' ;;   # IDE via generic, CLI via its own dir
    grok) printf 'generic\ngrok\n' ;;                     # community CLI via generic, xAI CLI via its own dir
    antigravity-cli|antigravity_cli) printf 'antigravity-cli\n' ;;
    *) echo "unknown agent: $1 (see --help)" >&2; exit 1 ;;
  esac
}

expand_agents() {  # expand_agents "a,b" → install units, space-separated, deduped
  for a in $(printf '%s' "$1" | tr ',' ' '); do resolve_agent "$a"; done | sort -u | tr '\n' ' '
}

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?--only needs a value}"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --skip) SKIP="${2:?--skip needs a value}"; shift 2 ;;
    --skip=*) SKIP="${1#--skip=}"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --url) SRC_URL="${2:?--url needs a value}"; shift 2 ;;
    --url=*) SRC_URL="${1#--url=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
done

selected="$ALL_AGENTS"
if [ -n "$ONLY" ]; then
  selected="$(expand_agents "$ONLY")"
  [ -n "$selected" ] || { echo "error: --only matched nothing" >&2; exit 1; }
fi
SKIP_UNITS="$(expand_agents "$SKIP")"

want() {  # want <install-unit> → 0 unless skipped
  case " $SKIP_UNITS " in *" $1 "*) return 1;; *) return 0;; esac
}

if [ "$UNINSTALL" -eq 1 ]; then
  for agent in $selected; do
    want "$agent" || continue
    target_dirs "$agent" | while IFS= read -r dir; do
      if [ -d "$dir/$SKILL" ]; then rm -rf "$dir/$SKILL"; echo "removed   $dir/$SKILL"; else echo "absent    $dir/$SKILL"; fi
      rmdir "$dir" 2>/dev/null || true
    done
  done
  exit 0
fi

tmp="$(mktemp -t add-skill.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$SRC_URL" -o "$tmp"
grep -q "^name: $SKILL" "$tmp" || { echo "error: fetched file is not the $SKILL skill (from $SRC_URL)" >&2; exit 1; }

for agent in $selected; do
  want "$agent" || { echo "skipped   ($agent)"; continue; }
  target_dirs "$agent" | while IFS= read -r dir; do
    mkdir -p "$dir/$SKILL"
    if [ -f "$dir/$SKILL/SKILL.md" ] && cmp -s "$tmp" "$dir/$SKILL/SKILL.md"; then
      echo "up-to-date $dir/$SKILL/"
    else
      cp "$tmp" "$dir/$SKILL/SKILL.md"
      echo "installed  $dir/$SKILL/"
    fi
  done
done
