---
name: publishing-plans
description: Publishes a long markdown document (an implementation plan, an investigation write-up, a migration note) and returns the single URL to hand the requester. Use it whenever the text for ask_human or report would not fit in one Discord message of 2,000 characters, or whenever the requester asks to see a plan, a design, or a long write-up.
---

# Hand the requester a long document

One Discord message holds 2,000 characters, so a plan cannot be sent as text.
**Never put the body in a tool argument**: a plan runs past 200KB and would be re-emitted in full.

## Steps

1. Write the markdown under `/tmp/offdesk-plans/<name>/`.
   **Never write it inside the repository** — that path is a work area, so nothing there reaches a commit.
2. Publish it:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/publish-plan.sh" <run_key> /tmp/offdesk-plans/<name>
   ```

   `<run_key>` is the `OFFDESK-` value on the first line of the instructions.
3. The script prints **one line: the URL the requester opens.** Paste that single line into the `question` of `ask_human`.

## Rules

- **Publishing again under the same name overwrites the same URL.** After an edit, say it is updated; do not send a new link.
- **A link expires after 7 days.** Publish again if one has expired.
- Only paths under `/tmp/offdesk-plans/` are accepted. The signed URL is readable for seven days without logging in, so the script refuses anything outside the work area instead of trusting the caller.
- One file is capped at 1MB. Passing a directory publishes every file in it, skipping dotfiles and `node_modules`.

## When it fails

The script exits non-zero and prints one line starting with `publish-plan:`.

| Message | What to do |
| --- | --- |
| `OFFDESK_URL is not set` / `OFFDESK_TOKEN is not set` | The cloud environment is missing that variable, so **this route is unavailable.** Send the key points through `ask_human` instead. |
| `plans must live under ...` | The directory sits outside the work area. Go back to step 1. |
| `upload failed (4xx)` / `finish failed (4xx)` | The token or the run key was rejected. Check `<run_key>` against the first line of the instructions. |
| `No such file or directory` | Locate the script with `find "$HOME/.claude/plugins" -name publish-plan.sh` and run the path it prints. |
