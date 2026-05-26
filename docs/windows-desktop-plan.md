# Windows Desktop Plan

This document captures the current Windows support plan for the OpenWork desktop bridge pilot.

## Goal

Ship the same downloadable desktop UI on:

- macOS as a `.dmg`
- Windows as an `.exe`

The user flow should stay the same on both platforms:

1. install the desktop app
2. launch it
3. connect a remote OpenWork worker with URL + token
4. use the remote session with desktop-hosted local tools

## What already existed

The desktop packaging layer was already close to Windows-ready:

- [apps/desktop/electron-builder.yml](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/electron-builder.yml) already defines a `win` target using `nsis`
- [apps/desktop/package.json](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/package.json) already includes Windows dev/build scripts
- [.github/workflows/build-electron-desktop.yml](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/.github/workflows/build-electron-desktop.yml) already builds unpacked desktop artifacts on `windows-latest`

The main gap was runtime behavior, not installer generation.

## What changed on `feature/windows`

### 1. Cross-platform local shell bridge

The original desktop bridge pilot implemented `local-shell.exec` by assuming Unix commands such as:

- `pwd`
- `ls`
- `cat`
- `rg`

That works on macOS/Linux but is not safe to assume on Windows.

The bridge now implements those commands in Node instead of spawning platform-specific binaries.

Primary file:

- [apps/desktop/electron/desktop-local-tools.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/electron/desktop-local-tools.mjs)

Current behavior:

- `pwd` returns the approved local cwd
- `ls` lists files from approved roots
- `cat` reads approved files
- `rg` performs a text search over approved files without requiring a host `rg.exe`

This makes the read-only shell bridge substantially more portable.

### 2. Platform-aware computer-use advertising

Computer-use support in this repo is still macOS-specific today. The helper preparation script explicitly skips non-macOS builds.

Primary file:

- [apps/desktop/scripts/prepare-computer-use-helper.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/scripts/prepare-computer-use-helper.mjs)

To avoid lying to Windows users, the desktop bridge now advertises:

- browser bridge tools on all desktop platforms
- computer-use tools only on macOS

Primary file:

- [apps/desktop/electron/main.mjs](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/apps/desktop/electron/main.mjs)

This means a Windows build should support:

- remote worker connect
- desktop bridge transport
- local file tools
- restricted local shell tools
- embedded browser bridge

But it should not yet claim support for:

- screenshot/control style computer-use actions

### 3. Installer workflow for GitHub artifacts

Added a workflow that builds downloadable installer artifacts on both platforms:

- [.github/workflows/desktop-installers.yml](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/.github/workflows/desktop-installers.yml)

Current outputs:

- macOS installer artifacts from `macos-latest`
- Windows installer artifacts from `windows-latest`
- Windows UI smoke screenshots and a text/JSON shell snapshot from `windows-latest`

Current workflow note:

- the Windows installer workflow pins Node 22 on `windows-latest` because the current `better-sqlite3` dependency path is more reliable there than on Node 24 for GitHub-hosted runners

The workflow uploads everything from `apps/desktop/dist-electron/**`, which includes the generated installer payloads.

## Current Windows support status

## Supported now

- packaged Windows Electron desktop build path
- remote worker connect by URL + token
- desktop bridge WebSocket connection
- local file list/read/write/patch
- restricted local shell bridge through Node-backed `pwd` / `ls` / `cat` / `rg`
- embedded browser bridge

## Not supported yet

- native Windows computer-use backend
- Windows permission/onboarding UX for desktop automation
- Windows-specific approval ergonomics validation
- real device enrollment auth
- production audit/admin surface

## Validation done on this branch

Local validation completed on macOS:

- `pnpm --filter @openwork/desktop test:electron`
- `pnpm --filter @openwork/desktop typecheck:electron`
- `pnpm --filter openwork-server build`

These passed after the Windows branch changes.

GitHub Actions should be used for the actual Windows packaging result because there is no local Windows machine in this environment.

## How to build artifacts

### Manual GitHub workflow

Run:

- `Desktop Installers`

It will upload artifacts for:

- `openwork-macos-installer`
- `openwork-windows-installer`

The Windows artifact now also includes:

- `smoke-artifacts/windows-ui-smoke.png`
- `smoke-artifacts/windows-ui-smoke.json`
- `smoke-artifacts/windows-ui-smoke.txt`

### Optional remote-worker UI smoke

Added a second Windows-only workflow for true UI-to-worker validation:

- [.github/workflows/windows-remote-ui-smoke.yml](/Users/rameshpilli/Developer/open%20work%20and%20developer/openwork/.github/workflows/windows-remote-ui-smoke.yml)

This workflow is manual and expects GitHub secrets:

- `OPENWORK_TEST_WORKER_URL`
- `OPENWORK_TEST_WORKER_TOKEN`
- `OPENWORK_TEST_WORKER_NAME` (optional)
- `OPENWORK_TEST_PROMPT`
- `OPENWORK_TEST_EXPECT_TEXT` (optional)

What it does:

1. launches the Windows Electron app
2. opens `Add a worker`
3. connects `Connect custom remote`
4. fills the worker URL/token from secrets
5. opens or creates a session
6. sends a prompt
7. captures screenshots and a JSON/text run report

### What users should eventually download

- macOS users: `.dmg`
- Windows users: `.exe`

The server URL does not need to be embedded yet. Users can install the app first and connect the worker later through the UI.

## Recommended next Windows steps

1. Run the Windows installer workflow and verify the artifact completes successfully.
2. Smoke-test the `.exe` on a real Windows machine or VM.
3. Validate that the desktop bridge can:
   - connect to a remote worker
   - answer a Downloads-folder prompt using Windows paths
   - open a local browser tab
4. Add a real Windows computer-use backend if full desktop automation is required.
5. Add signed installer publishing if this is moving toward broader internal distribution.
