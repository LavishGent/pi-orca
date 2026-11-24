import { spawn } from "node:child_process";

export interface ProbeContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

// Only the diagnostic Git metadata operation uses this text reader.
export function readGitMetadata(
  binary: string,
  args: string[],
  { cwd, env, signal, timeoutMs = 5000, maxBytes = 65536 }: ProbeContext,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("Probe cancelled."));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false,
      failed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      signal?.removeEventListener("abort", stop);
      if (failed || text === undefined)
        reject(
          new Error(
            "Git metadata probe failed, exceeded its limits or was cancelled.",
          ),
        );
      else resolve(text);
    };
    const stop = () => {
      if (failed || settled) return;
      failed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      // Descendant-held pipes must not prevent reporting an unknown result.
      settleTimer = setTimeout(() => {
        finish();
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1250);
    };
    const deadline = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const collect = (data: Buffer, stdout: boolean) => {
      if (settled) return;
      size += data.length;
      if (size > maxBytes) stop();
      else if (stdout && !failed) chunks.push(data);
    };
    child.stdout.on("data", (data: Buffer) => collect(data, true));
    child.stderr.on("data", (data: Buffer) => collect(data, false));
    child.on("error", stop);
    child.on("close", (code) => {
      if (code !== 0) failed = true;
      finish(failed ? undefined : Buffer.concat(chunks).toString("utf8"));
    });
  });
}
