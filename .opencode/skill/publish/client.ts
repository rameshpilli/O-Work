import { spawn } from "child_process";

export async function run(
  command: string,
  args: string[],
  options?: { cwd?: string; allowFailure?: boolean },
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options?.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const code = await new Promise<number>((resolve) => {
    child.on("close", (c) => resolve(c ?? -1));
  });

  const ok = code === 0;
  if (!ok && !options?.allowFailure) {
    throw new Error(
      `Command failed (${code}): ${command} ${args.join(" ")}\n${stderr || stdout}`,
    );
  }

  return { ok, code, stdout, stderr };
}
