#!/usr/bin/env bash
set -uo pipefail

payload="$(cat)"

url="${OFFDESK_URL:-}"
token="${OFFDESK_TOKEN:-}"
[ -n "$url" ] || exit 0
[ -n "$token" ] || exit 0
url="${url%/}"

event="$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null)"
transcript="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -n "$event" ] || exit 0
[ -f "$transcript" ] || exit 0

run_key="$(grep -m1 -ohE 'OFFDESK-[0-9a-f]{16}' "$transcript" 2>/dev/null | head -1)"
[ -n "$run_key" ] || exit 0

post() {
  curl -sS -m 10 -X POST "$url/hooks/$1" \
    -H "Authorization: Bearer $token" \
    -H 'content-type: application/json' \
    --data-binary @- >/dev/null 2>&1 || true
}

case "$event" in
  PreToolUse | Stop)
    latest="$(jq -c 'select(.message?.usage? != null)
                     | {model: .message.model, usage: .message.usage}' \
                  "$transcript" 2>/dev/null | tail -1)"
    [ -n "$latest" ] || exit 0

    jq -nc --arg k "$run_key" --arg e "$event" --argjson l "$latest" \
      '{run_key: $k, event: $e, model: $l.model, usage: $l.usage}' | post context
    ;;
  SessionEnd)
    jq -nc --arg k "$run_key" '{run_key: $k}' | post session-end
    ;;
esac

exit 0
