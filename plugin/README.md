# offdesk plugin

The plugin for [offdesk](https://github.com/linto-dev-collections/offdesk).
It lives in the offdesk repository, which is also the marketplace.

**Target repositories keep zero offdesk files.** The cloud environment's setup
script installs this plugin, which brings the MCP server and the hooks with it.
Before this, four files had to be copied into every target repository.

## Install

Put this in the cloud environment's **Setup script** field:

```bash
#!/bin/bash
# Installs the offdesk plugin. Nothing is added to the target repository.
# rev: 1   <- bump this after changing the plugin, so the cache is rebuilt

set -u

# The script runs as root, whose HOME may differ from the session's.
# Install into both so neither is missed.
for home in /home/user /root; do
  [ -d "$home" ] || continue
  HOME="$home" claude plugin marketplace add linto-dev-collections/offdesk || true
  HOME="$home" claude plugin install offdesk@offdesk || true
done

exit 0
```

Three constraints are baked into that script. Dropping any of them breaks it:

| Constraint | What it forces |
| --- | --- |
| **A non-zero exit stops the session from starting** | `\|\| true` and `exit 0`. Adding a marketplace that is already registered can exit non-zero, and that alone would stop every session |
| **It runs as root on Ubuntu 24.04** | `HOME` must be set explicitly. Root's `$HOME` is `/root`, but the session works under `/home/user/…`, and Claude Code only looks in `~/.claude/plugins/` |
| It must finish within five minutes | Fine here: two git fetches |

The environment also needs `OFFDESK_URL`, `OFFDESK_TOKEN`, the allowed domains,
and two `CLAUDE_CODE_MCP_*` variables. See offdesk's `OPERATIONS.md` §7.

## The setup script does not run every session

The environment is cached. The script runs on the first session, the filesystem
is snapshotted, and later sessions start from that snapshot and skip the script.

**So a change to this plugin does not reach sessions on its own.** The cache is
rebuilt only when the setup script changes, when the allowed hosts change, or
after roughly seven days. **Bump `# rev: N` in the setup script** to force it.

## What is inside

| | |
| --- | --- |
| `.mcp.json` | HTTP MCP server at `${OFFDESK_URL}/mcp`, bearer `${OFFDESK_TOKEN}` |
| `hooks/hooks.json` | Approval (`PreToolUse`), context and session-end reporting (`PreToolUse` / `Stop` / `SessionEnd`), and the location of `publish-plan.sh` (`SessionStart`) |
| `hooks/offdesk-hook.sh` | Reads the run key and context usage out of the transcript and posts them to `/hooks/*` |
| `scripts/publish-plan.sh` | Uploads a long implementation plan to R2 and prints one line: the URL to read it |

## Tool name prefixes differ by route

Measured in a cloud session on 2026-09-05:

```txt
mcp__offdesk__ask_human                  via a repository's .mcp.json
mcp__plugin_offdesk_offdesk__ask_human   via a plugin (this one)
```

A plugin's MCP server is namespaced as `plugin_<plugin>_<server>` to avoid
collisions, and renaming the server does not remove the prefix.

**The approval hook's matcher accepts both** (`mcp__(plugin_offdesk_)?offdesk__.*`).
Matching only one of them makes a routine **stall silently** when the route
changes: nobody is there to approve the call, so `ask_human` never returns and
Discord stays quiet. No error is raised. The same value lives in offdesk as
`OFFDESK_TOOL_MATCHER`.

## Why not account-level sync

Claude Code's documentation says plugins enabled for a claude.ai account are
downloaded into a cloud session's `~/.claude/plugins/synced/`. **That did not
happen for this organization** (measured 2026-09-05): the directory and its
bucket marker were created, but the bucket was empty, so the sync ran, resolved
the account, and delivered nothing. The account is on `claude_team` with the
`user` role, so an organization policy is the likely cause.

**The plugin machinery itself does work in a cloud session** — MCP connection,
all four hook events, and `SessionStart` `additionalContext` reaching the model
were all confirmed. Only the delivery is missing, which is why the setup script
installs from a marketplace instead.
