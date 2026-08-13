#!/usr/bin/env bash
#
# The run's docs viewer — a loopback static server over the run worktree, so the
# human can read docs/features/<feature>/ in docs/spec-viewer.html (which polls,
# so it live-reloads) while grilling the story and approving the spec.
#
#   docs-server.sh start  <feature>   # idempotent; prints a banner with the URL
#   docs-server.sh ensure <feature>   # same, but prints ONLY the URL — for agents
#   docs-server.sh url    <feature>   # print the URL of an already-running server
#   docs-server.sh stop   <feature>
#
# `ensure` is the ONLY safe way to obtain the URL. Never read docs-server.url
# directly: a SIGKILL, a reboot or a `sao resume` (which does not re-run bootstrap)
# can leave that file naming a server that no longer exists, and a dead link printed
# with confidence is worse than no link. Every path here re-checks liveness first.
#
# Once the feature name validates, this NEVER fails the calling node: the viewer is
# a convenience, not a gate, so no runtime failure — missing runtime, port trouble,
# a server that never came up — is worth halting a run for. They warn and exit 0.
# An invalid feature name still dies, the same as every other script here: it is
# joined into a path, so it is a guard, not a runtime condition.
set -uo pipefail

. "$(dirname "$0")/_lib.sh"

cmd="${1:-}"
feature="${2:-}"
require_feature "$feature"

script_dir="$(cd "$(dirname "$0")" && pwd)"
state_dir="tmp/$feature"
pid_file="$state_dir/docs-server.pid"
url_file="$state_dir/docs-server.url"
log_file="$state_dir/docs-server.log"

quiet=0
warn() { echo "docs-viewer: $*" >&2; }

# stdout stays URL-only in quiet mode; every warning already goes to stderr.
announce() {
  if [ "$quiet" = 1 ]; then cat "$url_file"; else banner "$(cat "$url_file")"; fi
}

running() {
  [ -s "$pid_file" ] || return 1
  kill -0 "$(cat "$pid_file")" 2>/dev/null
}

# Kill whatever the pid file names and WAIT for it to go. Dropping the pid file
# while the child still lives would strand a loopback server nothing can find:
# the next start would bind a second port and stop would have nothing to kill.
kill_recorded() {
  local pid
  if [ -s "$pid_file" ]; then
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        warn "viewer $pid ignored SIGTERM — sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
  fi
  rm -f "$pid_file"
}

banner() {
  local url="$1"
  echo
  echo "  ┌─ docs viewer ──────────────────────────────────────────────"
  echo "  │  $url"
  echo "  │  live-reloads while the agents write; read the story and"
  echo "  │  the spec here before you answer at the gate."
  echo "  └────────────────────────────────────────────────────────────"
  echo
}

# The viewer is frequently untracked, and a worktree cut from HEAD would not carry
# it. Point the server at the main checkout's copy as a fallback so the page is
# reachable either way, without copying an untracked file into the run's diff.
viewer_fallback() {
  local common main
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || return 0
  case "$common" in /*) ;; *) common="$PWD/$common" ;; esac
  main="$(dirname "$common")"
  [ -f "$main/docs/spec-viewer.html" ] && printf '%s' "$main/docs/spec-viewer.html"
}

start() {
  if running; then
    if [ -s "$url_file" ]; then
      announce
      return 0
    fi
    # Alive but it never reported a URL — a hung child that would otherwise sit
    # there forever, since every later start would take this same early return.
    warn "previous viewer never reported a URL — restarting it"
  fi
  # Also clears a pid file left by a process that is already gone.
  kill_recorded

  local runtime=""
  for c in node bun; do
    command -v "$c" >/dev/null 2>&1 && { runtime="$c"; break; }
  done
  [ -n "$runtime" ] || { warn "neither node nor bun on PATH — skipping"; return 0; }

  mkdir -p "$state_dir"
  rm -f "$url_file"

  nohup "$runtime" "$script_dir/docs-server.mjs" "$PWD" "$url_file" "$(viewer_fallback)" \
    >"$log_file" 2>&1 &
  echo $! > "$pid_file"

  # The port is chosen by the OS, so wait for the server to report it back.
  for _ in $(seq 1 50); do
    [ -s "$url_file" ] && break
    sleep 0.1
  done

  if [ ! -s "$url_file" ]; then
    # Kill it before forgetting it: a slow listen that succeeds a moment later
    # would otherwise leave an unreachable, unkillable server behind.
    warn "did not start within 5s — see $log_file"
    kill_recorded
    return 0
  fi
  announce
}

case "$cmd" in
  start) start ;;
  # For agents: idempotent, self-healing, and prints nothing but the URL. An agent
  # that reads the url file itself would skip every liveness check above.
  ensure) quiet=1; start ;;
  url)
    if running && [ -s "$url_file" ]; then
      announce
    else
      # story_partner / spec_partner print this file's contents verbatim, so a URL
      # left behind by a dead server is worse than no URL at all.
      kill_recorded
      rm -f "$url_file"
      warn "not running"
    fi
    ;;
  stop)
    if running; then
      kill_recorded
      echo "docs-viewer: stopped"
    else
      kill_recorded
    fi
    rm -f "$url_file"
    ;;
  *) warn "usage: docs-server.sh {start|ensure|url|stop} <feature>" ;;
esac

exit 0
