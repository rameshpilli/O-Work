#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function requiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const serverUrl = requiredEnv("OPENWORK_DESKTOP_BRIDGE_SERVER_URL").replace(/\/+$/, "");
const workspaceId = requiredEnv("OPENWORK_DESKTOP_BRIDGE_WORKSPACE_ID");
const hostToken = requiredEnv("OPENWORK_DESKTOP_BRIDGE_HOST_TOKEN");

async function bridgeCall(toolName, args) {
  const response = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/desktop-bridge/tool-call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenWork-Host-Token": hostToken,
    },
    body: JSON.stringify({
      toolName,
      arguments: args,
    }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  }
  if (!payload?.item) {
    throw new Error("Desktop bridge returned no tool result");
  }
  if (payload.item.status === "failed") {
    throw new Error(payload.item.error?.message || "Desktop tool call failed");
  }
  return payload.item.result;
}

function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

const server = new McpServer({
  name: "openwork-desktop-bridge",
  version: "0.1.0",
});

server.registerTool(
  "local-fs-list",
  {
    title: "Local FS List",
    description: "List files in an approved directory on the connected user's actual computer. Use this for Downloads, Desktop, Documents, or other laptop paths instead of remote worker file tools.",
    inputSchema: z.object({
      path: z.string().optional(),
      includeHidden: z.boolean().optional(),
    }),
  },
  async (args) => {
    const result = await bridgeCall("local-fs.list", args);
    return {
      content: [{ type: "text", text: renderJson(result) }],
    };
  },
);

server.registerTool(
  "local-fs-read",
  {
    title: "Local FS Read",
    description: "Read a text file from the connected user's actual computer. Use this for laptop files and home-directory paths instead of remote worker read tools.",
    inputSchema: z.object({
      path: z.string(),
      maxBytes: z.number().int().positive().optional(),
    }),
  },
  async (args) => {
    const result = await bridgeCall("local-fs.read", args);
    return {
      content: [{ type: "text", text: renderJson(result) }],
    };
  },
);

server.registerTool(
  "local-shell-exec",
  {
    title: "Local Shell Exec",
    description: "Run a restricted read-only shell command on the connected user's actual computer. Use this for laptop shell tasks such as listing Downloads or searching the user's local repo instead of remote worker bash tools.",
    inputSchema: z.object({
      command: z.enum(["pwd", "ls", "cat", "rg"]),
      cwd: z.string().optional(),
      paths: z.array(z.string()).optional(),
      pattern: z.string().optional(),
      flags: z.array(z.string()).optional(),
      all: z.boolean().optional(),
      long: z.boolean().optional(),
    }),
  },
  async (args) => {
    const result = await bridgeCall("local-shell.exec", args);
    return {
      content: [{ type: "text", text: renderJson(result) }],
    };
  },
);

await server.connect(new StdioServerTransport());
