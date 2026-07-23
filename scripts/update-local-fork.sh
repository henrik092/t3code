#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=${T3CODE_UPDATE_REPO_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
INSTALL_DIR=${T3CODE_UPDATE_INSTALL_DIR:-/home/rik/Applications}
LAUNCHER_PATH=${T3CODE_UPDATE_LAUNCHER_PATH:-$INSTALL_DIR/t3code}
STATUS_PATH=${T3CODE_UPDATE_STATUS_PATH:-$INSTALL_DIR/.t3code-local-update-status}

CHECK_COMMAND=${T3CODE_UPDATE_CHECK_COMMAND:-corepack pnpm exec vp check}
TYPECHECK_COMMAND=${T3CODE_UPDATE_TYPECHECK_COMMAND:-corepack pnpm exec vp run typecheck}
TEST_COMMAND=${T3CODE_UPDATE_TEST_COMMAND:-corepack pnpm exec vp test --maxWorkers=4}
BUILD_COMMAND=${T3CODE_UPDATE_BUILD_COMMAND:-corepack pnpm exec vp run dist:desktop:linux}

die() {
  printf 'Fehler: %s\n' "$*" >&2
  exit 1
}

if [[ ${T3CODE_UPDATE_SKIP_NODE_SELECTION:-0} != 1 ]]; then
  NODE24_BIN=${T3CODE_UPDATE_NODE_BIN:-}
  if [[ -z "$NODE24_BIN" ]]; then
    NODE24_BIN=$(find /home/rik/.nvm/versions/node -mindepth 2 -maxdepth 2 -type d -path '*/v24.*/bin' -print 2>/dev/null | sort -V | tail -1)
  fi
  [[ -n "$NODE24_BIN" && -x "$NODE24_BIN/node" ]] || die "Keine lokale Node-24-Runtime gefunden."
  export PATH="$NODE24_BIN:$PATH"
fi

read_status_value() {
  local wanted=$1
  local key value
  [[ -f "$STATUS_PATH" ]] || return 1
  while IFS=$'\t' read -r key value; do
    if [[ "$key" == "$wanted" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < "$STATUS_PATH"
  return 1
}

atomic_link() {
  local target=$1
  local temporary_link="$LAUNCHER_PATH.next.$$"
  [[ -f "$target" ]] || die "Build nicht gefunden: $target"
  ln -s -- "$target" "$temporary_link"
  mv -Tf -- "$temporary_link" "$LAUNCHER_PATH"
}

write_status() {
  local candidate=$1
  local checksum=$2
  local commit=$3
  local temporary_status="$STATUS_PATH.next.$$"
  {
    printf 'candidate\t%s\n' "$candidate"
    printf 'sha256\t%s\n' "$checksum"
    printf 'commit\t%s\n' "$commit"
  } > "$temporary_status"
  mv -f -- "$temporary_status" "$STATUS_PATH"
}

verify_remotes() {
  local origin_url upstream_url
  origin_url=$(git remote get-url origin 2>/dev/null) || die "Git-Remote 'origin' fehlt."
  upstream_url=$(git remote get-url upstream 2>/dev/null) || die "Git-Remote 'upstream' fehlt."
  [[ "$origin_url" == *henrik092/t3code* ]] || die "Unerwartetes origin: $origin_url"
  [[ "$upstream_url" == *pingdotgg/t3code* ]] || die "Unerwartetes upstream: $upstream_url"
}

stage_update() {
  cd -- "$REPO_DIR"
  [[ $(git branch --show-current) == main ]] || die "'stage' muss auf der lokalen main laufen."
  [[ -z $(git status --porcelain=v1) ]] || die "Der Git-Arbeitsbaum ist nicht sauber."
  verify_remotes
  mkdir -p -- "$INSTALL_DIR"

  git fetch --prune origin
  git fetch --prune upstream
  git merge-base --is-ancestor origin/main main || \
    die "Lokale main enthält origin/main nicht; bitte die Fork-Abweichung zuerst klären."

  local candidate_branch="local-upstream-candidate-$(date +%Y%m%d%H%M%S)-$$"
  local build_dir
  build_dir=$(mktemp -d "${TMPDIR:-/tmp}/t3code-local-build.XXXXXX")
  local candidate_active=0
  local staged_temp=""

  cleanup_stage() {
    local exit_code=$?
    trap - EXIT INT TERM
    if [[ $candidate_active -eq 1 ]]; then
      if [[ -f .git/MERGE_HEAD ]]; then
        git merge --abort >/dev/null 2>&1 || true
      fi
      git switch main >/dev/null 2>&1 || true
      git branch -D "$candidate_branch" >/dev/null 2>&1 || true
    fi
    if [[ -n "$staged_temp" ]]; then
      rm -f -- "$staged_temp"
    fi
    rm -rf -- "$build_dir"
    exit "$exit_code"
  }
  trap cleanup_stage EXIT INT TERM

  git switch -c "$candidate_branch" main
  candidate_active=1
  if ! git merge --no-edit upstream/main; then
    die "Upstream-Merge hat Konflikte; aktiver Launcher und main bleiben unverändert."
  fi

  corepack pnpm install --frozen-lockfile
  bash -lc "$CHECK_COMMAND"
  bash -lc "$TYPECHECK_COMMAND"
  bash -lc "$TEST_COMMAND"
  env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
    T3CODE_DESKTOP_OUTPUT_DIR="$build_dir" bash -lc "$BUILD_COMMAND"

  local artifact_count artifact commit short_commit destination checksum
  artifact_count=$(find "$build_dir" -maxdepth 1 -type f -name '*.AppImage' -printf '.' | wc -c)
  [[ "$artifact_count" -eq 1 ]] || die "Erwartete genau ein AppImage, gefunden: $artifact_count"
  artifact=$(find "$build_dir" -maxdepth 1 -type f -name '*.AppImage' -print -quit)
  commit=$(git rev-parse HEAD)
  short_commit=$(git rev-parse --short=12 HEAD)
  destination="$INSTALL_DIR/T3-Code-local-$short_commit-x86_64.AppImage"
  staged_temp="$destination.next.$$"
  install -m 0755 -- "$artifact" "$staged_temp"
  checksum=$(sha256sum -- "$staged_temp" | cut -d' ' -f1)
  if [[ -e "$destination" ]]; then
    local existing_checksum
    existing_checksum=$(sha256sum -- "$destination" 2>/dev/null | cut -d' ' -f1) || \
      die "Bestehender Build ist nicht lesbar: $destination"
    [[ "$existing_checksum" == "$checksum" ]] || \
      die "Build-Ziel existiert mit abweichendem Inhalt: $destination"
    rm -f -- "$staged_temp"
  else
    mv -T -- "$staged_temp" "$destination"
  fi
  staged_temp=""

  write_status "$destination" "$checksum" "$commit"

  git switch main
  git merge --ff-only "$candidate_branch"
  git branch -D "$candidate_branch"
  candidate_active=0
  trap - EXIT INT TERM
  rm -rf -- "$build_dir"

  printf 'Geprüfter Build bereit: %s\n' "$destination"
  printf 'Launcher unverändert: %s\n' "$LAUNCHER_PATH"
  printf 'Aktivieren mit: %s activate\n' "$0"
}

activate_update() {
  local candidate expected actual current
  candidate=$(read_status_value candidate) || die "Kein bereitgestellter Build in $STATUS_PATH"
  expected=$(read_status_value sha256) || die "Prüfsumme fehlt in $STATUS_PATH"
  actual=$(sha256sum -- "$candidate" 2>/dev/null | cut -d' ' -f1) || die "Build nicht lesbar: $candidate"
  [[ "$actual" == "$expected" ]] || die "Prüfsumme des bereitgestellten Builds stimmt nicht."
  current=$(readlink -f -- "$LAUNCHER_PATH" 2>/dev/null || true)
  if [[ "$current" != "$candidate" ]]; then
    atomic_link "$candidate"
  fi
  printf 'T3 Code aktiviert: %s\n' "$candidate"
}

case ${1:-} in
  stage) stage_update ;;
  activate) activate_update ;;
  *) die "Aufruf: $0 {stage|activate}" ;;
esac
