import { run } from "./client";

const REQUIRED = ["pnpm", "cargo", "gh", "hdiutil", "codesign", "spctl", "git"];

export async function loadEnv() {
  const missing: string[] = [];

  for (const bin of REQUIRED) {
    try {
      await run("/usr/bin/env", ["bash", "-lc", `command -v ${bin}`], {
        allowFailure: false,
      });
    } catch {
      missing.push(bin);
    }
  }

  if (missing.length) {
    throw new Error(`Missing required tools: ${missing.join(", ")}`);
  }

  return { ok: true as const };
}
