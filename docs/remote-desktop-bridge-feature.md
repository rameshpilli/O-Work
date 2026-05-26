# Remote Desktop Bridge for Self-Hosted OpenWork

This document records the feature we implemented to prove a "brain in Kubernetes, body on the employee laptop" architecture for OpenWork.

It is written as both:

- a product feature note that can be used later for an upstream proposal or PR write-up
- an internal SOP/reference for deploying and testing the feature again

## Summary

Stock OpenWork already supports connecting the desktop app to a remote worker by URL and token. What it did **not** support was routing tool execution back to the employee machine. A prompt like "What files are in my Downloads folder?" still ran against the remote container filesystem and returned `/workspace` or `/root`, not the user's real laptop paths.

This feature adds a reverse desktop bridge so the remote worker can discover and call local desktop tools hosted by the Electron app over one outbound connection from the laptop.

With this feature in place, a remote OpenWork session can use desktop-hosted tools such as:

- `local-fs.list`
- `local-fs.read`
- `local-shell.exec`

The key proof is that a natural-language prompt asking for the Downloads folder was successfully answered from the real macOS path on the employee machine instead of the Kubernetes pod.

## Problem

### Before this feature

- User installs OpenWork desktop.
- User connects to a remote self-hosted OpenWork worker with a URL and token.
- Session runs successfully.
- Any shell or filesystem action still executes inside the remote workspace container.

Example failure mode:

- Prompt: `What files are in my Downloads folder?`
- Result: looks in `/workspace/Downloads` or `~/Downloads` inside the Linux pod
- Outcome: "There is no Downloads folder in this environment."

This makes the remote worker usable as a remote coding or workspace agent, but **not** as a real desktop agent.

### Why this matters

The intended product model is:

- remote orchestration in Kubernetes
- local execution on the employee laptop
- simple end-user setup through the existing desktop UI

Without this bridge, the desktop app is only a remote session client.

## Goal

Allow a user to:

1. install the OpenWork desktop app
2. paste a worker URL and token into `Connect custom remote`
3. open a session
4. ask normal prompts like `What files are in my Downloads folder?`
5. get results from their own machine, not the pod

## High-Level Design

The implemented design uses a reverse MCP-style bridge instead of a second custom tool system.

### Core idea

- Electron hosts local tools.
- Electron opens one outbound WebSocket to the remote worker.
- The remote worker registers the connected desktop as a session-scoped tool source.
- The remote session can then call those local tools through an MCP proxy.

### Why this approach

- It fits OpenWork/OpenCode's existing MCP-oriented architecture.
- It avoids inventing a parallel tool protocol for the server.
- It keeps the desktop app installation flow simple.
- It allows future policy, approvals, and audit controls to remain server-driven.

## What Was Implemented

### 1. Desktop bridge registry and transport on the worker

Added a worker-side desktop bridge registry that tracks:

- connected devices
- advertised local tools
- connection state
- allowed local roots
- per-workspace bridge binding

Primary implementation:

- [apps/server/src/desktop-bridge.ts](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/server/src/desktop-bridge.ts)

### 2. Worker-side MCP injection

When a desktop bridge is connected for a remote workspace, the worker injects a bridge-backed MCP entry into the workspace OpenCode config so the session can see desktop tools.

Primary implementation:

- [apps/server/src/server.ts](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/server/src/server.ts)

### 3. MCP proxy process bundled into the worker image

The worker image now includes a bundled bridge MCP proxy script and points the injected MCP config at that script.

Primary implementation:

- [packages/openwork-ui-mcp/desktop-bridge-mcp.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/packages/openwork-ui-mcp/desktop-bridge-mcp.mjs)
- [packages/openwork-ui-mcp/package.json](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/packages/openwork-ui-mcp/package.json)
- [packaging/docker/Dockerfile.microsandbox](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/packaging/docker/Dockerfile.microsandbox)

### 4. Electron outbound bridge client

Electron starts a background bridge client that:

- reads bridge enrollment/config
- connects to the remote worker over WebSocket
- advertises local capabilities
- executes tool calls locally
- streams results back

Primary implementation:

- [apps/desktop/electron/desktop-bridge-client.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/electron/desktop-bridge-client.mjs)
- [apps/desktop/electron/desktop-bridge-config.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/electron/desktop-bridge-config.mjs)
- [apps/desktop/electron/main.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/electron/main.mjs)

### 5. Local tool adapters on the desktop

The current desktop toolset is intentionally limited:

- `local-fs.list`
- `local-fs.read`
- `local-shell.exec`

`local-shell.exec` is restricted to:

- `pwd`
- `ls`
- `cat`
- `rg`

Primary implementation:

- [apps/desktop/electron/desktop-local-tools.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/electron/desktop-local-tools.mjs)

### 6. Session context hinting so the model chooses the right machine

The session environment context now exposes exact approved desktop roots. This reduces wrong guesses like `/Users/art/Downloads` and steers the model toward the actual user paths.

Primary implementation:

- [apps/app/src/react-app/domains/session/sync/env-context.ts](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/app/src/react-app/domains/session/sync/env-context.ts)
- [apps/app/src/app/lib/openwork-server.ts](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/app/src/app/lib/openwork-server.ts)

### 7. Desktop session route fix for remote workspaces

There was an existing app bug where the desktop UI still depended on its local OpenWork control plane even for remote workspaces, causing the recurring `Workspace or session not found` error when creating tasks.

That was fixed so the remote flow remains usable while the bridge is active.

Primary implementation:

- [apps/app/src/react-app/shell/desktop-local-openwork.ts](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/app/src/react-app/shell/desktop-local-openwork.ts)
- [apps/app/src/react-app/shell/session-route.tsx](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/app/src/react-app/shell/session-route.tsx)

## End-to-End Proof

This feature was tested end to end against:

- local Electron desktop app on macOS
- self-hosted OpenWork worker running in Kubernetes
- worker exposed locally through port-forward for development

### Successful proof prompt

`What files are in my Downloads folder?`

### Expected proof behavior

The session should call the desktop bridge tool and inspect the user's real Downloads directory, for example:

- `/Users/<username>/Downloads`

It should **not** inspect:

- `/workspace/Downloads`
- `/root/Downloads`
- `~/Downloads` in the Linux pod unless the model is explicitly talking about the remote workspace

### What was verified

- the worker injected the bridge MCP config into the remote workspace
- the worker image contained the bridge proxy script
- the Electron desktop bridge connected and advertised tools
- the worker saw the device and approved roots
- the prompt was answered using `openwork-desktop-bridge_local-fs-list`
- the tool input used the real local path on the Mac

## User Experience

## Current test flow

Today, for this POC, the user setup is:

1. Install the desktop app.
2. Open `Connect custom remote`.
3. Paste the remote worker URL.
4. Paste the token.
5. Open a session.

The bridge config is currently auto-derived from that remote workspace selection in the desktop app.

### What the user does not have to do

The user does **not** have to:

- manually configure MCP
- run local terminal commands
- create tunnels
- edit JSON files
- manage ports manually in production

That is the right product direction.

## Multi-User Model

Yes, this architecture supports multiple users, but not by sharing one anonymous connection.

The server must distinguish:

- `workspace_id`
- `user_id`
- `device_id`
- `connection_id`
- advertised tool set
- approved roots or policy scope

### Current POC model

The current POC is sufficient for testing, but it is not the final multi-user production model:

- one desktop bridge connection is associated with one remote workspace
- the same worker token is reused as the bridge enrollment token
- there is no independent device enrollment lifecycle yet

### Production model

For production, each desktop should have:

- a device identity
- a user binding
- a short-lived bridge credential or device token
- a server-side session-to-device routing rule

That lets one shared OpenWork deployment in Kubernetes serve many users safely.

## Why This Is Not Yet Production-Ready

This POC proves the architecture, but it is **not** ready for broad enterprise rollout yet.

### Missing production controls

- No approval prompts for risky actions
- No write-capable local tools with guardrails
- No browser/computer-use bridge in the production path
- No separate desktop enrollment token lifecycle
- No SSO
- No durable audit/event pipeline
- No device management or revocation UX
- No mature multi-device arbitration for one user with multiple machines

### Important security limitation

The POC currently reuses the remote worker token as the desktop bridge enrollment token. That is acceptable for a controlled proof of concept, but it should be split into a proper device enrollment/authentication flow before production use.

## What Is Ready Today

The following statement is accurate:

> A self-hosted OpenWork worker can be deployed in Kubernetes, a user can connect through the existing desktop UI using a URL and token, and a remote session can call limited read-only tools on the user's machine through the desktop bridge.

The following statement is **not** accurate yet:

> This is fully production-ready for enterprise rollout.

## Recommended Production Hardening Plan

### Phase 1: Authentication and device identity

- introduce explicit device enrollment tokens
- stop reusing the worker session token as the bridge credential
- add device registration and revocation on the server

### Phase 2: Policy and approvals

- add server-driven approval requirements for selected tools
- add desktop UI prompts for approval
- enforce allowed roots and allowed commands from server policy, not only local config

### Phase 3: Observability and audit

- persist bridge connection events
- persist tool call metadata and outcomes
- add operator-visible health and last-seen views

### Phase 4: Multi-user and multi-device

- bind bridge connections to users and devices explicitly
- support reconnect and failover cleanly
- define which device owns a session when a user has multiple desktops

### Phase 5: Rich local capabilities

- local write/edit tools
- browser bridge
- computer-use bridge
- higher-risk actions behind approval and policy

## Deployment SOP

## Development or test deployment

1. Build the updated worker image from this repo.
2. Deploy it to Kubernetes.
3. Expose it through ingress or temporary port-forwarding.
4. Install and launch the desktop app.
5. Connect the desktop app to the worker with URL and token.
6. Open a session and test with:
   - `What files are in my Downloads folder?`
   - `Read /Users/<username>/Downloads/<file>`
   - `Search /Users/<username>/Developer for TODO`

## Production-oriented deployment target

1. Deploy the worker behind a stable HTTPS URL.
2. Issue per-user or per-device enrollment credentials.
3. Distribute the desktop app through managed IT channels if possible.
4. Prefer prefilled server URL or managed configuration over asking users to type it manually.
5. Add approval and audit before enabling anything beyond read-only local access.

## Open Source Proposal Notes

If proposing this upstream later, the feature should be framed as:

### Title

Remote desktop bridge for self-hosted OpenWork: session-scoped local tool execution from the Electron client

### Problem statement

Remote OpenWork workers can host sessions and workspaces, but stock sessions cannot execute filesystem or shell actions on the employee laptop. This prevents the desktop app from acting as a real local agent in enterprise self-hosted deployments.

### Proposed solution

Introduce a reverse bridge from the Electron client to the remote worker that exposes a limited local tool surface through an MCP proxy, with future support for approvals, policy, and audit.

### Immediate value

- preserves the existing `Connect custom remote` UX
- makes self-hosted OpenWork useful as a true desktop agent
- keeps the control plane on the server while the body stays on the laptop

## Bottom Line

This feature proves the architecture is viable.

If you deploy only stock OpenWork in Kubernetes and hand users a URL and token, they will connect successfully, but their shell and file actions will still run in the pod.

With this bridge feature, the same UI flow can reach back to the user machine for limited local actions.

That means the idea is correct, the implementation path is real, and the next work is product hardening rather than architectural reinvention.
