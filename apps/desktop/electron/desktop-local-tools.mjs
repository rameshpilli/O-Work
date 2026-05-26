import { appendFile, mkdir, stat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LIST_LIMIT = 500;
const DEFAULT_ALLOWED_COMMANDS = Object.freeze(["pwd", "ls", "cat", "rg"]);
const SUPPORTED_SHELL_COMMANDS = new Set(DEFAULT_ALLOWED_COMMANDS);

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

function limitTextChunks(text, maxBytes) {
  const value = String(text ?? "");
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : value.slice(0, maxBytes);
}

function shellResult(command, cwd, stdout = "", stderr = "", exitCode = 0) {
  return {
    command,
    args: [],
    cwd,
    exitCode,
    signal: null,
    stdout,
    stderr,
  };
}

async function resolveShellPaths(rawPaths, cwd, options, expect = null) {
  const values = Array.isArray(rawPaths) && rawPaths.length > 0 ? rawPaths : ["."];
  const resolved = [];
  for (const value of values) {
    const entry = await resolveSecurePath(value, {
      homeDir: options.homeDir,
      cwd,
      allowedRoots: options.allowedRoots,
      mustExist: true,
      ...(expect ? { expect } : {}),
    });
    resolved.push(entry);
  }
  return resolved;
}

function formatLsLongEntry(info) {
  const type = info.type === "directory" ? "d" : info.type === "file" ? "-" : "?";
  const size = String(info.size ?? 0).padStart(10, " ");
  const modified = info.modifiedMs ? new Date(info.modifiedMs).toISOString() : "";
  return `${type} ${size} ${modified} ${info.name}`;
}

async function executePwd(cwd, hooks = {}) {
  const stdout = `${cwd}\n`;
  hooks.onStdout?.(stdout);
  return shellResult("pwd", cwd, stdout);
}

async function executeLs(toolInput, cwd, options, hooks = {}) {
  const targets = await resolveShellPaths(toolInput?.paths, cwd, options, null);
  const lines = [];
  for (const target of targets) {
    if (target.stat?.isDirectory()) {
      const entries = await readdir(target.path, { withFileTypes: true });
      const visible = entries.filter((entry) => toolInput?.all === true || !entry.name.startsWith("."));
      if (targets.length > 1) lines.push(`${target.path}:`);
      for (const entry of visible) {
        const childPath = path.join(target.path, entry.name);
        const info = await stat(childPath).catch(() => null);
        const detail = {
          name: entry.name,
          path: childPath,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          size: info?.size ?? null,
          modifiedMs: info?.mtimeMs ?? null,
        };
        lines.push(toolInput?.long === true ? formatLsLongEntry(detail) : entry.name);
      }
    } else {
      const detail = {
        name: path.basename(target.path),
        path: target.path,
        type: "file",
        size: target.stat?.size ?? null,
        modifiedMs: target.stat?.mtimeMs ?? null,
      };
      lines.push(toolInput?.long === true ? formatLsLongEntry(detail) : detail.name);
    }
  }
  const stdout = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  hooks.onStdout?.(stdout);
  return shellResult("ls", cwd, stdout);
}

async function executeCat(toolInput, cwd, options, hooks = {}) {
  const targets = await resolveShellPaths(toolInput?.paths, cwd, options, "file");
  if (targets.length === 0) {
    throw codeError("local-shell.exec cat requires at least one path", "INVALID_INPUT");
  }
  const chunks = [];
  for (const target of targets) {
    chunks.push(await readFile(target.path, "utf8"));
  }
  const stdout = chunks.join("");
  hooks.onStdout?.(stdout);
  return shellResult("cat", cwd, limitTextChunks(stdout, options.maxStdoutBytes));
}

function createRgMatcher(pattern, flags) {
  const caseInsensitive = flags.includes("-i") || (flags.includes("-S") && pattern.toLowerCase() === pattern);
  try {
    return new RegExp(pattern, caseInsensitive ? "gi" : "g");
  } catch {
    throw codeError(`Invalid rg pattern: ${pattern}`, "INVALID_INPUT");
  }
}

async function collectSearchFiles(target, includeHidden, results = []) {
  if (target.stat?.isFile()) {
    results.push(target.path);
    return results;
  }
  const entries = await readdir(target.path, { withFileTypes: true });
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    const childPath = path.join(target.path, entry.name);
    const childStat = await stat(childPath).catch(() => null);
    if (!childStat) continue;
    if (childStat.isDirectory()) {
      await collectSearchFiles({ path: childPath, stat: childStat }, includeHidden, results);
    } else if (childStat.isFile()) {
      results.push(childPath);
    }
  }
  return results;
}

async function executeRg(toolInput, cwd, options, hooks = {}) {
  const pattern = trim(toolInput?.pattern);
  if (!pattern) {
    throw codeError("local-shell.exec rg requires a non-empty pattern", "INVALID_INPUT");
  }
  const flags = normalizeFlags(toolInput?.flags, new Set(["-n", "--hidden", "-i", "-S", "-uu"]));
  const includeHidden = flags.includes("--hidden") || flags.includes("-uu");
  const targets = await resolveShellPaths(toolInput?.paths, cwd, options, null);
  const matcher = createRgMatcher(pattern, flags);
  const matches = [];
  for (const target of targets) {
    const files = await collectSearchFiles(target, includeHidden);
    for (const filePath of files) {
      let content = "";
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        matcher.lastIndex = 0;
        if (!matcher.test(line)) continue;
        matches.push(flags.includes("-n") ? `${filePath}:${index + 1}:${line}` : `${filePath}:${line}`);
      }
    }
  }
  const stdout = limitTextChunks(matches.join("\n") + (matches.length > 0 ? "\n" : ""), options.maxStdoutBytes);
  hooks.onStdout?.(stdout);
  return shellResult("rg", cwd, stdout, "", matches.length > 0 ? 0 : 1);
}

export async function createDesktopLocalToolAdapter(input = {}) {
  const homeDir = input.homeDir || os.homedir();
  const allowedRoots = await resolveAllowedRoots(input.allowedRoots ?? [], homeDir);
  const defaultRoot = allowedRoots[0] || homeDir;
  const allowedCommandSet = new Set(
    (Array.isArray(input.allowedCommands) && input.allowedCommands.length > 0
      ? input.allowedCommands
      : DEFAULT_ALLOWED_COMMANDS)
      .map((entry) => trim(entry).toLowerCase())
      .filter((entry) => entry && SUPPORTED_SHELL_COMMANDS.has(entry)),
  );
  const limits = {
    maxReadBytes: toInteger(input?.limits?.maxReadBytes, 256 * 1024),
    maxWriteBytes: toInteger(input?.limits?.maxWriteBytes, 256 * 1024),
    maxStdoutBytes: toInteger(input?.limits?.maxStdoutBytes, 256 * 1024),
    maxStderrBytes: toInteger(input?.limits?.maxStderrBytes, 128 * 1024),
    shellTimeoutMs: toInteger(input?.limits?.shellTimeoutMs, 15_000),
  };
  const extraTools = Array.isArray(input.extraTools) ? input.extraTools.filter(Boolean) : [];
  const extraToolMap = new Map(
    extraTools
      .filter((tool) => typeof tool?.name === "string" && typeof tool?.execute === "function")
      .map((tool) => [tool.name, tool]),
  );

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

  async function localFsWrite(toolInput = {}) {
    const targetPath = trim(toolInput.path);
    if (!targetPath) {
      throw codeError("local-fs.write requires a path", "INVALID_INPUT");
    }
    const content = String(toolInput.content ?? "");
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > limits.maxWriteBytes) {
      throw codeError(`Write exceeds maxWriteBytes (${limits.maxWriteBytes})`, "WRITE_TOO_LARGE");
    }
    const expandedTarget = expandHome(targetPath, homeDir);
    const absolute = path.isAbsolute(expandedTarget) ? expandedTarget : path.resolve(defaultRoot, expandedTarget);
    const parentPath = path.dirname(absolute);
    const parent = await resolveSecurePath(parentPath, {
      homeDir,
      cwd: defaultRoot,
      allowedRoots,
      mustExist: toolInput.createParents !== true,
      expect: "directory",
    });
    if (toolInput.createParents === true) {
      await mkdir(parent.path, { recursive: true });
    }
    const existing = await stat(absolute).catch(() => null);
    if (existing && existing.isDirectory()) {
      throw codeError(`Expected a file path: ${absolute}`, "EXPECTED_FILE");
    }
    if (existing && toolInput.append !== true && toolInput.overwrite === false) {
      throw codeError(`Refusing to overwrite existing file: ${absolute}`, "FILE_EXISTS");
    }
    if (toolInput.append === true) {
      await appendFile(absolute, content, "utf8");
    } else {
      await writeFile(absolute, content, "utf8");
    }
    const resolved = await resolveSecurePath(absolute, {
      homeDir,
      cwd: defaultRoot,
      allowedRoots,
      mustExist: true,
      expect: "file",
    });
    return {
      path: resolved.path,
      bytesWritten: byteLength,
      appended: toolInput.append === true,
      overwritten: Boolean(existing) && toolInput.append !== true,
    };
  }

  async function localFsPatch(toolInput = {}) {
    const resolved = await resolveSecurePath(toolInput.path, {
      homeDir,
      cwd: defaultRoot,
      allowedRoots,
      mustExist: true,
      expect: "file",
    });
    const search = String(toolInput.search ?? "");
    if (!search) {
      throw codeError("local-fs.patch requires a non-empty search string", "INVALID_INPUT");
    }
    const replace = String(toolInput.replace ?? "");
    const original = await readFile(resolved.path, "utf8");
    const occurrences = original.split(search).length - 1;
    if (occurrences <= 0) {
      throw codeError(`Search text was not found in ${resolved.path}`, "PATCH_NOT_FOUND");
    }
    const expectedMatches = Number.isInteger(toolInput.expectedMatches) ? Number(toolInput.expectedMatches) : null;
    if (expectedMatches !== null && occurrences !== expectedMatches) {
      throw codeError(`Expected ${expectedMatches} matches but found ${occurrences}`, "PATCH_MATCH_COUNT");
    }
    const replaceAll = toolInput.replaceAll !== false;
    const nextContent = replaceAll ? original.split(search).join(replace) : original.replace(search, replace);
    const byteLength = Buffer.byteLength(nextContent, "utf8");
    if (byteLength > limits.maxWriteBytes) {
      throw codeError(`Patched file exceeds maxWriteBytes (${limits.maxWriteBytes})`, "WRITE_TOO_LARGE");
    }
    await writeFile(resolved.path, nextContent, "utf8");
    return {
      path: resolved.path,
      replacements: replaceAll ? occurrences : 1,
      size: byteLength,
    };
  }

  async function localShellExec(toolInput = {}, hooks = {}) {
    const command = trim(toolInput.command).toLowerCase();
    if (!allowedCommandSet.has(command)) {
      throw codeError(`Command is not allowed by policy: ${toolInput.command}`, "COMMAND_NOT_ALLOWED");
    }
    const cwdResolved = await resolveSecurePath(toolInput.cwd || defaultRoot, {
      homeDir,
      allowedRoots,
      defaultRoot,
      cwd: defaultRoot,
      mustExist: true,
      expect: "directory",
    });
    const shellOptions = {
      homeDir,
      allowedRoots,
      defaultRoot,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
      shellTimeoutMs: limits.shellTimeoutMs,
    };
    switch (command) {
      case "pwd":
        return executePwd(cwdResolved.path, hooks);
      case "ls":
        return executeLs(toolInput, cwdResolved.path, shellOptions, hooks);
      case "cat":
        return executeCat(toolInput, cwdResolved.path, shellOptions, hooks);
      case "rg":
        return executeRg(toolInput, cwdResolved.path, shellOptions, hooks);
      default:
        throw codeError(`Command is not allowed: ${toolInput.command}`, "COMMAND_NOT_ALLOWED");
    }
  }

  return {
    policy: {
      homeDir,
      allowedRoots,
      defaultRoot,
      allowedCommands: Array.from(allowedCommandSet),
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
          name: "local-fs.write",
          description: "Write a local text file under an approved root on the employee machine.",
          inputSchema: schemaProperties(
            {
              path: { type: "string", description: "Target file path under an approved root." },
              content: { type: "string", description: "Full text content to write." },
              append: { type: "boolean", description: "Append instead of overwrite." },
              overwrite: { type: "boolean", description: "Allow overwrite when the file already exists." },
              createParents: { type: "boolean", description: "Create parent directories when missing." },
            },
            ["path", "content"],
          ),
        },
        {
          name: "local-fs.patch",
          description: "Apply a simple text replacement to a local file under an approved root.",
          inputSchema: schemaProperties(
            {
              path: { type: "string", description: "Target file path under an approved root." },
              search: { type: "string", description: "Exact text to search for." },
              replace: { type: "string", description: "Replacement text." },
              replaceAll: { type: "boolean", description: "Replace every occurrence. Defaults to true." },
              expectedMatches: { type: "integer", description: "Optional exact match count guard." },
            },
            ["path", "search", "replace"],
          ),
        },
        {
          name: "local-shell.exec",
          description: "Run a restricted read-only local shell command on the employee machine.",
          inputSchema: schemaProperties(
            {
              command: { type: "string", enum: Array.from(allowedCommandSet) },
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
        ...extraTools
          .filter((tool) => typeof tool?.name === "string")
          .map((tool) => ({
            name: tool.name,
            description: String(tool.description ?? ""),
            inputSchema: tool.inputSchema ?? schemaProperties({}, []),
          })),
      ];
    },
    async executeToolCall(toolName, toolInput = {}, hooks = {}) {
      try {
        switch (toolName) {
          case "local-fs.list":
            return await localFsList(toolInput);
          case "local-fs.read":
            return await localFsRead(toolInput);
          case "local-fs.write":
            return await localFsWrite(toolInput);
          case "local-fs.patch":
            return await localFsPatch(toolInput);
          case "local-shell.exec":
            return await localShellExec(toolInput, hooks);
          default: {
            const extra = extraToolMap.get(toolName);
            if (extra) {
              return await extra.execute(toolInput, hooks, {
                homeDir,
                allowedRoots,
                defaultRoot,
                limits,
              });
            }
            throw codeError(`Unsupported local tool: ${toolName}`, "UNKNOWN_TOOL");
          }
        }
      } catch (error) {
        throw Object.assign(new Error(safeError(error).message), safeError(error));
      }
    },
  };
}
