# Pilot Tester Rollout

This is the minimal rollout plan for a small desktop bridge PoC with about five testers.

It assumes:

- trusted internal testers only
- one OpenWork worker URL
- one host/admin token kept by the operator
- one unique client token per tester
- no SSO yet

## Recommended tester model

Use one collaborator token per tester instead of one shared client token.

Example:

1. Tester A
2. Tester B
3. Tester C
4. Tester D
5. Tester E

This is still a pilot, but it gives you basic separation and lets you revoke one tester without rotating everyone else.

## What each tester needs

Each tester only needs:

- the installer for their platform
- the worker URL
- their assigned access token

They do not need to:

- edit config files
- add plugin servers manually
- run shell commands
- configure MCP by hand

The intended flow is:

1. Install the app.
2. Open `Connect custom remote`.
3. Paste the worker URL.
4. Paste the assigned token.
5. Start testing.

## Operator values

Keep these private:

- the worker URL if it is internal-only
- the host token

Share these per tester:

- the worker URL
- the tester's client token

## How to mint five tester tokens

### Option 1: helper script

Use the built-in helper:

```bash
cd '/Users/rameshpilli/Developer/open work and developer/openwork'
pnpm pilot:tokens \
  --server-url https://worker.example.com \
  --host-token YOUR_HOST_TOKEN \
  --testers A,B,C,D,E \
  --output pilot-tokens.json
```

That prints a Markdown table and optionally writes a JSON file.

### Option 2: raw API

Mint one token at a time:

```bash
curl -X POST 'https://worker.example.com/tokens' \
  -H 'Authorization: Bearer YOUR_HOST_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"scope":"collaborator","label":"Pilot tester A"}'
```

Repeat for B, C, D, and E.

## Example pilot table

Example only:

| Tester | Platform | Token |
| --- | --- | --- |
| A | Windows | `owt_...` |
| B | Windows | `owt_...` |
| C | Windows | `owt_...` |
| D | macOS | `owt_...` |
| E | macOS | `owt_...` |

## Windows CI smoke secret

If you want the Windows CI job to connect to a real worker and send a prompt, store one of the tester tokens in GitHub Actions secrets:

- `OPENWORK_TEST_WORKER_URL`
- `OPENWORK_TEST_WORKER_TOKEN`
- `OPENWORK_TEST_WORKER_NAME`
- `OPENWORK_TEST_PROMPT`
- `OPENWORK_TEST_EXPECT_TEXT`

That lets the existing Windows installer workflow run the real `Connect custom remote` path and upload screenshots.

## GitHub-downloadable installers

There are two useful ways to distribute builds:

1. Workflow artifacts
   These come from `Desktop Installers` and are good for internal testing.

2. GitHub Release assets
   Use `Pilot Desktop Release` to publish a `.dmg` and `.exe` directly onto a GitHub Release page.

### How to publish a pilot release

From GitHub Actions, run:

- `Pilot Desktop Release`

Inputs:

- `release_tag`: something like `pilot-2026-05-26`
- `release_name`: optional
- `draft`: usually `true`
- `prerelease`: usually `true`

That workflow:

1. creates or updates a GitHub Release
2. builds the macOS and Windows installers
3. uploads the `.dmg` and `.exe` as release assets
4. uploads Windows smoke screenshots as workflow artifacts

## Minimum recommended next steps

For a real pilot with five testers, the minimum worthwhile steps are:

1. Give each tester a unique collaborator token.
2. Keep the host token private.
3. Publish a pilot GitHub Release with DMG/EXE assets.
4. Put one tester token into CI secrets so Windows smoke can hit a real worker.
5. Keep the tester scope limited to trusted users and non-sensitive environments.

## What this still does not solve

This is still not the final enterprise auth model.

Still pending after this pilot setup:

- SSO
- device-scoped enrollment
- stronger audit and operator views
- richer Windows support beyond the current shell/file/browser path
