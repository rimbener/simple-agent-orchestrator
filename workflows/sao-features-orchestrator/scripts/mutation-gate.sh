#!/usr/bin/env bash
#
# The mutation loop's until_bash — the ONLY thing that may end that loop.
#
#   mutation-gate.sh <feature>    # exit 0 = gate met, non-zero = keep looping
#
# This exists because a sentinel is an assertion and this gate needs evidence. A
# real run ended `mutation` with <promise>MUTANTS_DEAD</promise> while its own
# output said Stryker had been blocked from running and mutation.md still listed 42
# survivors. An agent cannot write this file's exit code, so it cannot make that
# claim again: the loop now ends only when StrykerJS itself reported a clean scope.
#
# Reads tmp/<feature>/stryker.log — machine output from run-mutation.sh, never the
# agent-authored mutation.md, which is prose and can say anything.
#
# FAIL CLOSED. Missing log, crashed run, unrecognised format, unreadable row: all
# non-zero. "I could not tell" must never read as "gate met".
set -euo pipefail

. "$(dirname "$0")/_lib.sh"

feature="${1:-}"
require_feature "$feature"

log="tmp/$feature/stryker.log"

[ -f "$log" ] || die "no $log — run-mutation.sh has not run this iteration"

# run-mutation.sh writes this when the feature changed no production source. There
# is nothing to mutate, so the gate is vacuously met.
if grep -q 'NO_CHANGED_SOURCE' "$log"; then
  echo "gate met: no changed source to mutate"
  exit 0
fi

# Stryker's clear-text reporter ends with a per-file table plus an "All files" row.
# The header is located first and its column NAMES are mapped to indices, rather
# than trusting fixed positions — a reporter that adds a column would otherwise make
# this read "# no cov" out of the errors slot and silently pass a dirty scope.
#
# The header is matched on the three columns actually read, never on the score
# columns: those are named "% score" in some Stryker versions and "total | covered"
# in others (9.6.1), and keying on them made this fail closed on every real log.
read -r survived nocov < <(awk -F'|' '
  /# killed/ && /# survived/ && /# no cov/ {
    for (i = 1; i <= NF; i++) {
      gsub(/^[ \t]+|[ \t]+$/, "", $i)
      if ($i == "# survived") s = i
      if ($i == "# no cov")   n = i
    }
    next
  }
  s && n && $1 ~ /^[ \t]*All files[ \t]*$/ {
    gsub(/^[ \t]+|[ \t]+$/, "", $s)
    gsub(/^[ \t]+|[ \t]+$/, "", $n)
    print $s, $n
    found = 1
    exit
  }
  END { if (!found) exit 1 }
' "$log") || die "no parseable 'All files' row in $log — Stryker did not finish (check the log for a crash or a failing dry run)"

case "$survived$nocov" in
  *[!0-9]* | "") die "unreadable counts in $log (survived='$survived' no-cov='$nocov')" ;;
esac

if [ "$survived" -eq 0 ] && [ "$nocov" -eq 0 ]; then
  echo "gate met: 0 survived, 0 no-coverage"
  exit 0
fi

echo "gate not met: $survived survived, $nocov no-coverage — keep killing"
exit 1
