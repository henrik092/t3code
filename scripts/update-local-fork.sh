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
VERSION_COMMAND=${T3CODE_UPDATE_VERSION_COMMAND:-node scripts/update-release-package-versions.ts}
STABLE_PATCH_COMMIT=${T3CODE_STABLE_PATCH_COMMIT:-a03a0a0a5}

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

  local merged_head stored_commit
  merged_head=$(git rev-parse HEAD)
  stored_commit=$(read_status_value commit 2>/dev/null || true)
  if [[ -n "$stored_commit" && "$stored_commit" == "$merged_head" ]]; then
    printf 'Bereits aktuell: %s\n' "$merged_head"
    exit 0
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

latest_stable_tag() {
  git tag --merged upstream/main --list \
    | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/' \
    | sort -V \
    | tail -n 1
}

stage_stable_update() {
  cd -- "$REPO_DIR"
  [[ $(git branch --show-current) == main ]] || die "'stable-stage' muss auf der lokalen main laufen."
  [[ -z $(git status --porcelain=v1) ]] || die "Der Git-Arbeitsbaum ist nicht sauber."
  verify_remotes
  mkdir -p -- "$INSTALL_DIR"

  git fetch --prune origin
  git fetch --prune --tags upstream

  local stable_tag stable_version patch_commit stored_tag stored_patch stored_candidate
  stable_tag=$(latest_stable_tag)
  [[ -n "$stable_tag" ]] || die "Kein Stable-Release-Tag gefunden."
  stable_version=${stable_tag#v}
  patch_commit=$(git rev-parse --verify "$STABLE_PATCH_COMMIT^{commit}" 2>/dev/null) || \
    die "Stable-Patch-Commit nicht gefunden: $STABLE_PATCH_COMMIT"

  stored_tag=$(read_status_value release_tag 2>/dev/null || true)
  stored_patch=$(read_status_value patch_commit 2>/dev/null || true)
  stored_candidate=$(read_status_value candidate 2>/dev/null || true)
  if [[ "$stored_tag" == "$stable_tag" && "$stored_patch" == "$patch_commit" && -f "$stored_candidate" ]]; then
    local stored_checksum actual_checksum
    stored_checksum=$(read_status_value sha256 2>/dev/null || true)
    actual_checksum=$(sha256sum -- "$stored_candidate" 2>/dev/null | cut -d' ' -f1 || true)
    if [[ -n "$stored_checksum" && "$stored_checksum" == "$actual_checksum" ]]; then
      printf 'Stable bereits aktuell: %s mit Patch %s\n' "$stable_tag" "$patch_commit"
      return 0
    fi
  fi

  local worktree_dir output_dir worktree_active=0 staged_temp=""
  worktree_dir=$(mktemp -d "${TMPDIR:-/tmp}/t3code-stable-source.XXXXXX")
  output_dir=$(mktemp -d "${TMPDIR:-/tmp}/t3code-stable-build.XXXXXX")

  cleanup_stable_stage() {
    local exit_code=$?
    trap - EXIT INT TERM
    if [[ $worktree_active -eq 1 ]]; then
      git -C "$REPO_DIR" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
    fi
    if [[ -n "$staged_temp" ]]; then
      rm -f -- "$staged_temp"
    fi
    rm -rf -- "$worktree_dir" "$output_dir"
    exit "$exit_code"
  }
  trap cleanup_stable_stage EXIT INT TERM

  git worktree add --detach "$worktree_dir" "$stable_tag"
  worktree_active=1
  git -C "$worktree_dir" cherry-pick "$patch_commit"

  if [[ -n "$VERSION_COMMAND" ]]; then
    (cd -- "$worktree_dir" && bash -lc "$VERSION_COMMAND '$stable_version'")
    if [[ -n $(git -C "$worktree_dir" status --porcelain=v1) ]]; then
      git -C "$worktree_dir" add --all
      git -C "$worktree_dir" commit -m "build: align local stable package versions"
    fi
  fi

  (cd -- "$worktree_dir" && corepack pnpm install --frozen-lockfile)
  (cd -- "$worktree_dir" && bash -lc "$CHECK_COMMAND")
  (cd -- "$worktree_dir" && bash -lc "$TYPECHECK_COMMAND")
  (cd -- "$worktree_dir" && bash -lc "$TEST_COMMAND")
  (cd -- "$worktree_dir" && env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
    T3CODE_DESKTOP_OUTPUT_DIR="$output_dir" bash -lc "$BUILD_COMMAND")

  local artifact_count artifact build_commit destination checksum
  artifact_count=$(find "$output_dir" -maxdepth 1 -type f -name '*.AppImage' -printf '.' | wc -c)
  [[ "$artifact_count" -eq 1 ]] || die "Erwartete genau ein AppImage, gefunden: $artifact_count"
  artifact=$(find "$output_dir" -maxdepth 1 -type f -name '*.AppImage' -print -quit)
  build_commit=$(git -C "$worktree_dir" rev-parse HEAD)
  destination="$INSTALL_DIR/T3-Code-stable-local-$stable_version-$(printf '%.12s' "$patch_commit")-x86_64.AppImage"
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

  local temporary_status="$STATUS_PATH.next.$$"
  {
    printf 'candidate\t%s\n' "$destination"
    printf 'sha256\t%s\n' "$checksum"
    printf 'commit\t%s\n' "$build_commit"
    printf 'release_tag\t%s\n' "$stable_tag"
    printf 'patch_commit\t%s\n' "$patch_commit"
  } > "$temporary_status"
  mv -f -- "$temporary_status" "$STATUS_PATH"

  git -C "$REPO_DIR" worktree remove --force "$worktree_dir"
  worktree_active=0
  trap - EXIT INT TERM
  rm -rf -- "$worktree_dir" "$output_dir"

  printf 'Geprüfter Stable-Build bereit: %s\n' "$destination"
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
  stable-stage) stage_stable_update ;;
  activate) activate_update ;;
  *) die "Aufruf: $0 {stage|stable-stage|activate}" ;;
esac
