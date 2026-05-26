import { writeFile } from "node:fs/promises";
import process from "node:process";

function readArg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const direct = argv.find((entry) => entry.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return fallback;
}

function usage() {
  console.log(`Usage:
  node scripts/pilot/issue-tester-tokens.mjs \\
    --server-url https://worker.example.com \\
    --host-token <host-token> \\
    [--testers A,B,C,D,E] \\
    [--scope collaborator] \\
    [--output pilot-tokens.json]

Examples:
  node scripts/pilot/issue-tester-tokens.mjs --server-url http://127.0.0.1:18788 --host-token openwork-host-demo-token
  node scripts/pilot/issue-tester-tokens.mjs --server-url https://worker.example.com --host-token secret --testers alice,bob,charlie
`);
}

async function createToken({ serverUrl, hostToken, scope, label }) {
  const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hostToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scope, label }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to create token for ${label}: ${response.status} ${body}`.trim());
  }

  return response.json();
}

async function main() {
  const help = process.argv.includes("--help") || process.argv.includes("-h");
  if (help) {
    usage();
    return;
  }

  const serverUrl = String(readArg("--server-url", process.env.OPENWORK_SERVER_URL) ?? "").trim();
  const hostToken = String(readArg("--host-token", process.env.OPENWORK_HOST_TOKEN) ?? "").trim();
  const scope = String(readArg("--scope", "collaborator") ?? "collaborator").trim();
  const testersArg = String(readArg("--testers", "A,B,C,D,E") ?? "A,B,C,D,E").trim();
  const outputPath = String(readArg("--output", "") ?? "").trim();

  if (!serverUrl || !hostToken) {
    usage();
    throw new Error("Both --server-url and --host-token are required");
  }
  if (!["owner", "collaborator", "viewer"].includes(scope)) {
    throw new Error("Scope must be one of owner, collaborator, or viewer");
  }

  const testers = testersArg
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (testers.length === 0) {
    throw new Error("At least one tester label is required");
  }

  const issued = [];
  for (const tester of testers) {
    const result = await createToken({
      serverUrl,
      hostToken,
      scope,
      label: `Pilot tester ${tester}`,
    });
    issued.push({
      tester,
      label: `Pilot tester ${tester}`,
      token: result.token,
      id: result.id,
      scope: result.scope,
      createdAt: result.createdAt,
    });
  }

  const payload = {
    serverUrl,
    scope,
    issuedAt: new Date().toISOString(),
    items: issued,
  };

  const markdownLines = [
    "# Pilot tester tokens",
    "",
    `- Worker URL: \`${serverUrl}\``,
    `- Scope: \`${scope}\``,
    "",
    "| Tester | Token | Scope | Token ID |",
    "| --- | --- | --- | --- |",
    ...issued.map((item) => `| ${item.tester} | \`${item.token}\` | ${item.scope} | \`${item.id}\` |`),
    "",
  ];

  if (outputPath) {
    await writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }

  console.log(markdownLines.join("\n"));
  if (outputPath) {
    console.log(`Saved JSON to ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
