import { spawn } from "node:child_process";

export interface MutationResult {
  code: number | null;
  envelope?: unknown;
  problem?:
    | "spawn_failed"
    | "deadline"
    | "output_limit"
    | "invalid_json"
    | "stdin_closed";
}

const callerVariables = [
  "ORCA_ENVIRONMENT",
  "ORCA_PAIRING_CODE",
  "ORCA_REMOTE_PAIRING",
  "ORCA_AGENT_SESSION_ID",
  "ORCA_AGENT_SESSION_SPAWN_TOKEN",
  "ORCA_TERMINAL_HANDLE",
  "ORCA_PANE_KEY",
  "ORCA_WORKTREE_ID",
  "ORCA_WORKSPACE_ID",
  "ORCA_CLI_CWD",
  "ORCA_USER_DATA_PATH",
];

export function localEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const name of callerVariables) delete child[name];
  return child;
}

export function assertLocalCaller(env: NodeJS.ProcessEnv): void {
  for (const name of callerVariables) {
    if (env[name])
      throw new Error(
        "Worker launch requires an external local Pi identity with no remote routing overrides.",
      );
  }
}

// Cancellation of the model turn must not kill a start that Orca may have accepted.
export async function runMutation(
  binary: string,
  args: string[],
  brief: string,
  {
    timeoutMs = 125_000,
    maxBytes = 1_048_576,
    env = process.env,
  }: {
    timeoutMs?: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MutationResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: localEnvironment(env),
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let problem: MutationResult["problem"];
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: MutationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(settlementTimer);
      resolve(result);
    };
    const stop = (reason: MutationResult["problem"]) => {
      if (problem || settled) return;
      problem = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      // Descendants can retain these pipes after the CLI exits. A close event
      // is not required to report uncertainty and stop accepting late output.
      settlementTimer = setTimeout(() => {
        finish({ code: child.exitCode, problem });
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1250);
    };
    const deadline = setTimeout(() => stop("deadline"), timeoutMs);
    const collect = (chunk: Buffer, stdout: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) stop("output_limit");
      else if (stdout && !problem) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => stop("spawn_failed"));
    child.stdin.on("error", () => stop("stdin_closed"));
    child.stdin.end(brief);
    child.on("close", (code) => {
      if (settled) return;
      if (problem) return finish({ code, problem });
      try {
        const envelope: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        finish({ code, envelope });
      } catch {
        finish({ code, problem: "invalid_json" });
      }
    });
  });
}
