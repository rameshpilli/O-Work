# Desktop Reverse Bridge POC

This POC adds an Electron-side outbound bridge client for the "brain in K8s, body on laptop" model.

What it does today:

- Loads a local enrollment file from the Electron user-data directory.
- Opens one outbound WebSocket to a remote server URL.
- Authenticates with an enrollment token.
- Advertises three minimal local tools:
  - `local-fs.list`
  - `local-fs.read`
  - `local-shell.exec`
- Executes tool calls on the employee machine and streams results back.

What it does not do yet:

- No server-side router or session binding in `apps/server/src`
- No SSO
- No approval prompts
- No computer-use or browser tools
- No renderer settings UI yet

## Enrollment File

The Electron main process reads:

- macOS dev/prod: `<userData>/openwork-desktop-bridge.json`

Current shape:

```json
{
  "enabled": true,
  "serverUrl": "https://worker.example.com",
  "enrollmentToken": "enroll_demo_token",
  "deviceName": "Ramesh MacBook Pro",
  "allowedRoots": [
    "~/Downloads",
    "~/Desktop",
    "~/Documents",
    "~/Developer"
  ]
}
```

The same values can be overridden by env vars:

- `OPENWORK_DESKTOP_BRIDGE_ENABLED`
- `OPENWORK_DESKTOP_BRIDGE_SERVER_URL`
- `OPENWORK_DESKTOP_BRIDGE_WEBSOCKET_URL`
- `OPENWORK_DESKTOP_BRIDGE_ENROLLMENT_TOKEN`
- `OPENWORK_DESKTOP_BRIDGE_ALLOWED_ROOTS`

## Default WebSocket Path

If `websocketUrl` is omitted, Electron derives:

```text
https://worker.example.com -> wss://worker.example.com/desktop-bridge/v1/connect
http://127.0.0.1:8787 -> ws://127.0.0.1:8787/desktop-bridge/v1/connect
```

## Wire Protocol

Electron sends:

- `client_hello`
- `capabilities_advertise`
- `heartbeat`
- `tool_started`
- `tool_stdout`
- `tool_stderr`
- `tool_result`
- `client_error`

Electron accepts:

- `server_hello`
- `enrolled`
- `capabilities_request`
- `ping`
- `tool_call`
- `revoke`

Minimal `tool_call` examples:

```json
{
  "type": "tool_call",
  "callId": "call_123",
  "toolName": "local-fs.list",
  "input": {
    "path": "~/Downloads"
  }
}
```

```json
{
  "type": "tool_call",
  "callId": "call_124",
  "toolName": "local-fs.read",
  "input": {
    "path": "~/Downloads/example.txt"
  }
}
```

```json
{
  "type": "tool_call",
  "callId": "call_125",
  "toolName": "local-shell.exec",
  "input": {
    "command": "rg",
    "pattern": "TODO",
    "paths": [
      "~/Developer/project"
    ],
    "flags": [
      "-n"
    ]
  }
}
```

## Restricted Shell Policy

`local-shell.exec` only supports:

- `pwd`
- `ls`
- `cat`
- `rg`

It is intentionally structured, not free-form shell text. Every file or directory path is resolved against approved roots before execution.

## Desktop IPC Hooks

Electron now exposes these `openwork:desktop` actions for later renderer wiring:

- `getDesktopBridgeEnrollment`
- `setDesktopBridgeEnrollment`
- `getDesktopBridgeStatus`
- `restartDesktopBridge`
- `stopDesktopBridge`

That keeps future UI work out of manual MCP config or command-line setup.
