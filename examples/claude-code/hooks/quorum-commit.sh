#!/bin/sh
# Claude Code's PreToolUse hook for a Bash git commit: reviews the local changes with quorum --local
# before the commit runs, which covers git commit -a, and stops the commit when the review finds, has
# a gap or fails. Claude reads what it prints: quorum's brief line and fixed text alone, since
# quorum's stderr names files and quotes what a model wrote. The review stops at 10 minutes unless
# QUORUM_REVIEW_TIMEOUT_MS is set, so it ends before the hook's timeout of 11.
: "${QUORUM_REVIEW_TIMEOUT_MS:=600000}"; export QUORUM_REVIEW_TIMEOUT_MS
nl='
'
brief=$(quorum --local --format brief </dev/null 2>/dev/null)
code=$?
[ "$code" -eq 0 ] && exit 0
brief=${brief%%"$nl"*}
case $brief in
  'quorum: '*) ;;
  *) brief='quorum: no brief line' ;;
esac
printf '%s\n' "$brief" "quorum stopped this commit (exit $code). Do not retry it or work around the hook: tell the user, who reads the review with quorum --local in a terminal." >&2
exit 2
