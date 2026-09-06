#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'publish-plan: %s\n' "$1" >&2
  exit 1
}

run_key="${1:-}"
target="${2:-}"
if [ -z "$run_key" ] || [ -z "$target" ]; then
  die "usage: publish-plan.sh <run_key> <plan directory|file>"
fi

[ -n "${OFFDESK_URL:-}" ] || die "OFFDESK_URL is not set (configure it on the cloud environment)"
[ -n "${OFFDESK_TOKEN:-}" ] || die "OFFDESK_TOKEN is not set (configure it on the cloud environment)"
command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v jq >/dev/null 2>&1 || die "jq is not installed"

base="${OFFDESK_URL%/}"
max_file_bytes=1048576

single=""
if [ -d "$target" ]; then
  root="${target%/}"
  name="$(basename "$root")"
elif [ -f "$target" ]; then
  root="$(dirname "$target")"
  single="$(basename "$target")"
  name="${single%.*}"
else
  die "not found: $target"
fi

slug="$(printf '%s' "$name" \
  | tr '[:upper:]' '[:lower:]' \
  | sed 's/[^a-z0-9_-]/-/g; s/^[^a-z0-9]*//; s/-*$//' \
  | cut -c1-64)"
[ -n "$slug" ] || die "cannot derive an alphanumeric plan name from: $name"

files=()
if [ -n "$single" ]; then
  files=("$single")
else
  while IFS= read -r -d '' path; do
    files+=("${path#"$root"/}")
  done < <(find "$root" -type f -not -path '*/.*' -not -path '*/node_modules/*' -print0 | sort -z)
fi
[ "${#files[@]}" -gt 0 ] || die "nothing to upload: $target"

for rel in "${files[@]}"; do
  size="$(wc -c <"$root/$rel" | tr -d ' ')"
  [ "$size" -le "$max_file_bytes" ] || die "too large (over 1MB): $rel"

  status="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$base/plans/$slug/$rel" \
    -H "authorization: Bearer ${OFFDESK_TOKEN}" \
    -H "x-offdesk-run: ${run_key}" \
    --data-binary "@$root/$rel")"
  [ "$status" = "200" ] || die "upload failed (${status}): $rel"
done

payload="$(printf '%s\n' "${files[@]}" | jq -R . | jq -sc '{paths: .}')"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

status="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$base/plans/$slug/finish" \
  -H "authorization: Bearer ${OFFDESK_TOKEN}" \
  -H "x-offdesk-run: ${run_key}" \
  -H 'content-type: application/json' \
  --data "$payload")"
[ "$status" = "200" ] || die "finish failed (${status})"

url="$(jq -r '.url // empty' <"$body")"
[ -n "$url" ] || die "the server did not return a url"

printf '%s\n' "$url"
