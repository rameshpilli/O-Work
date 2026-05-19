# Daytona sandbox flows

End-to-end scenarios that run against a real Electron OpenWork instance in a
Daytona cloud sandbox. The agent drives the app through CDP browser tools
(`browser_list`, `browser_evaluate`, `browser_screenshot`, etc.) over the
Daytona proxy.

## Preflight

### 1. Create the sandbox

```bash
daytona create \
  --name openwork-test \
  --dockerfile .devcontainer/Dockerfile.daytona-vnc \
  --context .devcontainer/Dockerfile.daytona-vnc \
  --context .devcontainer/start-daytona-vnc.sh \
  --class large \
  --memory 8 \
  --disk 10 \
  --auto-stop 60 \
  --public \
  --target us
```

Use the Daytona VNC-capable base image (`daytonaio/sandbox`) rather than the
generic devcontainer image. It includes XFCE, Xvfb, x11vnc, noVNC, websockify,
and dbus-x11. `--disk 10` is required because the default 3 GB disk can fill up
during dependency and sidecar work.

### 2. Start services

```bash
daytona exec openwork-test 'bash -lc "cd /workspace && nohup bash .devcontainer/start-daytona-vnc.sh > /tmp/start-vnc.log 2>&1 &"'

daytona exec openwork-test 'bash -lc "cd /workspace/apps/app && nohup env OPENWORK_DEV_MODE=1 pnpm exec vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 &"'

daytona exec openwork-test 'bash -lc "cd /workspace && nohup env DISPLAY=:99 ELECTRON_DISABLE_SANDBOX=1 OPENWORK_REACT_DEVTOOLS=0 OPENWORK_DEV_MODE=1 OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825 pnpm --filter @openwork/desktop dev:electron > /tmp/electron.log 2>&1 &"'
```

Wait ~35-60s for XFCE/noVNC + Vite + Electron + opencode sidecar to boot.

### 3. Get the CDP proxy URL

```bash
daytona preview-url openwork-test -p 9825
```

This returns something like `https://9825-xxx.daytonaproxy01.net`.

### 4. Verify connectivity

Use the `browser_list` tool:

```
browser_list({ browser_url: "https://9825-xxx.daytonaproxy01.net" })
```

Should return the OpenWork page target.

### 5. Verify opencode sidecar

```bash
daytona exec openwork-test 'ps aux | grep opencode | grep -v grep'
```

If no opencode process, the workspace hasn't been created yet (expected on fresh sandbox).

---

## Flow 1: Create a local workspace

**Goal:** Create a workspace named "hello" from the Welcome page.

### Steps

1. Create the workspace directory on the sandbox:
   ```bash
   daytona exec openwork-test 'mkdir -p /workspace/hello'
   ```

2. Verify we're on the Welcome page:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "window.location.hash" })
   → "#/welcome"
   ```

3. Click "Get started" to expand options:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Get started') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

4. Click "Local workspace":
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Local workspace') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

5. Wait 2s, then inject the folder path into the CreateWorkspaceModal React reducer:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "JSON.stringify((function() { function findFiber(el) { var key = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); }); return key ? el[key] : null; } var spans = document.querySelectorAll('span'); var p = null; for (var i = 0; i < spans.length; i++) { if (spans[i].textContent.indexOf('No folder') !== -1) { p = spans[i]; break; } } if (!p) return {err: 'no placeholder'}; var fiber = findFiber(p); while (fiber) { var name = (fiber.elementType && fiber.elementType.name) || (fiber.type && fiber.type.name) || ''; if (name === 'CreateWorkspaceModal') break; fiber = fiber.return; } if (!fiber) return {err: 'no fiber'}; var hook = fiber.memoizedState; while (hook) { if (hook.queue && hook.queue.dispatch) { hook.queue.dispatch({ key: 'selectedFolder', value: '/workspace/hello' }); hook.queue.dispatch({ key: 'pickingFolder', value: false }); return {ok: true}; } hook = hook.next; } return {err: 'no dispatch'}; })())" })
   ```

   **Key:** The reducer uses `{ key, value }` action format, NOT direct state replacement.

6. Verify "Create Workspace" is enabled (not disabled):
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === 'Create Workspace') return btns[i].disabled ? 'DISABLED' : 'ENABLED'; } return 'not found'; })()" })
   → "ENABLED"
   ```

7. Click "Create Workspace":
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === 'Create Workspace' && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

8. Wait 10s for workspace creation + opencode sidecar boot.

9. Verify navigation to session page:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "window.location.hash" })
   → should contain "/session"
   ```

10. Verify opencode sidecar started:
    ```bash
    daytona exec openwork-test 'ps aux | grep opencode | grep -v grep'
    → should show opencode serve process
    ```

### Expected outcome
- URL contains `#/workspace/ws_.../session`
- Sidebar shows "hello" workspace
- Status bar shows "OpenWork Ready"
- opencode process running on a random port

---

## Flow 2: Send a message in a session

**Prerequisite:** Flow 1 completed (workspace exists, opencode running).

### Steps

1. Click a starter card to create a session:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Edit a CSV') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

2. Wait 5s for session creation.

3. Verify session URL:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "window.location.hash" })
   → should contain "/session/ses_"
   ```

4. Focus the composer and type a message:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var editor = document.querySelector('[contenteditable=true]'); if (!editor) return 'no editor'; editor.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, 'Hello from Daytona! List the files in the current directory.'); return 'typed'; })()" })
   ```

   **Key:** Use `document.execCommand('insertText', ...)` for Lexical editors, NOT `textContent =` or `innerHTML =`.

5. Click "Run task":
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Run task') !== -1 && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

6. Wait 15s for LLM response.

7. Verify agent response appeared:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "document.body.innerText.substring(0, 500)" })
   → should contain the agent's response about directory contents
   ```

### Expected outcome
- Session title auto-generated in sidebar
- Agent response visible in the chat
- No errors in console

---

## Flow 3: Take a screenshot

```
browser_screenshot({ browser_url: CDP_URL })
```

Returns path to a PNG file. Verify it's not empty.

---

## Flow 4: Connect OpenAI via UI and run GPT-5.5

**Goal:** Prove provider key setup works through the Electron UI, not by editing
`opencode.jsonc` directly.

### Source references for controls

Use these files to choose stable selectors before guessing DOM structure:

| UI control | Preferred selector | Source file |
|---|---|---|
| Settings button | `button[aria-label="Settings"]` | `apps/app/src/react-app/domains/session/chat/status-bar.tsx` |
| AI Providers tab | button text `AI Providers` | `apps/app/src/react-app/domains/settings/shell/settings-page.tsx`, `settings-route.tsx` |
| Connect provider | button text `Connect provider` | `apps/app/src/react-app/domains/settings/pages/ai-view.tsx` |
| Provider search | `input[placeholder="Filter providers by name or ID"]` | `apps/app/src/react-app/domains/connections/provider-auth/provider-auth-modal.tsx` |
| OpenAI provider row | button containing `OpenAI` and `openai` | `provider-auth-modal.tsx` |
| Manual key method | button containing `Manually enter API Key` | `provider-auth-modal.tsx` |
| API key input | `input[type="password"][placeholder="sk-..."]` | `provider-auth-modal.tsx` |
| Save key | button text `Save key` | `provider-auth-modal.tsx` |
| New task/session | `button[aria-label="New task"]` | `apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx` |
| Composer | `[contenteditable="true"][data-lexical-editor="true"]` | `apps/app/src/react-app/domains/session/surface/composer/editor.tsx` and `composer.tsx` |
| Run task | button text `Run task` | `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` |
| Model selector | `button[aria-label="Change model"]` | `composer.tsx` |
| Model picker rows | button text containing model display name/id | model picker rendered from session route state |

### Selector helpers

Prefer text and ARIA selectors over React internals. Use React fiber only for
native file-picker state injection during workspace creation.

Click by exact text:

```js
(function clickText(text) {
  var el = Array.from(document.querySelectorAll('button')).find(function (node) {
    return node.textContent.trim() === text && !node.disabled;
  });
  if (!el) return 'not found: ' + text;
  el.click();
  return 'clicked: ' + text;
})('AI Providers')
```

Click by ARIA label:

```js
(function clickAria(label) {
  var el = Array.from(document.querySelectorAll('button,a')).find(function (node) {
    return node.getAttribute('aria-label') === label && !node.disabled;
  });
  if (!el) return 'not found: ' + label;
  el.click();
  return 'clicked: ' + label;
})('Settings')
```

Set React-controlled inputs:

```js
(function setInput(selector, value) {
  var input = document.querySelector(selector);
  if (!input) return 'not found: ' + selector;
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  return 'set: ' + selector;
})('input[placeholder="Filter providers by name or ID"]', 'openai')
```

Paste into the Lexical composer:

```js
(function pasteComposer(text) {
  var editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  if (!editor) return 'no editor';
  editor.focus();
  var data = new DataTransfer();
  data.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  return editor.innerText;
})('Reply with exactly: Daytona UI key OK')
```

`document.execCommand('insertText')` may no-op in Electron/CDP for this Lexical
editor. The synthetic paste event is the reliable path.

### Steps

1. Create a workspace using Flow 1.

2. Open Settings:
   ```js
   (function(){var el=Array.from(document.querySelectorAll('button,a')).find(function(n){return n.getAttribute('aria-label')==='Settings'}); if(!el)return 'not found'; el.click(); return 'clicked';})()
   ```

3. Open AI Providers:
   ```js
   (function(){var b=Array.from(document.querySelectorAll('button')).find(function(n){return n.textContent.trim()==='AI Providers'}); if(!b)return 'not found'; b.click(); return 'clicked';})()
   ```

4. Click `Connect provider`.

5. Search for `openai` using `input[placeholder="Filter providers by name or ID"]`.

6. Click the provider row containing `OpenAI`, then click `Manually enter API Key`.

7. Fill the password input and click `Save key`:
   ```js
   (function(key){
     var input=document.querySelector('input[type="password"][placeholder="sk-..."]');
     if(!input)return 'no key input';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,key);
     input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:key}));
     var save=Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent.trim()==='Save key' && !b.disabled});
     if(!save)return 'save disabled';
     save.click();
     return 'submitted';
   })('sk-...')
   ```

8. Verify AI Providers shows OpenAI as connected. Expected text includes:
   `2 providers connected`, `OpenAI`, and `Disconnect`.

9. Click `Pick a new default?`, open `OpenAI`, select `Default model`, then click
   `GPT-5.5gpt-5.5`. The composer should show `GPT-5.5`.

10. Click `Back to app`, then `button[aria-label="New task"]`.

11. Paste into the composer using the `pasteComposer` helper and click `Run task`.

12. Verify the response contains `Daytona UI key OK` and session messages show
    `providerID: openai`, `modelID: gpt-5.5`, `variant: medium`.

### Expected outcome

- OpenAI appears as a connected provider in Settings.
- The model selector shows `GPT-5.5`.
- The session assistant response is successful, not `ProviderAuthError`.
- No API key is committed or written into repo docs.

---

## Teardown

```bash
daytona stop openwork-test    # preserves state
daytona delete openwork-test  # destroys everything
```

---

## Troubleshooting

**"Create Workspace" stays disabled after path injection:**
The reducer uses `{ key, value }` actions. If you dispatched a full state object, it won't work.

**Lexical editor doesn't accept text:**
Use `document.execCommand('insertText', false, text)` after focusing. Direct `textContent` assignment doesn't trigger Lexical's internal state update.

**opencode sidecar not starting:**
Check memory and disk. Electron + opencode + Vite needs ~6GB. Use `--memory 8`.
Dependencies/sidecars need more than the default 3GB disk; use `--disk 10`.

**CDP timeouts:**
The renderer might be frozen (e.g., a blocking IPC call). Restart Electron:
```bash
daytona exec openwork-test 'bash -lc "pkill -f electron || true; pkill -f electron-dev || true"'
sleep 3
daytona exec openwork-test 'bash -lc "cd /workspace && nohup env DISPLAY=:99 ELECTRON_DISABLE_SANDBOX=1 OPENWORK_REACT_DEVTOOLS=0 OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825 OPENWORK_DEV_MODE=1 pnpm --filter @openwork/desktop dev:electron > /tmp/electron.log 2>&1 &"'
```

`[openwork] Electron CDP exposed...` only means OpenWork requested CDP. The real
success marker is Chromium's own `DevTools listening on ws://127.0.0.1:9825/...`
line in `/tmp/electron.log`.
