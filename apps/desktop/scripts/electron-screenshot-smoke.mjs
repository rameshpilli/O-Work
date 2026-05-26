import { mkdir, readdir, writeFile } from "node:fs/promises";
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

async function clickIfVisible(locator, timeout = 1_500) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
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

async function connectRemoteWorkspace(page, config) {
  const addWorker = page.getByRole("button", { name: /Add a worker/i });
  if (!(await clickIfVisible(addWorker, 10_000))) {
    throw new Error("Could not find the Add a worker button in the desktop shell");
  }

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

  const connectButton = page.getByRole("button", { name: /Connect remote/i });
  await connectButton.click();
  await page.waitForTimeout(3_000);
}

async function openOrCreateSession(page) {
  const composer = page.getByPlaceholder("Describe your task...");
  try {
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    return composer;
  } catch {
    // fall through and try the new-task path
  }

  const newTaskButton = page.getByRole("button", { name: /New task/i }).first();
  if (!(await clickIfVisible(newTaskButton, 10_000))) {
    throw new Error("Could not find the New task button after connecting the workspace");
  }

  await composer.waitFor({ state: "visible", timeout: 15_000 });
  return composer;
}

async function sendPrompt(page, composer, config) {
  if (!config.prompt) return null;
  await composer.fill(config.prompt);
  await composer.press("Enter");

  const promptEcho = page.getByText(config.prompt, { exact: false }).first();
  await promptEcho.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

  if (config.expectedText) {
    const expected = page.getByText(config.expectedText, { exact: false }).first();
    await expected.waitFor({ state: "visible", timeout: 120_000 });
  } else {
    await page.waitForTimeout(10_000);
  }

  return {
    prompt: config.prompt,
    expectedText: config.expectedText,
  };
}

function buildTests(remoteConfig) {
  return [
    {
      name: "01-openwork-shell",
      description: "Boot the Electron shell and confirm the app frame is visible",
      run: async (page, ctx) => {
        await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        const snapshot = await waitForShell(page);
        ctx.metadata.snapshot = snapshot;
        ctx.metadata.title = await page.title().catch(() => "");
        ctx.metadata.url = page.url();
        await ctx.screenshot("01-openwork-shell");
        if (!(ctx.metadata.title.includes("OpenWork") || snapshot.bodyText.trim().length >= 20)) {
          throw new Error("OpenWork shell did not render recognizable content");
        }
      },
    },
    {
      name: "02-remote-connect-opened",
      description: "Open the worker picker and show the remote connect entry point",
      skip: !remoteConfig.workerUrl,
      run: async (page, ctx) => {
        const addWorker = page.getByRole("button", { name: /Add a worker/i });
        if (!(await clickIfVisible(addWorker, 10_000))) {
          throw new Error("Could not find the Add a worker button in the desktop shell");
        }
        await ctx.screenshot("02-remote-connect-opened");
      },
    },
    {
      name: "03-remote-connect-form",
      description: "Open the custom remote form and fill URL/token fields",
      skip: !remoteConfig.workerUrl,
      run: async (page, ctx) => {
        const connectCustomRemote = page.getByRole("button", { name: /Connect custom remote/i });
        if (!(await clickIfVisible(connectCustomRemote, 10_000))) {
          throw new Error("Could not find the Connect custom remote option");
        }
        await page.getByLabel("Worker URL").fill(remoteConfig.workerUrl);
        if (remoteConfig.workerToken) {
          await page.getByLabel("Access token").fill(remoteConfig.workerToken);
        }
        if (remoteConfig.displayName) {
          await page.getByLabel(/Display name/i).fill(remoteConfig.displayName);
        }
        await ctx.screenshot("03-remote-connect-form");
      },
    },
    {
      name: "04-remote-connect-submitted",
      description: "Submit the remote workspace form",
      skip: !remoteConfig.workerUrl,
      run: async (page, ctx) => {
        const connectButton = page.getByRole("button", { name: /Connect remote/i });
        await connectButton.click();
        await page.waitForTimeout(3_000);
        await ctx.screenshot("04-remote-connect-submitted");
      },
    },
    {
      name: "05-session-ready",
      description: "Open or create a session and wait for the composer",
      skip: !remoteConfig.workerUrl,
      run: async (page, ctx) => {
        const composer = await openOrCreateSession(page);
        ctx.metadata.composerReady = true;
        await ctx.screenshot("05-session-ready");
        if (!composer) {
          throw new Error("Composer was not available after connecting the remote workspace");
        }
      },
    },
    {
      name: "06-prompt-roundtrip",
      description: "Submit a prompt to the connected remote worker and capture the result",
      skip: !remoteConfig.workerUrl || !remoteConfig.prompt,
      run: async (page, ctx) => {
        const composer = page.getByPlaceholder("Describe your task...");
        const remoteSmoke = await sendPrompt(page, composer, remoteConfig);
        ctx.metadata.remoteSmoke = remoteSmoke;
        await ctx.screenshot("06-prompt-roundtrip");
      },
    },
  ];
}

async function runSuite(page, outDir, tests) {
  const metadata = {};
  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const test of tests) {
    if (test.skip) {
      skipped += 1;
      results.push({
        name: test.name,
        description: test.description,
        status: "skipped",
      });
      continue;
    }

    const ctx = {
      metadata,
      screenshot: async (name) => {
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
      },
    };

    try {
      await test.run(page, ctx);
      passed += 1;
      results.push({
        name: test.name,
        description: test.description,
        status: "passed",
      });
      console.log(`  ✓ ${test.name} — ${test.description}`);
    } catch (error) {
      failed += 1;
      results.push({
        name: test.name,
        description: test.description,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(`  ✗ ${test.name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { metadata, results, passed, failed, skipped };
}

async function main() {
  const outDir = await ensureDir(
    path.resolve(readArg("--outdir", path.join(desktopRoot, "dist-electron", "smoke-artifacts"))),
  );
  const userDataDir = await ensureDir(path.join(os.tmpdir(), `openwork-electron-smoke-${Date.now()}`));
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
      OPENWORK_ELECTRON_USERDATA: path.join(userDataDir, "userdata"),
      ...(process.platform === "win32"
        ? {}
        : {
            HOME: isolatedHome,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || userDataDir,
          }),
    },
  });

  try {
    const page = await app.firstWindow();
    const tests = buildTests(remoteConfig);

    console.log(`\nOpenWork Screenshot Suite — ${tests.length} tests`);
    console.log(`Output: ${outDir}\n`);

    const suite = await runSuite(page, outDir, tests);
    const screenshotFiles = (await readdir(outDir)).filter((name) => name.endsWith(".png")).sort();

    const report = {
      title: suite.metadata.title ?? "",
      url: suite.metadata.url ?? "",
      recognizedShell:
        (suite.metadata.title ?? "").includes("OpenWork") ||
        String(suite.metadata.snapshot?.bodyText ?? "").trim().length >= 20,
      matchedCues: suite.metadata.snapshot?.matchedCues ?? [],
      bodyTextPreview: String(suite.metadata.snapshot?.bodyText ?? "").slice(0, 2_000),
      remoteSmoke: suite.metadata.remoteSmoke ?? null,
      results: suite.results,
      counts: {
        passed: suite.passed,
        failed: suite.failed,
        skipped: suite.skipped,
      },
      screenshotFiles,
    };

    await writeFile(path.join(outDir, "windows-ui-smoke.json"), JSON.stringify(report, null, 2), "utf8");
    await writeFile(
      path.join(outDir, "windows-ui-smoke.txt"),
      String(suite.metadata.snapshot?.bodyText ?? ""),
      "utf8",
    );

    console.log(`\n${"-".repeat(60)}`);
    console.log(`${suite.results.length} tests, ${suite.passed} passed, ${suite.failed} failed, ${suite.skipped} skipped`);
    console.log(`${screenshotFiles.length} screenshots saved to ${outDir}`);

    if (suite.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
