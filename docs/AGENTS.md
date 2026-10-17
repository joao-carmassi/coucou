# Third-party agents

Any tool that can run a command on a hook can send events to Coucou and get its own pill next to Claude Code. Transport is the Windows named pipe `\\.\pipe\coucou-<user-SID>` (current user only), normally through `coucou-hook.exe`.

## The `coucou_agent` field

Add `coucou_agent` to the hook JSON payload, or pass `--agent <name>` to the relay. Coucou creates a pill with that name (`agent_<name>`) and routes the events to it.

Validation: `^[a-z0-9-]{1,24}$`. An absent or invalid name routes the event to the Claude Code pill.

## Hook command

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "C:\\path\\to\\coucou-hook.exe --agent my-tool" }
    ]
  }
}
```

The relay is installed at `%LOCALAPPDATA%\Coucou\bin\coucou-hook.exe` when the `claude` module starts. If the app does not answer within 300 ms the relay exits 0 with no output.

## Payload

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "my-session-1",
  "coucou_agent": "my-tool",
  "prompt": "Running task..."
}
```

Send newline-terminated JSON to the pipe if you skip the relay.

## Events

All standard Claude Code hook events are handled, except `PermissionRequest`: on this legacy channel only Claude Code gets an approval card, and a `PermissionRequest` from another agent is answered with no decision, so the agent asks in its own terminal. The built-in agents below have their own channel.

| Event | Effect |
|---|---|
| `SessionStart` | creates the pill, state idle |
| `UserPromptSubmit` | `thinking`; prompt shown |
| `PreToolUse` | `working`; tool label shown |
| `PostToolUse` / `PostToolUseFailure` | `working` |
| `Notification` | rate-limit or question state if applicable |
| `Stop` | `finished`; the pill is then removed |
| `StopFailure` | `error` |
| `SessionEnd` | removes the pill |
| `SubagentStart` / `SubagentStop` | step added |

Requires the `claude` module to be on: it owns the pipe.

## Quick test

With Coucou running:

```powershell
'{"hook_event_name":"UserPromptSubmit","session_id":"t1","prompt":"hello","coucou_agent":"demo"}' | & "$env:LOCALAPPDATA\Coucou\bin\coucou-hook.exe" --agent demo
```

A "demo" pill should appear.

## Built-in agents (the `agents` module)

The `agents` module ("Agentes", off by default) installs hooks for five agents and gives each its own pill `agent_<id>`. It uses its own channel (`--channel agents`) and does not need the `claude` module. Settings > Agentes shows, per agent, whether it is found, whether the hook is in place, and the exact diff before anything is written (backup first, explicit click, a file that changed in between is refused).

| Agent | File written (user level only) | Approval from the island |
|---|---|---|
| Codex | `%CODEX_HOME%` or `~/.codex/hooks.json` (merged) | Yes, via `PermissionRequest`. Open Codex and run `/hooks` once to trust the hooks |
| Cursor | `~/.cursor/hooks.json` (merged) | Yes, shell commands only (`beforeShellExecution`); the exe always prints `{"continue":true,"permission":"ask"}` when there is no decision, so Cursor never blocks. With the hook installed Cursor asks before every shell command |
| Gemini CLI | `~/.gemini/settings.json` (`hooks` merged) | No (observe only; its hooks cannot grant permissions) |
| Copilot CLI | `%COPILOT_HOME%` or `~/.copilot/hooks/coucou.json` (our own file) | No (observe only until its reply format is verified on a real CLI) |
| OpenCode | `~/.config/opencode/plugins/coucou.js` (our own file) | No (observe only) |

Approval needs the "Aprovar permissões pela ilha" switch. The only answers sent back are `allow` and `deny`; there is no "always" and no automatic approval. If Coucou is closed, paused, busy or the switch is off, the agent asks in its own window.

### Dialects

The hook exe takes `--format <codex|gemini|cursor|copilot|opencode>` and renames the agent's events to the ones above (no `--format` = Claude, unchanged): Gemini `BeforeAgent`/`BeforeTool`/`AfterTool`/`AfterAgent` become `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop`; Cursor `sessionStart`/`postToolUse`/`stop`/`sessionEnd` map the same way, `beforeShellExecution` becomes a `PermissionRequest` for the tool `Shell`, `conversation_id` becomes `session_id`, and `user_email` is dropped. Other tools can still send the events above with `--agent <name>` (legacy channel).
