#!/usr/bin/env bash
set -uo pipefail

payload="$(cat || true)"

url="${OFFDESK_URL:-}"
token="${OFFDESK_TOKEN:-}"
[ -n "$url" ] || exit 0
[ -n "$token" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
url="${url%/}"

event="$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
agent="$(printf '%s' "$payload" | jq -r '.agent_id // empty' 2>/dev/null || true)"
transcript="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
[ -n "$event" ] || exit 0
[ -z "$agent" ] || exit 0
[ -f "$transcript" ] || exit 0

run_key="$(grep -m1 -ohE 'OFFDESK-[0-9a-f]{16}' "$transcript" 2>/dev/null | head -1)"
[ -n "$run_key" ] || exit 0

# Stream the tail of the transcript, newest line first.
#
# **Do not reverse the whole file.** This runs on PreToolUse -- once per tool
# call -- and a transcript grows to megabytes over a long session, so reversing
# all of it puts that cost on every tool call. The only line wanted is the most
# recent assistant record carrying usage, which is always near the end.
# SessionEnd's 1.5 second shared budget (raised by the timeout in hooks.json) is
# a second reason to keep this cheap.
TAIL_LINES=400

rev_lines() {
  if command -v tac >/dev/null 2>&1; then
    tail -n "$TAIL_LINES" "$1" | tac
  else
    tail -n "$TAIL_LINES" "$1" | tail -r
  fi
}

post() {
  curl -sS -m 10 -X POST "$url/hooks/$1" \
    -H "Authorization: Bearer $token" \
    -H 'content-type: application/json' \
    --data-binary @- >/dev/null 2>&1 || true
}

case "$event" in
  PreToolUse | Stop)
    latest="$(rev_lines "$transcript" 2>/dev/null \
      | jq -Rc 'fromjson?
                | select(.type == "assistant")
                | select(.message.usage != null)
                | select(.message.model != "<synthetic>")
                | {model: .message.model, usage: .message.usage}' 2>/dev/null \
      | head -1 || true)"
    [ -n "$latest" ] || exit 0

    jq -nc --arg k "$run_key" --arg e "$event" --argjson l "$latest" \
      '{run_key: $k, event: $e, model: $l.model, usage: $l.usage}' | post context
    ;;
  SessionEnd)
    jq -nc --arg k "$run_key" '{run_key: $k}' | post session-end
    ;;
esac

exit 0
