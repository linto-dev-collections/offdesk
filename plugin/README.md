# offdesk plugin

The plugin for [offdesk](https://github.com/linto-dev-collections/offdesk).
It lives in the offdesk repository, which is also the marketplace.

**Target repositories keep zero offdesk files.** The cloud environment's setup script installs this plugin, which brings the MCP server and the hooks with it.

## Install

In the cloud environment's **Setup script** field:

```bash
#!/bin/bash
# rev: 4   <- bump after changing the plugin, so the cached environment is rebuilt
set -u
ok=0
for home in /home/user /root; do
  [ -d "$home" ] || continue
  HOME="$home" claude plugin marketplace add linto-dev-collections/offdesk || true
  HOME="$home" claude plugin install offdesk@offdesk || true

  # Say whether it is actually there. `|| true` above has to stay (a non-zero
  # exit stops the session from starting), but swallowing every error leaves a
  # session that starts fine and cannot reach Discord -- and nothing says so.
  if HOME="$home" claude plugin list 2>/dev/null | grep -q offdesk; then
    echo "OFFDESK-PLUGIN-OK: installed under ${home}"
    ok=1
  else
    echo "OFFDESK-PLUGIN-MISSING: not installed under ${home}" >&2
  fi
done
[ "$ok" = 1 ] || echo "OFFDESK-PLUGIN-FAILED: no HOME got the plugin; runs will start but stay silent on Discord" >&2
exit 0
```

- **Keep `|| true` and `exit 0`.** A non-zero exit stops the session from starting.
- **Keep the `HOME` loop.** The script runs as root, whose `$HOME` differs from the session's, and Claude Code only reads `~/.claude/plugins/`.
- **The setup script does not run every session.** The environment is cached, so a change here reaches sessions only after the cache is rebuilt — bump `rev`.
- **`OFFDESK-PLUGIN-FAILED` in the setup log is the one line worth grepping.** Without the plugin, a run starts, works, and never says a word on Discord — identical in symptom to a session that simply never ran. The verification step turns that into a searchable marker in the environment's build output.

The environment also needs `OFFDESK_URL`, `OFFDESK_TOKEN`, the allowed domains, two `CLAUDE_CODE_MCP_*` variables, and `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`. See offdesk's `OPERATIONS.md` §3.

**`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` is not optional, and it cannot move into this plugin.** `SessionEnd` hooks share a 1.5 second budget. A `timeout` in a settings file raises that budget; **a `timeout` on a plugin-provided hook does not**, and a plugin cannot write a settings file. Without the variable, the hook that folds the run and posts the 🏁 is cancelled and its output discarded — silently. The `timeout` this plugin's `hooks.json` sets is still the cap for that one hook once the budget is raised, so it stays.

## Versioning

**`version` lives in `plugin.json` only, never in the marketplace entry.** Claude Code always takes the `plugin.json` value and never warns, so a version in both places means a stale manifest silently masks the one in `marketplace.json` ([Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)).

A pinned version is also what decides whether anyone gets an update: **users only receive a new copy when the string changes.** Bump `plugin.json`'s `version` in the same commit that changes anything under `plugin/plugins/offdesk/`, and bump `rev` in the setup script above so the cached environment is rebuilt. Both are checked by `apps/app/test/release/mcp-template.test.ts`.

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

The same split is why `alwaysLoad` is stated twice. `.mcp.json` sets it on the server, which covers the plugin route; the **server itself** marks `ask_human` with `_meta: {"anthropic/alwaysLoad": true}`, which covers every route including a repository's own `.mcp.json`. A lazy-loaded `ask_human` and a session with no offdesk tools at all produce the same symptom — silence — so the guarantee does not belong only in client configuration.
