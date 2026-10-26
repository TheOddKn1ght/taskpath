#!/usr/bin/env bash
# Adopt the existing Docker service; keep host nginx, certificates and source intact.
set -Eeuo pipefail
umask 077
ROOT=/opt/taskpath-updater
PROGRAM=/usr/local/bin/taskpath
SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=https://github.com/TheOddKn1ght/taskpath.git
BRANCH=main

log() { printf '[taskpath] %s\n' "$*"; }
die() { log "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Adopt an existing multi-user Docker Compose installation (Ubuntu/Debian):
  sudo bash scripts/vps.sh install --container EXISTING_CONTAINER [--repo URL] [--branch main]
  sudo taskpath update                 Deploy the configured branch
  sudo taskpath start                  Resume the committed deployment
  sudo taskpath recover                Resume after an interrupted update
  sudo taskpath backup                 Back up the stopped data volume
  sudo taskpath status
  sudo taskpath logs
  sudo taskpath enable-auto-updates    Opt into hourly updates
  sudo taskpath disable-auto-updates

Requires Docker Compose v2 with --wait, Python 3, Git, flock and systemd.
Existing nginx, HTTPS, accounts, settings and browser storage are preserved.
No fresh installation or legacy plaintext/single-owner migration is performed.
HELP
}
host() {
  [[ $(uname -s) == Linux && $EUID == 0 && -d /run/systemd/system ]] || die 'Run as root on the Linux VPS with systemd.'
  local tool
  for tool in docker python3 git flock tar; do command -v "$tool" >/dev/null || die "Install $tool first."; done
  docker info >/dev/null
  docker compose version >/dev/null
}
lock() {
  mkdir -p "$ROOT"
  chmod 700 "$ROOT"
  exec 9>"$ROOT/lock"
  flock -w 1800 9 || die 'Another operation is running.'
}
helper() { python3 "$ROOT/vps-config.py" "$@"; }
get() { helper get "$1" "$2"; }
compose() {
  COMPOSE_DISABLE_ENV_FILE=true docker compose --project-name taskpath-managed \
    --project-directory "$ROOT" --env-file /dev/null -f "$1" "${@:2}"
}
write_current() {
  printf '%s\n' "$1" > "$ROOT/current.tmp"
  mv "$ROOT/current.tmp" "$ROOT/current"
}
current() { cat "$ROOT/current"; }
validate_repository() {
  [[ "$REPO" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]+)+$ || "$REPO" =~ ^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$ ]] || die 'Use a credential-free HTTPS or SSH repository URL.'
  [[ "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$BRANCH" != *..* && "$BRANCH" != *//* && "$BRANCH" != *.lock && "$BRANCH" != */ ]] || die 'Invalid branch.'
}
fetch_release() {
  REPO=$(cat "$ROOT/repo") BRANCH=$(cat "$ROOT/branch")
  validate_repository
  local directory=$ROOT
  while :; do
    [[ ! -f "$directory/.arcconfig" ]] || die 'Updater directory is inside Arcadia.'
    [[ "$directory" != / ]] || break
    directory=$(dirname "$directory")
  done
  if [[ ! -d "$ROOT/repository.git" ]]; then
    git init --bare "$ROOT/repository.git" >&2
    git --git-dir="$ROOT/repository.git" remote add origin "$REPO"
  fi
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' \
    git --git-dir="$ROOT/repository.git" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >&2
  SHA=$(git --git-dir="$ROOT/repository.git" rev-parse "refs/remotes/origin/$BRANCH^{commit}")
  [[ "$SHA" =~ ^[a-f0-9]{40,64}$ ]] || die 'Invalid revision.'
  if [[ -f "$ROOT/current" ]]; then
    git --git-dir="$ROOT/repository.git" merge-base --is-ancestor "$(current_revision)" "$SHA" || die 'Refusing rewritten branch history.'
  fi
  RELEASE="$ROOT/releases/$SHA"
  mkdir -p "$ROOT/releases"
  if [[ ! -d "$RELEASE" ]]; then
    local staging
    staging=$(mktemp -d "$ROOT/releases/.staging.XXXXXX")
    git --git-dir="$ROOT/repository.git" archive "$SHA" | tar -x -C "$staging"
    [[ -f "$staging/Dockerfile" && -f "$staging/bun.lock" ]] || die 'Incomplete release.'
    mv "$staging" "$RELEASE"
  fi
}
build_release() { docker build --pull -t "taskpath-managed:$SHA" "$RELEASE"; }
stop_current() {
  if [[ -f "$ROOT/current" ]]; then compose "$(current)" stop taskpath
  else docker stop "$(get "$ROOT/settings.json" container)" >/dev/null; fi
}
start_current() {
  if [[ -f "$ROOT/current" ]]; then
    compose "$(current)" up -d --no-build --pull never --wait --wait-timeout 180 taskpath
  else docker start "$(get "$ROOT/settings.json" container)" >/dev/null; fi
}
current_volume() {
  if [[ -f "$ROOT/current" ]]; then get "$(current)" volumes.data.name; else get "$ROOT/settings.json" volume; fi
}
current_revision() { local image; image=$(get "$(current)" services.taskpath.image); printf '%s\n' "${image##*:}"; }
# The writer is stopped before archiving the entire volume, including SQLite WAL.
snapshot() {
  local volume=$1 image=$2
  [[ -z $(docker ps -q --filter "volume=$volume") ]] || die 'Data volume is still mounted by a running container; refusing an inconsistent backup.'
  BACKUP="$ROOT/backups/$(date -u +%Y%m%dT%H%M%S)-$$.tar"
  mkdir -p "$ROOT/backups"
  docker run --rm --network none --user 0 --entrypoint tar \
    --mount "type=volume,src=$volume,dst=/data,readonly" \
    "$image" -c -C /data . > "$BACKUP.tmp"
  tar -tf "$BACKUP.tmp" >/dev/null
  mv "$BACKUP.tmp" "$BACKUP"
  log "Backup: $BACKUP"
}
clone_volume() {
  docker volume create "$VOLUME" >/dev/null
  docker run --rm -i --network none --user 0 --entrypoint tar \
    --mount "type=volume,src=$VOLUME,dst=/data" "$IMAGE" -xpf - -C /data < "$BACKUP"
  # Reject empty/legacy data BEFORE starting an app that could create a fresh DB.
  # Only the disposable clone is writable: SQLite may need to recreate its WAL
  # shared-memory index even with a read-only database connection.
  docker run --rm --network none --entrypoint bun \
    --mount "type=volume,src=$VOLUME,dst=/app/data" "$IMAGE" -e '
import { Database } from "bun:sqlite";
const db = new Database("/app/data/taskpath-accounts.sqlite", { readonly: true });
if (db.query("PRAGMA quick_check").get().quick_check !== "ok" ||
    db.query("SELECT version FROM encrypted_format").all().length !== 1 ||
    db.query("SELECT version FROM encrypted_format").get().version !== 2 ||
    db.query("SELECT name FROM sqlite_master WHERE name = ?").get("tasks") ||
    !db.query("SELECT name FROM sqlite_master WHERE name = ?").get("accounts")) process.exit(1);
db.close();'
}
preflight() {
  helper compose "$ROOT/settings.json" "$IMAGE" "$VOLUME" private > "$ROOT/probe.json"
  # A separate project and no networking: no user traffic or outbound pushes.
  COMPOSE_DISABLE_ENV_FILE=true docker compose --project-name taskpath-probe \
    --project-directory "$ROOT" --env-file /dev/null -f "$ROOT/probe.json" \
    up -d --no-build --pull never --wait --wait-timeout 180 taskpath
}
remove_probe() {
  [[ ! -f "$ROOT/probe.json" ]] || COMPOSE_DISABLE_ENV_FILE=true docker compose \
    --project-name taskpath-probe --project-directory "$ROOT" --env-file /dev/null \
    -f "$ROOT/probe.json" down
}
recover() {
  # current is the durable commit boundary, written BEFORE publishing any ports.
  # Never restore older data after a new deployment could have accepted writes.
  if [[ -f "$ROOT/pending" ]]; then
    remove_probe || return $?
    start_current || return $?
    rm "$ROOT/pending"
  else start_current || return $?; fi
}
on_exit() {
  local status=$?
  trap - EXIT
  if [[ $status != 0 && -f "$ROOT/pending" ]]; then
    log 'Operation failed; resuming the committed deployment. All volumes and backups are retained.'
    recover || log 'Recovery needs attention. Run sudo taskpath recover.'
  fi
  exit "$status"
}
update() {
  [[ ! -f "$ROOT/pending" ]] || die 'Run sudo taskpath recover first.'
  fetch_release
  if [[ -f "$ROOT/current" && $(current_revision) == "$SHA" ]]; then log 'Already up to date.'; return; fi
  build_release
  IMAGE="taskpath-managed:$SHA"
  VOLUME="taskpath-release-$(date -u +%Y%m%dT%H%M%S)-$$"
  # Record recovery intent before stopping the live writer.
  touch "$ROOT/pending"
  stop_current
  snapshot "$(current_volume)" "$IMAGE"
  clone_volume
  preflight
  remove_probe
  local deployment="$ROOT/deployments/$VOLUME.json"
  mkdir -p "$ROOT/deployments"
  helper compose "$ROOT/settings.json" "$IMAGE" "$VOLUME" > "$deployment"
  compose "$deployment" config --quiet
  # Stop the old managed container before committing the new service config.
  # The original manually deployed container is retained, stopped, for reference.
  write_current "$deployment"
  start_current
  rm "$ROOT/pending"
  log "Updated to $SHA. Previous volumes and $BACKUP are retained."
}
install_updater() {
  local container=''
  while (($#)); do
    [[ $# -ge 2 && -n $2 ]] || die "Missing value for $1."
    case "$1" in --container) container=$2 ;; --repo) REPO=$2 ;; --branch) BRANCH=$2 ;; *) die "Unknown option: $1" ;; esac
    shift 2
  done
  [[ -n "$container" && "$container" != -* ]] || die 'Pass --container for the running taskpath service.'
  validate_repository
  [[ ! -f "$ROOT/settings.json" ]] || die 'Already installed. Use sudo taskpath update.'
  [[ -z $(docker ps -aq --filter label=com.docker.compose.project=taskpath-managed) && -z $(docker ps -aq --filter label=com.docker.compose.project=taskpath-probe) ]] || die 'Managed project names are already in use.'
  docker inspect "$container" > "$ROOT/container.tmp"
  python3 "$SCRIPT_DIRECTORY/vps-config.py" capture "$ROOT/container.tmp" > "$ROOT/settings.tmp"
  rm "$ROOT/container.tmp"
  install -m 0600 "$SCRIPT_DIRECTORY/vps-config.py" "$ROOT/vps-config.py"
  # Installed script resolves its helper and state through ROOT.
  install -m 0755 "$SCRIPT_DIRECTORY/vps.sh" "$PROGRAM"
  install -m 0644 "$SCRIPT_DIRECTORY/../deploy/taskpath-update.service" /etc/systemd/system/taskpath-update.service
  install -m 0644 "$SCRIPT_DIRECTORY/../deploy/taskpath-update.timer" /etc/systemd/system/taskpath-update.timer
  printf '%s\n' "$REPO" > "$ROOT/repo"
  printf '%s\n' "$BRANCH" > "$ROOT/branch"
  mv "$ROOT/settings.tmp" "$ROOT/settings.json"
  systemctl daemon-reload
  log 'Updater installed. Existing service is unchanged. Run sudo taskpath update.'
}
main() {
  local command=${1:---help}; (($# == 0)) || shift
  case "$command" in --help|-h|help) usage; return ;; esac
  case "$command" in install|update|start|recover|backup|status|logs|enable-auto-updates|disable-auto-updates) ;; *) die "Unknown command: $command" ;; esac
  [[ "$command" == install || $# == 0 ]] || die 'Unexpected arguments.'
  host
  lock
  trap on_exit EXIT
  if [[ "$command" == install ]]; then install_updater "$@"; return; fi
  [[ -f "$ROOT/settings.json" ]] || die 'Install the updater first.'
  case "$command" in
    update) update ;;
    start|recover) recover ;;
    status) if [[ -f "$ROOT/current" ]]; then compose "$(current)" ps; else docker ps --filter "id=$(get "$ROOT/settings.json" container)"; fi ;;
    logs) flock -u 9; if [[ -f "$ROOT/current" ]]; then compose "$(current)" logs --tail 100 -f; else docker logs --tail 100 -f "$(get "$ROOT/settings.json" container)"; fi ;;
    backup)
      [[ ! -f "$ROOT/pending" ]] || die 'Run sudo taskpath recover first.'
      if [[ -f "$ROOT/current" ]]; then IMAGE="taskpath-managed:$(current_revision)"
      else IMAGE=$(docker inspect --format '{{.Image}}' "$(get "$ROOT/settings.json" container)"); fi
      touch "$ROOT/pending"
      stop_current
      snapshot "$(current_volume)" "$IMAGE"
      start_current
      rm "$ROOT/pending" ;;
    enable-auto-updates) systemctl enable --now taskpath-update.timer ;;
    disable-auto-updates) systemctl disable --now taskpath-update.timer ;;
  esac
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
