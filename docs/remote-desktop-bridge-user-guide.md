# Remote Desktop Bridge User Guide

This guide is the practical "how do I run this again" reference for the current OpenWork desktop bridge pilot.

It is written for the current POC, not the final production auth model.

## What this pilot does

With the patched OpenWork worker and desktop app:

- the user connects the desktop app to a remote OpenWork worker
- the worker can call local desktop-hosted tools on the user's machine
- file, browser, and computer-use actions can route back to the employee laptop instead of only running inside the Kubernetes pod

## Current pilot auth model

This pilot still uses a static client bearer token.

If you deploy the worker with the same environment values used in this test setup, the user-facing token is:

- Access token: `openwork-client-demo-token`

The host/admin token used internally by the worker-side MCP proxy and host-only APIs is:

- Host token: `openwork-host-demo-token`

Do not use this as the long-term enterprise auth model. It is only acceptable for a controlled pilot.

## Desktop connection values

When the worker is exposed at `http://127.0.0.1:18788`, use:

- Worker URL: `http://127.0.0.1:18788`
- Access token: `openwork-client-demo-token`
- Display name: `kind-openwork-test`

If you redeploy this to a real Kubernetes ingress, replace the URL only. The token stays whatever you configured in the worker environment.

## Kubernetes worker config used in this pilot

The current worker deployment was validated with these environment variables:

```bash
OPENWORK_CONNECT_HOST=127.0.0.1
OPENWORK_PORT=8787
OPENWORK_TOKEN=openwork-client-demo-token
OPENWORK_HOST_TOKEN=openwork-host-demo-token
OPENWORK_APPROVAL_MODE=auto
OPENWORK_CORS_ORIGINS=*
```

Optional desktop bridge policy env vars:

```bash
OPENWORK_DESKTOP_BRIDGE_ALLOWED_ROOTS='~/Downloads,~/Desktop,~/Documents,~/Developer'
OPENWORK_DESKTOP_BRIDGE_ALLOWED_COMMANDS='pwd,ls,cat,rg'
```

## How to run locally against Kubernetes

### 1. Start the desktop app

```bash
cd '/Users/rameshpilli/Developer/open work and developer'
./start-openwork.sh desktop
```

### 2. Expose the worker locally

```bash
kubectl -n openwork-test port-forward svc/openwork-remote 18788:8787
```

### 3. Connect from the OpenWork UI

In `Connect custom remote`, enter:

- Worker URL: `http://127.0.0.1:18788`
- Access token: `openwork-client-demo-token`
- Display name: `kind-openwork-test`

### 4. Open a normal session

Create a new session under the remote workspace and type prompts into the composer.

## What to test

Run these prompts in order:

### Local filesystem

- `What files are in my Downloads folder?`
- `Create a file called openwork-ui-test.txt in my Downloads folder with the content hello from the desktop bridge`
- `Replace hello with updated in /Users/rameshpilli/Downloads/openwork-ui-test.txt`
- `Read /Users/rameshpilli/Downloads/openwork-ui-test.txt`

Expected behavior:

- paths should resolve to `/Users/<username>/...`, not `/workspace/...`
- approval prompts should appear for write/patch actions

### Local browser

- `Open example.com in the local browser and tell me the page title`

Expected behavior:

- the embedded browser pane may appear on the right side
- the page title should come back as `Example Domain`

### Local computer use

- `Check my local computer-use permissions`
- `Take a snapshot of the OpenWork app on my machine`

Expected behavior:

- permission check should report the current Accessibility and Screen Recording state
- snapshot/control features may still fail until macOS permissions are granted

## Known pilot limitations

- static token reuse
- no SSO
- no device enrollment lifecycle
- no database-backed audit store
- no admin UI
- one-desktop-per-workspace assumption for the current bridge routing model
- Windows is not validated yet

## macOS permissions

Computer-use features depend on macOS permissions.

Check:

- `System Settings` → `Privacy & Security` → `Accessibility`
- `System Settings` → `Privacy & Security` → `Screen & System Audio Recording`

Relevant app names may appear as:

- `Electron`
- `OpenWork - Dev`
- `Computer Use`
- `ComputerUse`

If the app/helper does not appear in the permission list yet, trigger a computer-use action first so macOS registers it.

## How to know it is working

The pilot is working if:

- the desktop bridge status shows connected
- the worker sees local tools
- a Downloads-folder prompt reads `/Users/<username>/Downloads`
- write/patch actions change real local files
- browser actions affect the embedded local browser, not the pod

## What this does not mean yet

This does not mean the feature is production-ready.

For production, you still need:

- device-scoped auth
- SSO
- DB-backed audit
- device management
- stronger multi-user routing semantics
- Windows support if required by your endpoint fleet
