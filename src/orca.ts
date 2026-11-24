import { spawn } from "node:child_process";

export interface Target {
  run: string;
  terminal: string;
}

export interface Notice {
  id: string;
  type: string;
}

export interface MailboxMessage extends Notice {
  run_id: string;
  to_handle: string;
  [key: string]: unknown;
}

export interface ReadResult {
  runId: string;
  messages: MailboxMessage[];
}

export interface MailboxClient {
  verify(target: Target, signal?: AbortSignal): Promise<void>;
  peek(target: Target, signal?: AbortSignal): Promise<Notice[]>;
  read(target: Target, signal?: AbortSignal): Promise<ReadResult>;
}

export type Runner = (args: string[], signal?: AbortSignal) => Promise<unknown>;
interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function executable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    env.ORCA_CLI_COMMAND ||
    (env.ORCA_DEV_REPO_ROOT
      ? "orca-dev"
      : platform === "linux"
        ? "orca-ide"
        : "orca")
  );
}

// Recovery examples are POSIX shell commands, not unquoted executable fragments.
export function commandText(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return [executable(env, platform), ...args]
    .map((word) =>
      /^[A-Za-z0-9_./:@=-]+$/.test(word)
        ? word
        : "'" + word.replace(/'/g, "'\\''") + "'",
    )
    .join(" ");
}

export async function runJson(
  binary: string,
  args: string[],
  { signal, timeoutMs = 35_000, maxBytes = 1_048_576, env }: RunOptions = {},
): Promise<unknown> {
  if (signal?.aborted) throw new Error("Orca request cancelled.");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: unknown, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(settlementTimer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = (reason: string) => {
      if (failure || settled) return;
      failure = new Error(reason);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      // A descendant can keep the pipes open after cancellation. Stop accepting
      // output after the grace period without claiming the remote action ended.
      settlementTimer = setTimeout(() => {
        finish(undefined, failure);
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1250);
    };
    const cancel = () => stop("Orca request cancelled.");
    const deadline = setTimeout(
      () => stop("Orca request exceeded its deadline."),
      timeoutMs,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const collect = (chunk: Buffer, stdout: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) stop("Orca response exceeded its output limit.");
      else if (stdout && !failure) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => stop("Could not start the Orca CLI."));
    child.on("close", (code) => {
      if (settled) return;
      if (failure) return finish(undefined, failure);
      if (code !== 0)
        return finish(
          undefined,
          new Error(
            "Orca CLI request failed. Inspect Orca directly for details.",
          ),
        );
      try {
        const envelope: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (
          !record(envelope) ||
          envelope.ok !== true ||
          !record(envelope.result)
        ) {
          throw new Error("Invalid response");
        }
        finish(envelope.result);
      } catch {
        finish(
          undefined,
          new Error("Orca returned an unsupported JSON response."),
        );
      }
    });
  });
}

export function validateTarget(target: unknown): asserts target is Target {
  if (
    !record(target) ||
    typeof target.run !== "string" ||
    typeof target.terminal !== "string" ||
    !/^run_[A-Za-z0-9_-]{1,160}$/.test(target.run) ||
    !/^term_[A-Za-z0-9_-]{1,160}$/.test(target.terminal)
  ) {
    throw new Error("Provide an explicit run ID and an owned terminal handle.");
  }
}

export class OrcaClient implements MailboxClient {
  private readonly run: Runner;

  constructor(
    run: Runner = (args, signal) => runJson(executable(), args, { signal }),
  ) {
    this.run = run;
  }

  async verify(target: Target, signal?: AbortSignal): Promise<void> {
    validateTarget(target);
    const result = await this.run(
      ["orchestration", "run-show", "--id", target.run, "--full", "--json"],
      signal,
    );
    if (
      !record(result) ||
      !record(result.run) ||
      result.run.id !== target.run ||
      result.run.coordinator_handle !== target.terminal
    ) {
      throw new Error(
        "Orca run ownership mismatch. Nothing was read or rebound.",
      );
    }
  }

  async read(target: Target, signal?: AbortSignal): Promise<ReadResult> {
    await this.verify(target, signal);
    const result = await this.run(
      [
        "orchestration",
        "check",
        "--terminal",
        target.terminal,
        "--run",
        target.run,
        "--full",
        "--json",
      ],
      signal,
    );
    const { messages, metadata } = validateRows(result, target);
    if (messages.length && metadata.deliveryAcknowledged !== true) {
      throw new Error(
        "Orca did not confirm automatic acknowledgment of this read.",
      );
    }
    return { runId: target.run, messages };
  }

  async peek(target: Target, signal?: AbortSignal): Promise<Notice[]> {
    validateTarget(target);
    const result = await this.run(
      [
        "orchestration",
        "check",
        "--terminal",
        target.terminal,
        "--run",
        target.run,
        "--peek",
        "--wait",
        "--timeout-ms",
        "30000",
        "--types",
        "worker_done,question,escalation",
        "--full",
        "--json",
      ],
      signal,
    );
    const { messages, metadata } = validateRows(result, target);
    if (metadata.acknowledged || metadata.deliveryAcknowledged) {
      throw new Error(
        "Orca did not return a supported non-consuming mailbox response.",
      );
    }
    return messages
      .filter((row) =>
        ["worker_done", "question", "escalation"].includes(row.type),
      )
      .map((row) => ({ id: row.id, type: row.type }));
  }
}

function validateRows(
  result: unknown,
  target: Target,
): { metadata: Record<string, unknown>; messages: MailboxMessage[] } {
  if (
    !record(result) ||
    result.runId !== target.run ||
    !Array.isArray(result.messages) ||
    result.messages.length > 100 ||
    result.legacyCompatibility ||
    result.connectionLost ||
    result.cancelled
  ) {
    throw new Error("Orca returned an unsupported mailbox response.");
  }
  const messages: MailboxMessage[] = [];
  for (const value of result.messages) {
    const row: unknown = value;
    if (
      !record(row) ||
      typeof row.id !== "string" ||
      !/^msg_[A-Za-z0-9_-]{1,160}$/.test(row.id) ||
      row.run_id !== target.run ||
      row.to_handle !== `run:${target.run}` ||
      typeof row.type !== "string" ||
      (row.delivery_contract && row.delivery_contract !== "current_delivery")
    ) {
      throw new Error("Orca returned an invalid or unrelated mailbox message.");
    }
    messages.push({
      ...row,
      id: row.id,
      type: row.type,
      run_id: target.run,
      to_handle: `run:${target.run}`,
    });
  }
  return { metadata: result, messages };
}
