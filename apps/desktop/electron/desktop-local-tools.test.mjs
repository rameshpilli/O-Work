import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { createDesktopLocalToolAdapter } from "./desktop-local-tools.mjs";

let fixtureRoot = "";
let adapter = null;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "openwork-desktop-tools-"));
  await mkdir(path.join(fixtureRoot, "nested"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "hello.txt"), "hello from desktop bridge\n", "utf8");
  await writeFile(path.join(fixtureRoot, "nested", "todo.txt"), "TODO: verify desktop bridge\n", "utf8");
  adapter = await createDesktopLocalToolAdapter({
    homeDir: fixtureRoot,
    allowedRoots: [fixtureRoot],
  });
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("desktop local tools", () => {
  it("lists files from an approved directory", async () => {
    const result = await adapter.executeToolCall("local-fs.list", { path: fixtureRoot });
    assert.equal(path.basename(result.path), path.basename(fixtureRoot));
    assert.ok(result.entries.some((entry) => entry.name === "hello.txt"));
    assert.ok(result.entries.some((entry) => entry.name === "nested"));
  });

  it("reads a text file from an approved root", async () => {
    const result = await adapter.executeToolCall("local-fs.read", {
      path: path.join(fixtureRoot, "hello.txt"),
    });
    assert.match(result.content, /hello from desktop bridge/);
    assert.equal(result.truncated, false);
  });

  it("runs a restricted ls command locally", async () => {
    const result = await adapter.executeToolCall("local-shell.exec", {
      command: "ls",
      paths: [fixtureRoot],
      long: true,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello\.txt/);
  });

  it("runs a restricted rg command locally when rg is available", async (t) => {
    const rgCheck = spawnSync("rg", ["--version"], { stdio: "ignore" });
    if (rgCheck.status !== 0) {
      t.skip("rg is not installed in this environment");
      return;
    }
    const result = await adapter.executeToolCall("local-shell.exec", {
      command: "rg",
      pattern: "TODO",
      paths: [fixtureRoot],
      flags: ["-n"],
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /todo\.txt/);
  });

  it("rejects file access outside approved roots", async () => {
    await assert.rejects(
      adapter.executeToolCall("local-fs.read", { path: "/etc/hosts" }),
      /outside the approved roots/i,
    );
  });

  it("rejects commands outside the allowlist", async () => {
    await assert.rejects(
      adapter.executeToolCall("local-shell.exec", { command: "rm", paths: [fixtureRoot] }),
      /not allowed/i,
    );
  });
});
