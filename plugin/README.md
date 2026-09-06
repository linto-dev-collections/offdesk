# offdesk plugin

The plugin for [offdesk](https://github.com/linto-dev-collections/offdesk).
It lives in the offdesk repository, which is also the marketplace.

**Target repositories keep zero offdesk files.** The cloud environment's setup script installs this plugin, which brings the MCP server and the hooks with it.

## Install

In the cloud environment's **Setup script** field:

```bash
#!/bin/bash
# rev: 3   <- bump after changing the plugin, so the cached environment is rebuilt
set -u
for home in /home/user /root; do
  [ -d "$home" ] || continue
  HOME="$home" claude plugin marketplace add linto-dev-collections/offdesk || true
  HOME="$home" claude plugin install offdesk@offdesk || true
done
exit 0
```

- **Keep `|| true` and `exit 0`.** A non-zero exit stops the session from starting.
- **Keep the `HOME` loop.** The script runs as root, whose `$HOME` differs from the session's, and Claude Code only reads `~/.claude/plugins/`.
- **The setup script does not run every session.** The environment is cached, so a change here reaches sessions only after the cache is rebuilt — bump `rev`.

The environment also needs `OFFDESK_URL`, `OFFDESK_TOKEN`, the allowed domains, and two `CLAUDE_CODE_MCP_*` variables. See offdesk's `OPERATIONS.md` §3.

## Contents

| | |
| --- | --- |
| `.mcp.json` | HTTP MCP server at `${OFFDESK_URL}/mcp`, bearer `${OFFDESK_TOKEN}` |
| `hooks/hooks.json` | Approval, context and session-end reporting, and where this plugin is installed |
| `hooks/offdesk-hook.sh` | Posts the run key and context usage to `/hooks/*` |
| `scripts/publish-plan.sh` | Uploads a long implementation plan and prints its URL |
| `skills/publishing-plans/SKILL.md` | How to hand the requester a long document. **Loaded only when it is needed** |

## Tool name prefixes differ by route

```txt
mcp__offdesk__ask_human                  via a repository's .mcp.json
mcp__plugin_offdesk_offdesk__ask_human   via a plugin (this one)
```

A plugin's MCP server is namespaced as `plugin_<plugin>_<server>`, and renaming the server does not remove the prefix. **The approval hook's matcher accepts both** (`mcp__(plugin_offdesk_)?offdesk__.*`). Matching only one makes a routine stall silently when the route changes: nobody approves the call, `ask_human` never returns, and Discord stays quiet with no error.
