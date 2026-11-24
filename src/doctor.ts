import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { executable, runJson } from "./orca.ts";
import { assertLocalCaller, localEnvironment } from "./launch-process.ts";
import { readGitMetadata } from "./doctor-process.ts";
import type { ProbeContext } from "./doctor-process.ts";

export type DoctorAgent = "claude" | "codex" | "cursor" | "opencode";
export interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "unknown" | "skipped";
  message: string;
  action?: string;
}
export interface DoctorReport {
  schema: "pi-orca.doctor.v1";
  status: "blocked" | "live-test-required";
  checks: DoctorCheck[];
}
interface Options {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  canonical?: (path: string) => Promise<string>;
  find?: (
    name: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  git?: (
    binary: string,
    args: string[],
    context: ProbeContext,
  ) => Promise<string>;
  orca?: (
    binary: string,
    args: string[],
    context: ProbeContext,
  ) => Promise<unknown>;
}
const agents = ["claude", "codex", "cursor", "opencode"];
export function parseAgent(value: unknown): DoctorAgent | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !agents.includes(value))
    throw new Error("Choose claude, codex, cursor or opencode.");
  return value as DoctorAgent;
}
export function supportsNode(value: string): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return (
    !!parts &&
    (Number(parts[1]) > 22 ||
      (Number(parts[1]) === 22 && Number(parts[2]) >= 19))
  );
}
function bounded(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function findExecutable(
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!bounded(name)) return undefined;
  let candidates: string[];
  if (name.includes("/")) candidates = [resolve(cwd, name)];
  else {
    const path = env.PATH ?? "/usr/bin:/bin";
    if (Buffer.byteLength(path) > 32768) return undefined;
    const entries = path.split(delimiter);
    if (entries.length > 128) return undefined;
    candidates = entries.map((entry) => resolve(cwd, entry || ".", name));
  }
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (!bounded(candidate)) continue;
    try {
      if ((await stat(candidate)).isFile()) {
        signal?.throwIfAborted();
        await access(candidate, constants.X_OK);
        signal?.throwIfAborted();
        return candidate;
      }
    } catch {
      /* An absent candidate is not an executable installation. */
    }
  }
  return undefined;
}
// Filesystem calls cannot be cancelled, so fence their late results instead.
function filesystemResult<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Filesystem discovery cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("Filesystem discovery failed."));
      },
    );
    if (signal.aborted) abort();
  });
}
function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

export async function diagnose(
  cwd: string,
  input?: unknown,
  options: Options = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (
    id: string,
    status: DoctorCheck["status"],
    message: string,
    action?: string,
  ) => checks.push({ id, status, message, ...(action ? { action } : {}) });
  const done = (): DoctorReport => {
    add(
      "versions",
      "unknown",
      "Pi, Git, Orca and harness versions were not queried.",
      "Compare installed versions with the README's tested versions using official instructions.",
    );
    add(
      "identity",
      "unknown",
      "Executable names do not verify vendor or selected-account identity.",
    );
    add(
      "authentication",
      "unknown",
      "No credentials, provider settings or authentication status were inspected.",
      "Use the chosen harness's official sign-in instructions yourself.",
    );
    add(
      "quota",
      "unknown",
      "Available quota and billing configuration were not queried.",
    );
    add(
      "live-test",
      "unknown",
      "No worker test or model request was made.",
      "Optionally authorize one worker test; it may make multiple billable requests.",
    );
    return {
      schema: "pi-orca.doctor.v1",
      status: checks.some((c) => c.status === "fail")
        ? "blocked"
        : "live-test-required",
      checks,
    };
  };
  const env = options.env ?? process.env;
  const signal = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const find = options.find ?? findExecutable;
  const canonical = (path: string) =>
    filesystemResult((options.canonical ?? realpath)(path), signal);
  const node = options.nodeVersion ?? process.version;
  let agent: DoctorAgent | undefined;
  try {
    agent = parseAgent(input);
  } catch {
    add(
      "arguments",
      "fail",
      "The selected harness is unsupported.",
      "Choose claude, codex, cursor or opencode, or omit the selection.",
    );
    return done();
  }
  if (!["darwin", "linux"].includes(options.platform ?? process.platform)) {
    add(
      "platform",
      "fail",
      "This platform is unsupported.",
      "Use macOS or Linux; Windows is not supported.",
    );
    return done();
  }
  if (!supportsNode(node)) {
    add(
      "node",
      "fail",
      "Node 22.19 or newer is required.",
      "Install a supported Node release using nodejs.org.",
    );
    return done();
  }
  add("node", "pass", `Running Node ${node}.`);
  try {
    assertLocalCaller(env);
  } catch {
    add(
      "caller",
      "fail",
      "Managed Orca identities or remote routing overrides are unsupported.",
      "Start Pi in an external terminal at the registered local repository root; do not borrow another terminal identity.",
    );
    return done();
  }
  try {
    signal.throwIfAborted();
    if (!bounded(cwd) || !isAbsolute(cwd)) throw new Error();
    const root = await canonical(cwd);
    signal.throwIfAborted();
    if (!bounded(root) || !isAbsolute(root)) throw new Error();
    const candidate = async (id: string, name: string) => {
      signal.throwIfAborted();
      const found = await filesystemResult(
        find(name, root, env, signal),
        signal,
      );
      signal.throwIfAborted();
      add(
        id,
        found ? "pass" : "fail",
        found
          ? "Executable candidate found; it was not run for discovery."
          : "No executable candidate was found within the bounded search.",
        found
          ? undefined
          : "Install the required tool from its official site or fix PATH. See README prerequisites.",
      );
      return found;
    };
    const pi = await candidate("pi", "pi");
    const gitName = env.PI_ORCA_GIT ?? "/usr/bin/git";
    let git = isAbsolute(gitName) ? await candidate("git", gitName) : undefined;
    if (!isAbsolute(gitName))
      add(
        "git",
        "fail",
        "PI_ORCA_GIT must be an absolute trusted executable path.",
      );
    const orca = await candidate("orca", executable(env, options.platform));
    if (agent) {
      if (agent === "cursor") {
        let found = await filesystemResult(
          find("cursor-agent", root, env, signal),
          signal,
        );
        signal.throwIfAborted();
        if (!found)
          found = await filesystemResult(
            find("agent", root, env, signal),
            signal,
          );
        signal.throwIfAborted();
        add(
          "agent",
          found ? "pass" : "fail",
          found
            ? "Cursor executable candidate found; vendor identity and version are unverified."
            : "No Cursor executable candidate was found.",
          "Verify the chosen executable and sign in using cursor.com/docs/cli.",
        );
      } else await candidate("agent", agent);
    } else
      add(
        "agent",
        "skipped",
        "No harness was selected.",
        "Choose one configured harness; all four are not required.",
      );
    if (!pi || !git || !orca || checks.some((c) => c.status === "fail"))
      return done();
    if (
      (options.platform ?? process.platform) === "darwin" &&
      (await canonical(git)) === "/usr/bin/git"
    ) {
      // Apple's launcher can open an installer. Invoke only an existing real Git.
      let developerGit: string | undefined;
      if (env.PI_ORCA_GIT === undefined) {
        for (const path of [
          "/Library/Developer/CommandLineTools/usr/bin/git",
          "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
        ]) {
          signal.throwIfAborted();
          const found = await filesystemResult(
            find(path, root, env, signal),
            signal,
          );
          if (found && (await canonical(found)) !== "/usr/bin/git") {
            developerGit = found;
            break;
          }
        }
      }
      if (!developerGit) {
        add(
          "git-tools",
          "fail",
          "Apple's Git installer launcher was not executed; a real Git executable could not be selected passively.",
          "Install Command Line Tools or Xcode yourself, or set PI_ORCA_GIT to an existing trusted Git executable rather than Apple's launcher. See README prerequisites.",
        );
        return done();
      }
      git = developerGit;
      add(
        "git-tools",
        "pass",
        "Using an existing Apple developer-tools Git executable instead of the installer launcher.",
      );
    }
    signal.throwIfAborted();
    const gitRoot = await (options.git ?? readGitMetadata)(
      git,
      ["rev-parse", "--show-toplevel"],
      { cwd: root, env: gitEnvironment(env), signal },
    );
    signal.throwIfAborted();
    if (
      !bounded(gitRoot.trim()) ||
      (await canonical(gitRoot.trim())) !== root
    ) {
      add(
        "workspace",
        "fail",
        "The current directory is not the Git worktree root.",
        "Change to the repository root and rerun diagnostics.",
      );
      return done();
    }
    const args = [
      "worktree",
      "show",
      "--worktree",
      `path:${root}`,
      "--json",
      "--environment",
      "local",
    ];
    const context: ProbeContext = {
      cwd: root,
      env: localEnvironment(env),
      signal,
    };
    const response = await (
      options.orca ??
      ((binary, argv, ctx) =>
        runJson(binary, argv, {
          env: ctx.env,
          signal: ctx.signal,
          timeoutMs: 5000,
          maxBytes: 65536,
        }))
    )(orca, args, context);
    signal.throwIfAborted();
    const w =
      record(response) && record(response.worktree)
        ? response.worktree
        : undefined;
    if (
      !w ||
      !bounded(w.id) ||
      !w.id.includes("::") ||
      !bounded(w.path) ||
      !record(w.identity) ||
      w.identity.executionHostId !== "local" ||
      !isAbsolute(w.path) ||
      !isAbsolute(w.id.slice(w.id.indexOf("::") + 2)) ||
      (await canonical(w.path)) !== root ||
      (await canonical(w.id.slice(w.id.indexOf("::") + 2))) !== root
    ) {
      add(
        "workspace",
        "fail",
        "Orca did not verify the same registered local worktree root.",
        "Start Orca and register this existing checkout using its official workspace guide. Do not create a replacement checkout.",
      );
    } else
      add(
        "workspace",
        "pass",
        "Git and Orca metadata identify the same local worktree root.",
      );
    signal.throwIfAborted();
  } catch {
    add(
      "metadata",
      "fail",
      signal.aborted
        ? "Diagnostics were cancelled or exceeded their deadline."
        : "A required filesystem or local metadata check failed or returned an unsupported response.",
      "Check the trusted Git/Orca installations and existing local workspace registration. No startup or recovery action was attempted.",
    );
  }
  return done();
}

export function formatDoctor(report: DoctorReport): string {
  return [
    `Pi-Orca prerequisites: ${report.status}`,
    ...report.checks.map(
      (c) =>
        `${c.status.toUpperCase()} ${c.id}: ${c.message}${c.action ? ` ${c.action}` : ""}`,
    ),
  ].join("\n");
}
