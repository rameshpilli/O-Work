import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import electronBinary from "electron";
import { _electron as playwrightElectron } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");

function readArg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const direct = argv.find((entry) => entry.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return fallback;
}

function nonEmpty(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

async function ensureDir(targetPath) {
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function bodyText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 5_000 });
  } catch {
    return "";
  }
}

async function saveStepScreenshot(page, outDir, name) {
  const fileName = `${name}.png`;
  const screenshotPath = path.join(outDir, fileName);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function clickIfVisible(locator, timeout = 1500) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function connectRemoteWorkspace(page, config, outDir) {
  const addWorker = page.getByRole("button", { name: /Add a worker/i });
  if (!(await clickIfVisible(addWorker, 10_000))) {
    throw new Error("Could not find the Add a worker button in the desktop shell");
  }
  await saveStepScreenshot(page, outDir, "remote-connect-opened");

  const connectCustomRemote = page.getByRole("button", { name: /Connect custom remote/i });
  if (!(await clickIfVisible(connectCustomRemote, 10_000))) {
    throw new Error("Could not find the Connect custom remote option");
  }

  await page.getByLabel("Worker URL").fill(config.workerUrl);
  if (config.workerToken) {
    await page.getByLabel("Access token").fill(config.workerToken);
  }
  if (config.displayName) {
    await page.getByLabel(/Display name/i).fill(config.displayName);
  }
  await saveStepScreenshot(page, outDir, "remote-connect-form");

  const connectButton = page.getByRole("button", { name: /Connect remote/i });
  await connectButton.click();
  await page.waitForTimeout(3_000);
  await saveStepScreenshot(page, outDir, "remote-connect-submitted");
}

async function openOrCreateSession(page, outDir) {
  const composer = page.getByPlaceholder("Describe your task...");
  try {
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await saveStepScreenshot(page, outDir, "session-composer-ready");
    return composer;
  } catch {
    // fall through and try the new-task path
  }

  const newTaskButton = page.getByRole("button", { name: /New task/i }).first();
  if (!(await clickIfVisible(newTaskButton, 10_000))) {
    throw new Error("Could not find the New task button after connecting the workspace");
  }

  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await saveStepScreenshot(page, outDir, "session-created");
  return composer;
}

async function sendPrompt(page, composer, config, outDir) {
  if (!config.prompt) return null;
  await composer.fill(config.prompt);
  await composer.press("Enter");
  await saveStepScreenshot(page, outDir, "prompt-submitted");

  const promptEcho = page.getByText(config.prompt, { exact: false }).first();
  await promptEcho.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

  if (config.expectedText) {
    const expected = page.getByText(config.expectedText, { exact: false }).first();
    await expected.waitFor({ state: "visible", timeout: 120_000 });
  } else {
    await page.waitForTimeout(10_000);
  }
  await saveStepScreenshot(page, outDir, "prompt-result");
  return {
    prompt: config.prompt,
    expectedText: config.expectedText,
  };
}

async function waitForShell(page) {
  const expectedCues = [
    "OpenWork",
    "Describe your task",
    "Add a worker",
    "Connect custom remote",
    "Docs",
    "Feedback",
    "Sign in",
    "Ready",
  ];

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = await bodyText(page);
    if (expectedCues.some((cue) => text.includes(cue)) || text.trim().length >= 20) {
      return {
        matchedCues: expectedCues.filter((cue) => text.includes(cue)),
        bodyText: text,
      };
    }
    await page.waitForTimeout(1_000);
  }

  return {
    matchedCues: [],
    bodyText: await bodyText(page),
  };
}

async function main() {
  const outDir = await ensureDir(
    path.resolve(readArg("--outdir", path.join(desktopRoot, "dist-electron", "smoke-artifacts"))),
  );
  const userDataDir = await ensureDir(path.join(os.tmpdir(), "openwork-electron-smoke"));
  const isolatedHome = await ensureDir(path.join(userDataDir, "home"));
  const remoteConfig = {
    workerUrl: nonEmpty(process.env.OPENWORK_TEST_WORKER_URL ?? readArg("--worker-url")),
    workerToken: nonEmpty(process.env.OPENWORK_TEST_WORKER_TOKEN ?? readArg("--worker-token")),
    displayName: nonEmpty(process.env.OPENWORK_TEST_WORKER_NAME ?? readArg("--display-name")) ?? "windows-ci-worker",
    prompt: nonEmpty(process.env.OPENWORK_TEST_PROMPT ?? readArg("--prompt")),
    expectedText: nonEmpty(process.env.OPENWORK_TEST_EXPECT_TEXT ?? readArg("--expected-text")),
  };
  const app = await playwrightElectron.launch({
    executablePath: electronBinary,
    args: [path.join(desktopRoot, "electron", "main.mjs")],
    env: {
      ...process.env,
      OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE || "1",
      OPENWORK_ALLOW_MULTI_INSTANCE: "1",
      OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT || "0",
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: isolatedHome,
      LOCALAPPDATA: isolatedHome,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || userDataDir,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    await saveStepScreenshot(page, outDir, "startup");

    const snapshot = await waitForShell(page);
    const title = await page.title().catch(() => "");
    const currentUrl = page.url();
    const screenshotPath = await saveStepScreenshot(page, outDir, "windows-ui-smoke");

    let remoteSmoke = null;
    if (remoteConfig.workerUrl) {
      await connectRemoteWorkspace(page, remoteConfig, outDir);
      const composer = await openOrCreateSession(page, outDir);
      remoteSmoke = await sendPrompt(page, composer, remoteConfig, outDir);
    }

    const report = {
      title,
      url: currentUrl,
      recognizedShell: title.includes("OpenWork") || snapshot.bodyText.trim().length >= 20,
      matchedCues: snapshot.matchedCues,
      bodyTextPreview: snapshot.bodyText.slice(0, 2_000),
      screenshotPath,
      remoteSmoke,
    };

    await writeFile(path.join(outDir, "windows-ui-smoke.json"), JSON.stringify(report, null, 2), "utf8");
    await writeFile(path.join(outDir, "windows-ui-smoke.txt"), snapshot.bodyText, "utf8");
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
