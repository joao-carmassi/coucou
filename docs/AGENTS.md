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

All standard Claude Code hook events are handled, except `PermissionRequest`: only Claude Code gets an approval card. A `PermissionRequest` from another agent is answered with no decision, so the agent asks in its own terminal.

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

## Other agents' own hook formats

There are no built-in installers for Gemini CLI or Antigravity. To use them, write their hooks yourself with `--agent gemini` / `--agent antigravity`. The relay does not translate their event names; map them to the events above (Gemini `BeforeTool` = `PreToolUse`, `AfterTool` = `PostToolUse`, `BeforeAgent` = `UserPromptSubmit`, `AfterAgent` = `Stop`).
