import { readFile } from "fs/promises";
import { loadEnv } from "./load-env";
import { run } from "./client";

async function main() {
  await loadEnv();
  await run("gh", ["auth", "status"], { allowFailure: false });

  const pkgRaw = await readFile("package.json", "utf8");
  const pkg = JSON.parse(pkgRaw) as { name?: string; version?: string };

  console.log(
    JSON.stringify(
      {
        ok: true,
        package: pkg.name ?? null,
        version: pkg.version ?? null,
        next: [
          "pnpm typecheck",
          "pnpm build:web",
          "cargo check --manifest-path src-tauri/Cargo.toml",
          "pnpm tauri build --bundles dmg",
          "gh release upload vX.Y.Z <dmg> --clobber",
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(message);
  process.exit(1);
});
