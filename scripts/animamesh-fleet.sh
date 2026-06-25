#!/usr/bin/env bash
#
# animamesh-fleet.sh — Multi-account fleet manager for Animamesh
#
# Manages throwaway GitHub accounts as proxy runner farms.
# Each account gets its own GH_CONFIG_DIR for isolated auth,
# a fork of the backend repo with a random innocent-looking name,
# and all required secrets.
#
# Usage:
#   ./animamesh-fleet.sh add <token> [--name NAME] [--fork-name NAME]
#       Register a new throwaway account and set it up
#
#   ./animamesh-fleet.sh deploy [--all|--name NAME] [--protocol hy2|vless]
#       Trigger proxy runners on one or all accounts
#
#   ./animamesh-fleet.sh status [--all|--name NAME]
#       Check active runners across the fleet
#
#   ./animamesh-fleet.sh logs <name> [--run-id ID]
#       Fetch runner logs from an account
#
#   ./animamesh-fleet.sh list
#       List all registered accounts
#
#   ./animamesh-fleet.sh remove <name>
#       Remove an account from the fleet
#
#   ./animamesh-fleet.sh init-secrets
#       Prompt to set shared secrets on all forks
#
# Config:
#   ~/.animamesh/fleet.env       — shared config (COORDINATOR_URL, AUTH_TOKEN, etc.)
#   ~/.animamesh/accounts/       — per-account directories
#       <name>/
#           gh/                  — GH_CONFIG_DIR (gh auth isolated)
#           repo/                — git clone of the fork
#           .meta                — account metadata (fork name, real repo name)
#

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
ANIMAMESH_DIR="${HOME}/.animamesh"
ACCOUNTS_DIR="${ANIMAMESH_DIR}/accounts"
FLEET_ENV="${ANIMAMESH_DIR}/fleet.env"
GENERATED_NAMES=(
  "tiled-cache"
  "dotenv-config"
  "stream-utils"
  "buffer-tools"
  "route-helpers"
  "parse-adapters"
  "array-fns"
  "hash-maps"
  "date-fmt"
  "csv-parse"
  "ini-loader"
  "yaml-writer"
  "path-join"
  "type-guards"
  "promise-pool"
  "retry-queue"
  "batch-process"
  "throttle-debounce"
  "lru-calc"
  "sorted-array"
)

# ─── Colors ───────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}ℹ${NC} $*"; }
log_ok()    { echo -e "${GREEN}✔${NC} $*"; }
log_warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
log_error() { echo -e "${RED}✘${NC} $*" >&2; }
log_step()  { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }

# ─── Help ─────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Animamesh Fleet Manager — multi-account proxy runner farm

USAGE:
  $SCRIPT_NAME add <token> [--name NAME] [--fork-name NAME]
  $SCRIPT_NAME deploy [--all|--name NAME] [--protocol hy2|vless] [--tunnel n2n|pinggy|trycloudflare|direct]
  $SCRIPT_NAME status [--all|--name NAME]
  $SCRIPT_NAME logs <name> [--run-id ID]
  $SCRIPT_NAME list
  $SCRIPT_NAME remove <name>
  $SCRIPT_NAME init-secrets

COMMANDS:
  add            Register a new throwaway account
  deploy         Trigger proxy runners (parallel by default)
  status         Check active runs
  logs           Fetch runner logs
  list           List all registered accounts
  remove         Remove an account from the fleet
  init-secrets   Set shared secrets on all forks

OPTIONS:
  --name NAME           Account name (auto-generated if omitted)
  --fork-name NAME      Repo name (random if omitted — looks unrelated)
  --all                 Target all accounts
  --protocol PROTO      hysteria2 (default) or vless
  --tunnel TUNNEL       n2n (default), pinggy, trycloudflare, or direct
  --run-id ID           Specific run ID for logs
  -h, --help            Show this message

EOF
  exit 0
}

# ─── Bootstrap ────────────────────────────────────────────────────────────

ensure_dirs() {
  mkdir -p "$ACCOUNTS_DIR"
}

require_fleet_env() {
  if [ ! -f "$FLEET_ENV" ]; then
    log_warn "No fleet.env found. Run 'init-secrets' first or create manually:"
    echo "  $FLEET_ENV"
    echo ""
    echo "Required variables:"
    echo "  COORDINATOR_URL=https://your-worker.workers.dev"
    echo "  AUTH_TOKEN=your-secret"
    echo "  NETWORK_ID=my-mesh"
    echo "  N2N_COMMUNITY=auto-generated-if-omitted"
    echo "  N2N_KEY=auto-generated-if-omitted"
    echo "  N2N_SUPERNODE=supernode.ntop.org:7777"
    return 1
  fi
  # shellcheck source=/dev/null
  source "$FLEET_ENV"
}

# ─── Random name generator ───────────────────────────────────────────────

pick_name() {
  local used=("$@")
  local candidate
  while true; do
    candidate="${GENERATED_NAMES[$((RANDOM % ${#GENERATED_NAMES[@]}))]}"
    local taken=false
    for u in "${used[@]}"; do
      if [ "$candidate" = "$u" ]; then taken=true; break; fi
    done
    if [ "$taken" = false ]; then
      echo "$candidate"
      return 0
    fi
  done
}

pick_community() {
  local suffix
  suffix=$(head -c 8 /dev/urandom | base32 | tr -d '=' | tr '[:upper:]' '[:lower:]')
  echo "animamesh-${suffix}"
}

pick_key() {
  head -c 18 /dev/urandom | base64 | tr -d '=' | head -c 24
}

# ─── Account metadata ────────────────────────────────────────────────────

write_meta() {
  local name="$1"
  local fork_name="$2"
  local gh_user="$3"
  cat > "$ACCOUNTS_DIR/$name/.meta" <<META
# Animamesh fleet account
name=${name}
fork=${fork_name}
user=${gh_user}
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
META
}

read_meta() {
  local name="$1"
  local key="$2"
  if [ -f "$ACCOUNTS_DIR/$name/.meta" ]; then
    grep "^${key}=" "$ACCOUNTS_DIR/$name/.meta" | cut -d= -f2-
  fi
}

# ─── Commands ─────────────────────────────────────────────────────────────

cmd_add() {
  local token="" name="" fork_name=""

  # Parse args
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --fork-name) fork_name="$2"; shift 2 ;;
      -h|--help) usage ;;
      *)
        if [ -z "$token" ]; then
          token="$1"; shift
        else
          log_error "Unknown: $1"; usage
        fi
        ;;
    esac
  done

  if [ -z "$token" ]; then
    log_error "Token required. Usage: $SCRIPT_NAME add <token> [--name NAME]"
    exit 1
  fi

  ensure_dirs

  # Pick name if not provided
  if [ -z "$name" ]; then
    local existing_names
    existing_names=()
    for d in "$ACCOUNTS_DIR"/*/; do
      [ -d "$d" ] && existing_names+=("$(basename "$d")")
    done
    name=$(pick_name "${existing_names[@]}")
  fi

  local account_dir="$ACCOUNTS_DIR/$name"
  if [ -d "$account_dir" ]; then
    log_error "Account '$name' already exists at $account_dir"
    exit 1
  fi

  log_step "Registering account: $name"
  mkdir -p "$account_dir/gh"

  # Login with gh
  log_info "Authenticating with gh CLI..."
  echo "$token" | GH_CONFIG_DIR="$account_dir/gh" gh auth login --with-token 2>&1 || {
    log_error "gh auth failed. Check token."
    rm -rf "$account_dir"
    exit 1
  }

  # Get the account username
  local gh_user
  gh_user=$(GH_CONFIG_DIR="$account_dir/gh" gh api user --jq '.login' 2>/dev/null || echo "unknown")

  log_ok "Authenticated as ${BOLD}$gh_user${NC}"

  # Add delete_repo scope if needed (pipe token to avoid browser prompt)
  echo "$token" | GH_CONFIG_DIR="$account_dir/gh" gh auth refresh -h github.com -s delete_repo --with-token 2>/dev/null || true

  # Check if any existing forks of animamesh/backend exist — delete them
  log_info "Checking for existing forks..."
  local existing_forks
  existing_forks=$(GH_CONFIG_DIR="$account_dir/gh" gh repo list "$gh_user" --limit 50 --json name,isFork,parent --jq '.[] | select(.isFork == true) | select(.parent.owner.login == "animamesh") | .name' 2>/dev/null || true)
  if [ -n "$existing_forks" ]; then
    for fork_name in $existing_forks; do
      log_warn "Deleting existing fork: $gh_user/$fork_name"
      GH_CONFIG_DIR="$account_dir/gh" gh repo delete "$gh_user/$fork_name" --yes 2>/dev/null || true
    done
  fi

  # Pick fork name if not provided
  if [ -z "$fork_name" ]; then
    local used_names
    used_names=()
    for d in "$ACCOUNTS_DIR"/*/; do
      [ -d "$d" ] && used_names+=("$(read_meta "$(basename "$d")" "fork")" "")
    done
    fork_name=$(pick_name "${used_names[@]}")
  fi

  # Fork the repo
  log_info "Forking animamesh/backend → ${gh_user}/${fork_name}..."
  GH_CONFIG_DIR="$account_dir/gh" gh repo fork animamesh/backend --clone=false --fork-name "$fork_name" 2>&1 || {
    log_error "Fork failed"
    rm -rf "$account_dir"
    exit 1
  }
  log_ok "Fork created: ${gh_user}/${fork_name}"

  # Set a plausible description
  local descriptions=(
    "Tile-based spatial data caching utility"
    "Lightweight dotenv configuration loader"
    "Stream processing helpers for Node.js"
    "Buffer manipulation toolkit"
    "HTTP route helper utilities"
    "Data parsing adapter library"
    "Array functional programming helpers"
    "Hash map implementation utilities"
    "Date formatting and parsing library"
    "CSV parsing utilities"
  )
  local desc="${descriptions[$((RANDOM % ${#descriptions[@]}))]}"
  GH_CONFIG_DIR="$account_dir/gh" gh repo edit "$gh_user/$fork_name" --description "$desc" --add-topic utility,toolkit 2>/dev/null || true

  # Clone the fork
  log_info "Cloning fork..."
  GH_CONFIG_DIR="$account_dir/gh" gh repo clone "$gh_user/$fork_name" "$account_dir/repo" 2>&1

  # Set up git remote with token for push capability
  # The GH_CONFIG_DIR credential helper doesn't work with git push,
  # so we embed the token in the remote URL locally
  cd "$account_dir/repo"
  local gh_token
  gh_token=$(GH_CONFIG_DIR="$account_dir/gh" gh auth token 2>/dev/null || true)
  if [ -n "$gh_token" ]; then
    git remote set-url origin "https://oauth2:${gh_token}@github.com/${gh_user}/${fork_name}.git"
    log_ok "Git remote configured with token for push"
  fi
  cd - >/dev/null

  # Write metadata
  write_meta "$name" "$fork_name" "$gh_user"

  # Obfuscate the fork to hide what it actually does
  obfuscate_fork "$account_dir"

  # Clean up token from git remote URL after push
  cd "$account_dir/repo"
  git remote set-url origin "https://github.com/${gh_user}/${fork_name}.git" 2>/dev/null || true
  cd - >/dev/null

  log_ok "Account ${BOLD}$name${NC} (${gh_user}) → fork ${BOLD}$fork_name${NC}"
  log_info "Account dir: $account_dir"
  echo ""
  log_info "Next: Set secrets with: $SCRIPT_NAME init-secrets"
}

# ─── Obfuscation ─────────────────────────────────────────────────────────

obfuscate_fork() {
  local account_dir="$1"
  local repo_dir="$account_dir/repo"
  # Read fork_name from .meta so this function works independently
  local fork_name
  fork_name=$(grep "^fork=" "$account_dir/.meta" 2>/dev/null | cut -d= -f2- || echo "repo")

  log_step "Obfuscating fork: ${fork_name}"

  if [ ! -d "$repo_dir" ]; then
    log_warn "No repo directory at $repo_dir, skipping obfuscation"
    return
  fi

  cd "$repo_dir"

  # ── 1. Nuke docs (specs reveal the entire architecture) ──
  if [ -d "docs" ]; then
    rm -rf docs
    log_info "Nuked docs/"
  fi

  # ── 2. Nuke AGENTS.md (reveals mesh structure, secrets handling) ──
  if [ -f "AGENTS.md" ]; then
    rm -f AGENTS.md
    log_info "Nuked AGENTS.md"
  fi
  if [ -f "RULES.md" ]; then
    rm -f RULES.md
    log_info "Nuked RULES.md"
  fi

  # ── 3. Nuke revealing scripts from the fork ──
  # These are local management tools, not needed on the runner
  if [ -f "scripts/animamesh-connect.sh" ]; then
    rm -f scripts/animamesh-connect.sh
    log_info "Nuked scripts/animamesh-connect.sh"
  fi
  if [ -f "scripts/animamesh-fleet.sh" ]; then
    rm -f scripts/animamesh-fleet.sh
    log_info "Nuked scripts/animamesh-fleet.sh"
  fi

  # ── 4. Replace README with LLM-generated or static fallback ──
  log_info "Generating README via LLM..."
  if gen_readme "$fork_name" > README.md 2>/dev/null; then
    log_ok "README generated via LLM"
  else
    log_warn "LLM unavailable, using static template"
    local generic_desc
    local generic_adjectives=(
      "Lightweight utility library for common data processing tasks"
      "Collection of helper modules for Node.js projects"
      "Stream processing and buffer manipulation toolkit"
      "Type-safe utility functions and data structures"
      "Configuration loader and parser utilities"
      "Hash map and array functional programming helpers"
    )
    generic_desc="${generic_adjectives[$((RANDOM % ${#generic_adjectives[@]}))]}"

    cat > README.md <<READEOF
# ${fork_name}

${generic_desc}

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

\`\`\`typescript
import { … } from './src';
\`\`\`

## License

MIT
READEOF
    log_info "Replaced README.md (static)"
  fi

  # ── 5. Obfuscate workflow file ──
  local workflow="$repo_dir/.github/workflows/proxy.yml"
  if [ -f "$workflow" ]; then
    # Change the workflow display name from "BPB Action Proxy" to something generic
    sed -i 's/name: BPB Action Proxy/name: CI Pipeline/' "$workflow"
    sed -i 's/description: Launch.*/description: Automated build and test pipeline/' "$workflow" 2>/dev/null || true
    # Obfuscate step names (replace revealing names with generic ones)
    sed -i 's/name: Install Hysteria2/name: Install dependencies/' "$workflow"
    sed -i 's/name: Install sing-box (VLESS)/name: Setup runtime/' "$workflow"
    sed -i 's/name: Generate credentials/name: Configure environment/' "$workflow"
    sed -i 's/name: Setup n2n P2P Network/name: Configure network overlay/' "$workflow"
    sed -i 's/name: Setup Hysteria2/name: Start server/' "$workflow"
    sed -i 's/name: Setup sing-box (VLESS)/name: Start service/' "$workflow"
    sed -i 's/name: Setup Pinggy Tunnel/name: Configure tunnel/' "$workflow"
    sed -i 's/name: Setup Cloudflare Tunnel/name: Setup tunnel/' "$workflow"
    sed -i 's/name: Setup Direct P2P Tunnel/name: Configure direct tunnel/' "$workflow"
    sed -i 's/name: Register proxy/name: Register with registry/' "$workflow"
    sed -i 's/name: Output subscription info/name: Print connection info/' "$workflow"
    sed -i 's/name: Start DHT Mesh Node/name: Start discovery service/' "$workflow"
    sed -i 's/name: Keep runner alive with heartbeat/name: Keep alive/' "$workflow"
    # Strip revealing workflow-level comments
    sed -i '/^# ---.*$/d' "$workflow" 2>/dev/null || true
    sed -i '/^#.*BPB.*$/Id' "$workflow" 2>/dev/null || true
    sed -i '/^#.*animamesh.*$/Id' "$workflow" 2>/dev/null || true
    sed -i '/^#.*mesh.*$/Id' "$workflow" 2>/dev/null || true
    sed -i '/^#.*proxy.*$/Id' "$workflow" 2>/dev/null || true
    sed -i '/^#.*Hiddify.*$/Id' "$workflow" 2>/dev/null || true
    sed -i '/^#.*VLESS.*$/Id' "$workflow" 2>/dev/null || true
    sed -i '/^#.*Hysteria2.*$/Id' "$workflow" 2>/dev/null || true
    log_info "Obfuscated workflow file"
  fi

  # ── 6. Strip revealing comments from source files ──
  # Only strip comments that reveal architecture (animamesh, bpb, mesh, etc.)
  # Do NOT modify code, API paths, env vars, or schema
  local src_dirs="src worker/src node/src"
  for dir in $src_dirs; do
    if [ -d "$dir" ]; then
      find "$dir" -name '*.ts' -o -name '*.py' 2>/dev/null | while IFS= read -r file; do
        # Strip block comments mentioning revealing terms
        sed -i '/BPB Action Mesh/Id' "$file" 2>/dev/null || true
        sed -i '/Animamesh/Id' "$file" 2>/dev/null || true
        sed -i '/BPB Mesh/Id' "$file" 2>/dev/null || true
        # Strip license header comments
        sed -i '/^ \* BPB Action/,/^ \*\//{/^ \*\//!d}' "$file" 2>/dev/null || true
        # Strip dangerous file-level doc comments (not JSDoc on functions)
        sed -i '/^# BPB Action/d' "$file" 2>/dev/null || true
        sed -i '/^# A decentralized mesh/d' "$file" 2>/dev/null || true
      done
    fi
  done

  # ── 7. Rebrand the panel.yml if it exists ──
  local panel_workflow="$repo_dir/.github/workflows/panel.yml"
  if [ -f "$panel_workflow" ]; then
    sed -i 's/name: Deploy Panel/name: Deploy static site/' "$panel_workflow" 2>/dev/null || true
    sed -i 's/name: Build.*Panel/name: Build assets/' "$panel_workflow" 2>/dev/null || true
  fi

  # ── 8. Commit and push all changes ──
  git add -A 2>/dev/null
  if git diff --cached --quiet 2>/dev/null; then
    log_info "No changes to commit (already clean)"
  else
    git commit -m "chore: housekeeping" --quiet 2>/dev/null || true
    git push origin main --quiet 2>/dev/null || {
      log_warn "Push failed (may need to pull first)"
      # Try pull + push
      git pull --rebase origin main --quiet 2>/dev/null || true
      git push origin main --quiet 2>/dev/null || log_warn "Push still failed, continuing..."
    }
    log_ok "Obfuscation committed and pushed"
  fi

  cd - >/dev/null
}

# ─── LLM-backed README generation ─────────────────────────────────────

gen_readme() {
  local fork_name="$1"
  local llm_url="${LLM_URL:-http://localhost:3001/v1/chat/completions}"
  local llm_key="${LLM_KEY:-}"

  # If no LLM key is configured, skip straight to fallback
  if [ -z "$llm_key" ]; then
    return 1
  fi

  local prompt
  prompt="Generate a concise README.md in English for a GitHub repository called '${fork_name}'. It is a small utility library (JavaScript/Node.js). Describe it as a collection of helper functions with a realistic use case. Include a short Installation section (npm install), a Usage section with a minimal code example, and a License section (MIT). Keep it under 30 lines. Do not mention proxy, mesh, VPN, network, tunnel, or any infrastructure concepts. Just a plain utility library."

  # Construct JSON payload safely using python3 to avoid shell escaping issues
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'model':'auto','messages':[{'role':'user','content':sys.argv[1]}],'temperature':0.7,'max_tokens':400}))" "$prompt" 2>/dev/null) || return 1

  local result
  result=$(curl -s --max-time 15 "$llm_url" \
    -H "Authorization: Bearer $llm_key" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo "")

  if [ -n "$result" ]; then
    # Parse JSON with python3 — handles thinking/reasoning content, multiline, unicode
    local readme
    readme=$(echo "$result" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    content = data["choices"][0]["message"]["content"]
    # Strip leading thinking/reasoning: find first line that starts with #
    lines = content.split("\n")
    out_lines = []
    found = False
    for line in lines:
        if not found and line.strip().startswith("#"):
            found = True
        if found:
            out_lines.append(line)
    result = "\n".join(out_lines).strip()
    if not result:
        result = content
    print(result)
except Exception:
    sys.exit(1)
' 2>/dev/null || echo "")

    if [ -n "$readme" ]; then
      echo "$readme"
      return 0
    fi
  fi

  # Fallback: static template
  return 1
}

cmd_deploy() {
  local targets=() protocol="hysteria2" tunnel="n2n"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all) shift ;;
      --name) targets+=("$2"); shift 2 ;;
      --protocol) protocol="$2"; shift 2 ;;
      --tunnel) tunnel="$2"; shift 2 ;;
      -h|--help) usage ;;
      *) log_error "Unknown: $1"; usage ;;
    esac
  done

  require_fleet_env || exit 1

  # If no specific targets, deploy to all
  if [ ${#targets[@]} -eq 0 ]; then
    for d in "$ACCOUNTS_DIR"/*/; do
      [ -d "$d" ] && targets+=("$(basename "$d")")
    done
  fi

  if [ ${#targets[@]} -eq 0 ]; then
    log_error "No accounts registered. Use 'add' first."
    exit 1
  fi

  log_step "Deploying to ${#targets[@]} account(s)"
  log_info "Protocol: ${protocol}   Tunnel: ${tunnel}"
  echo ""

  local pids=()
  local i=0

  for name in "${targets[@]}"; do
    local account_dir="$ACCOUNTS_DIR/$name"
    if [ ! -d "$account_dir" ]; then
      log_warn "Account '$name' not found, skipping"
      continue
    fi

    local fork_name
    fork_name=$(read_meta "$name" "fork")
    local gh_user
    gh_user=$(read_meta "$name" "user")

    if [ -z "$fork_name" ] || [ -z "$gh_user" ]; then
      log_warn "Account '$name' missing metadata, skipping"
      continue
    fi

    (
      log_info "[$name] Triggering ${gh_user}/${fork_name} (protocol=$protocol, tunnel=$tunnel)"

      # Determine the dispatch payload
      local payload
      payload=$(cat <<JSON
{
  "ref": "main",
  "inputs": {
    "protocol": "${protocol}",
    "tunnel": "${tunnel}"
  }
}
JSON
      )

      # Use GH_CONFIG_DIR for gh-aware dispatch
      GH_CONFIG_DIR="$account_dir/gh" gh api \
        --method POST \
        "/repos/${gh_user}/${fork_name}/actions/workflows/proxy.yml/dispatches" \
        --input <(echo "$payload") \
        --silent 2>/dev/null

      local exit_code=$?
      if [ $exit_code -eq 0 ]; then
        log_ok "[$name] ✅ Workflow dispatched"
        # Get the run URL
        sleep 3
        local run_url
        run_url=$(GH_CONFIG_DIR="$account_dir/gh" gh run list \
          --repo "${gh_user}/${fork_name}" \
          --workflow proxy.yml \
          --limit 1 \
          --json url \
          --jq '.[0].url' 2>/dev/null || echo "")
        if [ -n "$run_url" ]; then
          echo "  ${BLUE}→${NC} $run_url"
        fi
      else
        log_error "[$name] ❌ Dispatch failed"
      fi
    ) &
    pids+=("$!")
    i=$((i + 1))

    # Small stagger between accounts to avoid API rate limits
    sleep 1
  done

  # Wait for all
  echo ""
  log_info "Waiting for ${#pids[@]} dispatch(es)..."
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  log_ok "Deploy complete"
}

cmd_status() {
  local targets=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all) shift ;;
      --name) targets+=("$2"); shift 2 ;;
      *) log_error "Unknown: $1"; usage ;;
    esac
  done

  if [ ${#targets[@]} -eq 0 ]; then
    for d in "$ACCOUNTS_DIR"/*/; do
      [ -d "$d" ] && targets+=("$(basename "$d")")
    done
  fi

  if [ ${#targets[@]} -eq 0 ]; then
    log_info "No accounts registered"
    exit 0
  fi

  log_step "Fleet Status"
  echo ""
  printf "  ${BOLD}%-18s %-22s %-10s %-24s${NC}\n" "ACCOUNT" "FORK" "STATUS" "RUN"
  printf "  %-18s %-22s %-10s %-24s\n" "───────" "────" "──────" "───"

  for name in "${targets[@]}"; do
    local account_dir="$ACCOUNTS_DIR/$name"
    local fork_name
    fork_name=$(read_meta "$name" "fork")
    local gh_user
    gh_user=$(read_meta "$name" "user")

    if [ ! -f "$account_dir/.meta" ]; then
      printf "  %-18s %-22s ${YELLOW}%-10s${NC}\n" "$name" "?" "no meta"
      continue
    fi

    local run_info
    run_info=$(GH_CONFIG_DIR="$account_dir/gh" gh run list \
      --repo "${gh_user}/${fork_name}" \
      --workflow proxy.yml \
      --limit 1 \
      --json status,conclusion,displayTitle,createdAt,url \
      --jq '.[0] // {}' 2>/dev/null || echo "{}")

    local status
    status=$(echo "$run_info" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "none")
    local conclusion
    conclusion=$(echo "$run_info" | grep -o '"conclusion":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
    local title
    title=$(echo "$run_info" | grep -o '"displayTitle":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
    local url
    url=$(echo "$run_info" | grep -o '"url":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

    local status_display
    if [ "$status" = "in_progress" ]; then
      status_display="${GREEN}● running${NC}"
    elif [ "$status" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        status_display="${GREEN}✓ success${NC}"
      else
        status_display="${RED}✗ ${conclusion}${NC}"
      fi
    elif [ "$status" = "queued" ]; then
      status_display="${YELLOW}◐ queued${NC}"
    else
      status_display="${BLUE}○ idle${NC}"
    fi

    local run_display
    if [ -n "$url" ]; then
      run_display="${title:0:23}"
    else
      run_display="-"
    fi

    printf "  %-18s %-22s %b %-24s\n" "$name" "${fork_name}" "$status_display" "$run_display"
  done
  echo ""
}

cmd_logs() {
  local name="" run_id=""
  name="${1:-}"
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run-id) run_id="$2"; shift 2 ;;
      *) log_error "Unknown: $1"; usage ;;
    esac
  done

  if [ -z "$name" ]; then
    log_error "Account name required. Usage: $SCRIPT_NAME logs <name>"
    exit 1
  fi

  local account_dir="$ACCOUNTS_DIR/$name"
  if [ ! -d "$account_dir" ]; then
    log_error "Account '$name' not found"
    exit 1
  fi

  local fork_name
  fork_name=$(read_meta "$name" "fork")
  local gh_user
  gh_user=$(read_meta "$name" "user")

  if [ -z "$run_id" ]; then
    # Get latest run ID
    run_id=$(GH_CONFIG_DIR="$account_dir/gh" gh run list \
      --repo "${gh_user}/${fork_name}" \
      --workflow proxy.yml \
      --limit 1 \
      --json databaseId \
      --jq '.[0].databaseId' 2>/dev/null || echo "")
    if [ -z "$run_id" ]; then
      log_error "No runs found for $name"
      exit 1
    fi
  fi

  GH_CONFIG_DIR="$account_dir/gh" gh run view "$run_id" \
    --repo "${gh_user}/${fork_name}" \
    --log 2>&1 || true
}

cmd_list() {
  log_step "Fleet Accounts"
  echo ""
  printf "  ${BOLD}%-18s %-22s %-18s %-20s${NC}\n" "NAME" "FORK" "GITHUB USER" "CREATED"
  printf "  %-18s %-22s %-18s %-20s\n" "────" "────" "───────────" "───────"

  for d in "$ACCOUNTS_DIR"/*/; do
    [ -d "$d" ] || continue
    local name
    name=$(basename "$d")
    local fork_name
    fork_name=$(read_meta "$name" "fork") || fork_name="?"
    local gh_user
    gh_user=$(read_meta "$name" "user") || gh_user="?"
    local created
    created=$(read_meta "$name" "created") || created="?"

    printf "  %-18s %-22s %-18s %-20s\n" "$name" "${fork_name:0:21}" "${gh_user:0:17}" "${created:0:19}"
  done
  echo ""
}

cmd_remove() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    log_error "Account name required. Usage: $SCRIPT_NAME remove <name>"
    exit 1
  fi

  local account_dir="$ACCOUNTS_DIR/$name"
  if [ ! -d "$account_dir" ]; then
    log_error "Account '$name' not found"
    exit 1
  fi

  local fork_name
  fork_name=$(read_meta "$name" "fork")
  local gh_user
  gh_user=$(read_meta "$name" "user")

  log_info "Deleting fork ${gh_user}/${fork_name}..."
  GH_CONFIG_DIR="$account_dir/gh" gh repo delete "${gh_user}/${fork_name}" --yes 2>/dev/null || true

  log_info "Removing account directory..."
  rm -rf "$account_dir"
  log_ok "Account '$name' removed"
}

cmd_init_secrets() {
  if [ -f "$FLEET_ENV" ]; then
    log_warn "fleet.env already exists. Edit it directly: $FLEET_ENV"
    log_info "Then run: $SCRIPT_NAME deploy"
    exit 0
  fi

  log_step "Setting up shared fleet config"

  echo ""
  echo "Enter the shared configuration values."
  echo "Leave blank to auto-generate n2n community/key."
  echo ""

  read -rp "  COORDINATOR_URL (Worker URL): " COORDINATOR_URL
  read -rsp "  AUTH_TOKEN (shared secret): " AUTH_TOKEN
  echo ""

  if [ -z "$COORDINATOR_URL" ]; then
    log_error "COORDINATOR_URL is required"
    exit 1
  fi
  if [ -z "$AUTH_TOKEN" ]; then
    log_error "AUTH_TOKEN is required"
    exit 1
  fi

  read -rp "  NETWORK_ID (mesh id, default: animamesh-fleet): " NETWORK_ID
  NETWORK_ID="${NETWORK_ID:-animamesh-fleet}"

  read -rp "  N2N_SUPERNODE (default: supernode.ntop.org:7777): " N2N_SUPERNODE
  N2N_SUPERNODE="${N2N_SUPERNODE:-supernode.ntop.org:7777}"

  # Generate n2n credentials
  local N2N_COMMUNITY N2N_KEY
  N2N_COMMUNITY=$(pick_community)
  N2N_KEY=$(pick_key)

  cat > "$FLEET_ENV" <<EOF
# Animamesh Fleet — shared configuration
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# WARNING: This file contains secrets. Keep it safe.

COORDINATOR_URL=${COORDINATOR_URL}
AUTH_TOKEN=${AUTH_TOKEN}
NETWORK_ID=${NETWORK_ID}
N2N_COMMUNITY=${N2N_COMMUNITY}
N2N_KEY=${N2N_KEY}
N2N_SUPERNODE=${N2N_SUPERNODE}
EOF

  chmod 600 "$FLEET_ENV"
  log_ok "Config written to $FLEET_ENV"

  echo ""
  log_info "Now setting secrets on all registered forks..."

  for d in "$ACCOUNTS_DIR"/*/; do
    [ -d "$d" ] || continue
    local name
    name=$(basename "$d")
    local fork_name
    fork_name=$(read_meta "$name" "fork")
    local gh_user
    gh_user=$(read_meta "$name" "user")

    if [ -z "$fork_name" ] || [ -z "$gh_user" ]; then
      log_warn "Skipping $name (incomplete metadata)"
      continue
    fi

    log_info "[$name] Setting secrets on ${gh_user}/${fork_name}..."

    # Set secrets via gh CLI with explicit token from account's auth
    local gh_token
    gh_token=$(cat "$d/gh/hosts.yml" 2>/dev/null | grep oauth_token | awk '{print $2}' | tr -d '"' || true)
    if [ -z "$gh_token" ]; then
      log_warn "[$name] No gh token found, skipping secret sync"
      continue
    fi

    for secret_name in COORDINATOR_URL AUTH_TOKEN NETWORK_ID N2N_COMMUNITY N2N_KEY N2N_SUPERNODE; do
      local secret_value
      eval "secret_value=\$$secret_name"
      if ! echo "$secret_value" | GH_TOKEN="$gh_token" gh secret set "$secret_name" --repo "${gh_user}/${fork_name}" 2>&1; then
        log_warn "[$name] Failed to set $secret_name (repo may not exist or token expired)"
      fi
    done

    log_ok "[$name] Secrets synced"
  done
}

# ─── Main ─────────────────────────────────────────────────────────────────

ensure_dirs

case "${1:-help}" in
  add)            shift; cmd_add "$@" ;;
  deploy)         shift; cmd_deploy "$@" ;;
  status)         shift; cmd_status "$@" ;;
  logs)           shift; cmd_logs "$@" ;;
  list)           cmd_list ;;
  remove)         shift; cmd_remove "$@" ;;
  init-secrets)   cmd_init_secrets ;;
  help|--help|-h) usage ;;
  *)
    log_error "Unknown command: ${1:-}"
    echo ""
    usage
    ;;
esac
