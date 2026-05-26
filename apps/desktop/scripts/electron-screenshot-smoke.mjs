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

    const snapshot = await waitForShell(page);
    const title = await page.title().catch(() => "");
    const currentUrl = page.url();
    const screenshotPath = path.join(outDir, "windows-ui-smoke.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const report = {
      title,
      url: currentUrl,
      recognizedShell: title.includes("OpenWork") || snapshot.bodyText.trim().length >= 20,
      matchedCues: snapshot.matchedCues,
      bodyTextPreview: snapshot.bodyText.slice(0, 2_000),
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
