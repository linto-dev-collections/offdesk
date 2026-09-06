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

# The plan work directory (paired with PLAN_WORK_DIR in packages/domain/src/prompt.ts).
plan_work_dir="${PLAN_WORK_DIR:-/tmp/offdesk-plans}"

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

# Only publish from under the work directory.
#
# **A prompt that says "write it there" is not enough.** This script is callable
# from bash inside the session, and whatever it uploads becomes a signed URL that
# is readable for seven days without logging in. With a free-form argument, one
# misread instruction -- or one line of prompt injection arriving through the
# repository, a pull request, or a fetched page -- turns this into an exit for
# any file the session can read.
#
# **Compare resolved paths** (pwd -P). /tmp is itself a symlink on some systems
# (/private/tmp on darwin), and a symlink inside the work directory pointing
# outside it would slip past a plain string comparison.
work_real="$(cd "$plan_work_dir" 2>/dev/null && pwd -P || true)"
[ -n "$work_real" ] || die "the plan work directory does not exist: ${plan_work_dir}"

root_real="$(cd "$root" 2>/dev/null && pwd -P || true)"
[ -n "$root_real" ] || die "not found: $target"

case "${root_real}/" in
  "${work_real}/"*) ;;
  *) die "plans must live under ${plan_work_dir} (got ${target})" ;;
esac

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
