import { spawn } from "node:child_process";
import { stat, readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LIST_LIMIT = 500;

function trim(value) {
  return String(value ?? "").trim();
}

function codeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalizeExisting(targetPath) {
  try {
    return await realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function resolveAllowedRoots(roots, homeDir) {
  const resolved = [];
  for (const root of roots) {
    const expanded = expandHome(root, homeDir);
    if (!expanded) continue;
    resolved.push(await canonicalizeExisting(path.resolve(expanded)));
  }
  return resolved.filter((entry, index, list) => list.indexOf(entry) === index);
}

export function expandHome(value, homeDir = os.homedir()) {
  const raw = trim(value);
  if (!raw) return "";
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return path.join(homeDir, raw.slice(2));
  return raw;
}

async function resolveSecurePath(rawPath, options) {
  const homeDir = options.homeDir || os.homedir();
  const cwd = options.cwd ? expandHome(options.cwd, homeDir) : homeDir;
  const candidate = trim(rawPath) ? expandHome(rawPath, homeDir) : cwd;
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const canonical = await canonicalizeExisting(absolute);
  const matchedRoot = options.allowedRoots.find((root) => isPathInside(root, canonical));
  if (!matchedRoot) {
    throw codeError(`Path is outside the approved roots: ${absolute}`, "PATH_NOT_ALLOWED");
  }

  const info = await stat(canonical).catch(() => null);
  if (options.mustExist && !info) {
    throw codeError(`Path does not exist: ${absolute}`, "PATH_NOT_FOUND");
  }
  if (info) {
    if (options.expect === "file" && !info.isFile()) {
      throw codeError(`Expected a file: ${absolute}`, "EXPECTED_FILE");
    }
    if (options.expect === "directory" && !info.isDirectory()) {
      throw codeError(`Expected a directory: ${absolute}`, "EXPECTED_DIRECTORY");
    }
  }
  return {
    path: canonical,
    root: matchedRoot,
    stat: info,
  };
}

function schemaProperties(properties, required = []) {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

function safeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error?.code ? { code: error.code } : {}),
  };
}

function normalizeFlags(flags, allowlist) {
  const values = Array.isArray(flags) ? flags : [];
  const normalized = values.map((entry) => trim(entry)).filter(Boolean);
  for (const flag of normalized) {
    if (!allowlist.has(flag)) {
      throw codeError(`Flag is not allowed: ${flag}`, "FLAG_NOT_ALLOWED");
    }
  }
  return normalized;
}

function buildLsInvocation(input, cwd) {
  const paths = Array.isArray(input?.paths) && input.paths.length > 0 ? input.paths : ["."];
  const flags = [];
  if (input?.all === true) flags.push("-a");
  if (input?.long === true) flags.push("-l");
  return { command: "ls", args: [...flags, ...paths], cwd };
}

function buildCatInvocation(input, cwd) {
  const paths = Array.isArray(input?.paths) ? input.paths.map((entry) => trim(entry)).filter(Boolean) : [];
  if (paths.length === 0) {
    throw codeError("local-shell.exec cat requires at least one path", "INVALID_INPUT");
  }
  return { command: "cat", args: paths, cwd };
}

function buildPwdInvocation(_input, cwd) {
  return { command: "pwd", args: [], cwd };
}

function buildRgInvocation(input, cwd) {
  const pattern = trim(input?.pattern);
  if (!pattern) {
    throw codeError("local-shell.exec rg requires a non-empty pattern", "INVALID_INPUT");
  }
  const paths = Array.isArray(input?.paths) && input.paths.length > 0 ? input.paths.map((entry) => trim(entry)).filter(Boolean) : ["."];
  const flags = normalizeFlags(input?.flags, new Set(["-n", "--hidden", "-i", "-S", "-uu"]));
  return { command: "rg", args: [...flags, pattern, ...paths], cwd };
}

const SHELL_BUILDERS = {
  pwd: buildPwdInvocation,
  ls: buildLsInvocation,
  cat: buildCatInvocation,
  rg: buildRgInvocation,
};

function limitTextChunks(text, maxBytes) {
  const value = String(text ?? "");
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : value.slice(0, maxBytes);
}

async function executeShellCommand(invocation, options, hooks = {}) {
  const cwdResolved = await resolveSecurePath(invocation.cwd || options.defaultRoot, {
    homeDir: options.homeDir,
    cwd: options.defaultRoot,
    allowedRoots: options.allowedRoots,
    mustExist: true,
    expect: "directory",
  });
  const args = [];
  if (invocation.command === "ls") {
    for (const arg of invocation.args) {
      if (arg.startsWith("-")) {
        args.push(arg);
        continue;
      }
      const resolved = await resolveSecurePath(arg, {
        homeDir: options.homeDir,
        cwd: cwdResolved.path,
        allowedRoots: options.allowedRoots,
        mustExist: true,
      });
      args.push(resolved.path);
    }
  } else if (invocation.command === "cat") {
    for (const arg of invocation.args) {
      const resolved = await resolveSecurePath(arg, {
        homeDir: options.homeDir,
        cwd: cwdResolved.path,
        allowedRoots: options.allowedRoots,
        mustExist: true,
        expect: "file",
      });
      args.push(resolved.path);
    }
  } else if (invocation.command === "rg") {
    let positionalIndex = 0;
    for (const arg of invocation.args) {
      if (arg.startsWith("-")) {
        args.push(arg);
        continue;
      }
      if (positionalIndex === 0) {
        args.push(arg);
      } else {
        const resolved = await resolveSecurePath(arg, {
          homeDir: options.homeDir,
          cwd: cwdResolved.path,
          allowedRoots: options.allowedRoots,
          mustExist: true,
        });
        args.push(resolved.path);
      }
      positionalIndex += 1;
    }
  } else {
    args.push(...invocation.args);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, args, {
      cwd: cwdResolved.path,
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const error = codeError(`Command timed out after ${options.shellTimeoutMs}ms`, "COMMAND_TIMEOUT");
      if (!settled) {
        settled = true;
        reject(error);
      }
    }, options.shellTimeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.on("error", (error) => {
      const spawnError = /** @type {Error & { code?: string }} */ (error);
      fail(Object.assign(spawnError, { code: spawnError.code || "COMMAND_SPAWN_FAILED" }));
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = limitTextChunks(stdout + chunk, options.maxStdoutBytes);
      hooks.onStdout?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitTextChunks(stderr + chunk, options.maxStderrBytes);
      hooks.onStderr?.(String(chunk));
    });
    child.on("close", (code, signal) => {
      finish({
        command: invocation.command,
        args,
        cwd: cwdResolved.path,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        stdout,
        stderr,
      });
    });
  });
}

export async function createDesktopLocalToolAdapter(input = {}) {
  const homeDir = input.homeDir || os.homedir();
  const allowedRoots = await resolveAllowedRoots(input.allowedRoots ?? [], homeDir);
  const defaultRoot = allowedRoots[0] || homeDir;
  const limits = {
    maxReadBytes: toInteger(input?.limits?.maxReadBytes, 256 * 1024),
    maxStdoutBytes: toInteger(input?.limits?.maxStdoutBytes, 256 * 1024),
    maxStderrBytes: toInteger(input?.limits?.maxStderrBytes, 128 * 1024),
    shellTimeoutMs: toInteger(input?.limits?.shellTimeoutMs, 15_000),
  };

  async function localFsList(toolInput = {}) {
    const resolved = await resolveSecurePath(toolInput.path || defaultRoot, {
      homeDir,
      cwd: defaultRoot,
      allowedRoots,
      mustExist: true,
      expect: "directory",
    });
    const entries = await readdir(resolved.path, { withFileTypes: true });
    const limitedEntries = entries
      .filter((entry) => toolInput.includeHidden === true || !entry.name.startsWith("."))
      .slice(0, DEFAULT_LIST_LIMIT);
    const details = await Promise.all(
      limitedEntries.map(async (entry) => {
        const childPath = path.join(resolved.path, entry.name);
        const info = await stat(childPath).catch(() => null);
        return {
          name: entry.name,
          path: childPath,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          size: info?.size ?? null,
          modifiedMs: info?.mtimeMs ?? null,
        };
      }),
    );
    return {
      path: resolved.path,
      entries: details,
      truncated: entries.length > limitedEntries.length,
    };
  }

  async function localFsRead(toolInput = {}) {
    const resolved = await resolveSecurePath(toolInput.path, {
      homeDir,
      cwd: defaultRoot,
      allowedRoots,
      mustExist: true,
      expect: "file",
    });
    const maxBytes = toInteger(toolInput.maxBytes, limits.maxReadBytes);
    const buffer = await readFile(resolved.path);
    const sliced = buffer.subarray(0, maxBytes);
    return {
      path: resolved.path,
      encoding: "utf8",
      content: sliced.toString("utf8"),
      truncated: buffer.length > sliced.length,
      size: buffer.length,
    };
  }

  async function localShellExec(toolInput = {}, hooks = {}) {
    const command = trim(toolInput.command).toLowerCase();
    const builder = SHELL_BUILDERS[command];
    if (!builder) {
      throw codeError(`Command is not allowed: ${toolInput.command}`, "COMMAND_NOT_ALLOWED");
    }
    const invocation = builder(toolInput, defaultRoot);
    return executeShellCommand(invocation, {
      homeDir,
      allowedRoots,
      defaultRoot,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
      shellTimeoutMs: limits.shellTimeoutMs,
    }, hooks);
  }

  return {
    policy: {
      homeDir,
      allowedRoots,
      defaultRoot,
      limits,
    },
    describeTools() {
      return [
        {
          name: "local-fs.list",
          description: "List files in an approved local directory on the employee machine.",
          inputSchema: schemaProperties(
            {
              path: { type: "string", description: "Directory path under an approved root." },
              includeHidden: { type: "boolean", description: "Include dotfiles." },
            },
            [],
          ),
        },
        {
          name: "local-fs.read",
          description: "Read a local text file from an approved root on the employee machine.",
          inputSchema: schemaProperties(
            {
              path: { type: "string", description: "File path under an approved root." },
              maxBytes: { type: "integer", description: "Maximum bytes to return." },
            },
            ["path"],
          ),
        },
        {
          name: "local-shell.exec",
          description: "Run a restricted read-only local shell command on the employee machine.",
          inputSchema: schemaProperties(
            {
              command: { type: "string", enum: Object.keys(SHELL_BUILDERS) },
              cwd: { type: "string", description: "Working directory under an approved root." },
              paths: { type: "array", items: { type: "string" }, description: "Local file or directory paths." },
              pattern: { type: "string", description: "Pattern for rg." },
              flags: { type: "array", items: { type: "string" }, description: "Limited rg flags: -n, --hidden, -i, -S, -uu." },
              all: { type: "boolean", description: "For ls: include hidden entries." },
              long: { type: "boolean", description: "For ls: use long output." },
            },
            ["command"],
          ),
        },
      ];
    },
    async executeToolCall(toolName, toolInput = {}, hooks = {}) {
      try {
        switch (toolName) {
          case "local-fs.list":
            return await localFsList(toolInput);
          case "local-fs.read":
            return await localFsRead(toolInput);
          case "local-shell.exec":
            return await localShellExec(toolInput, hooks);
          default: {
            throw codeError(`Unsupported local tool: ${toolName}`, "UNKNOWN_TOOL");
          }
        }
      } catch (error) {
        throw Object.assign(new Error(safeError(error).message), safeError(error));
      }
    },
  };
}
