import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { executable, runJson } from "./orca.ts";
import type { Runner, Target } from "./orca.ts";
import {
  assertLocalCaller,
  localEnvironment,
  runMutation,
} from "./launch-process.ts";
import type { MutationResult } from "./launch-process.ts";
import { verifySessionTerminal } from "./launch.ts";
import type { OwnedWorktree } from "./launch.ts";

export interface WorktreeInput {
  name: string;
  branch: string;
  baseBranch?: string;
}
export interface WorktreeRecord extends OwnedWorktree {
  name: string;
  branch: string;
}
export interface WorktreeOutcome {
  status: "ready" | "unconfirmed";
  name: string;
  record?: WorktreeRecord;
  errorCode?: string;
}
export interface WorktreeCreator {
  create(target: Target, input: unknown, cwd: string): Promise<WorktreeOutcome>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nameShape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A conservative subset of Git ref names. Never starts with "-", so it cannot be an option.
export function validRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.split("/").some((part) => part.startsWith(".") || part === "")
  );
}

export function parseWorktreeInput(value: unknown): WorktreeInput {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !["name", "branch", "baseBranch"].includes(key),
    ) ||
    typeof value.name !== "string" ||
    !nameShape.test(value.name) ||
    !validRef(value.branch) ||
    (value.baseBranch !== undefined && !validRef(value.baseBranch))
  ) {
    throw new Error(
      "Invalid worktree input. Provide a short name, a branch name and an optional base ref, using only letters, digits and . _ - /.",
    );
  }
  return {
    name: value.name,
    branch: value.branch,
    ...(typeof value.baseBranch === "string"
      ? { baseBranch: value.baseBranch }
      : {}),
  };
}

export function validWorktreeRecord(value: unknown): value is WorktreeRecord {
  return (
    record(value) &&
    typeof value.name === "string" &&
    nameShape.test(value.name) &&
    validRef(value.branch) &&
    typeof value.id === "string" &&
    value.id.length <= 4096 &&
    value.id.includes("::") &&
    typeof value.path === "string" &&
    value.path.length <= 4096 &&
    isAbsolute(value.path)
  );
}

export class WorktreeManager implements WorktreeCreator {
  private readonly read: Runner;
  private readonly mutate: (
    args: string[],
    stdin: string,
  ) => Promise<MutationResult>;
  private readonly canonical: (path: string) => Promise<string>;
  private readonly env: NodeJS.ProcessEnv;
  constructor({
    read,
    mutate,
    canonical = realpath,
    env = process.env,
  }: {
    read?: Runner;
    mutate?: (args: string[], stdin: string) => Promise<MutationResult>;
    canonical?: (path: string) => Promise<string>;
    env?: NodeJS.ProcessEnv;
  } = {}) {
    this.env = env;
    const binary = executable(env);
    this.read =
      read ??
      ((args, signal) =>
        runJson(binary, [...args, "--environment", "local"], {
          signal,
          env: localEnvironment(env),
        }));
    this.mutate =
      mutate ?? ((args, stdin) => runMutation(binary, args, stdin, { env }));
    this.canonical = canonical;
  }
  async create(
    target: Target,
    input: unknown,
    cwd: string,
  ): Promise<WorktreeOutcome> {
    const values = parseWorktreeInput(input);
    assertLocalCaller(this.env);
    const terminal = await verifySessionTerminal(
      this.read,
      this.canonical,
      target,
      cwd,
    );
    const repoId = terminal.worktreeId.slice(
      0,
      terminal.worktreeId.indexOf("::"),
    );
    if (!repoId || /[\s\0]/.test(repoId))
      return {
        status: "unconfirmed",
        name: values.name,
        errorCode: "bad_repo",
      };
    const args = [
      "worktree",
      "create",
      "--repo",
      `id:${repoId}`,
      "--name",
      values.name,
      "--branch",
      values.branch,
      ...(values.baseBranch ? ["--base-branch", values.baseBranch] : []),
      "--setup",
      "skip",
      "--no-parent",
      "--environment",
      "local",
      "--json",
    ];
    // Do not pass a model-turn AbortSignal: Orca can finish after the CLI is killed.
    return classifyWorktree(values, repoId, await this.mutate(args, ""));
  }
}

export function classifyWorktree(
  input: WorktreeInput,
  repoId: string,
  transport: MutationResult,
): WorktreeOutcome {
  const base = { name: input.name };
  if (transport.problem || !record(transport.envelope))
    return {
      ...base,
      status: "unconfirmed",
      errorCode: transport.problem ?? "invalid_receipt",
    };
  const envelope = transport.envelope;
  const worktree =
    envelope.ok === true &&
    record(envelope.result) &&
    record(envelope.result.worktree)
      ? envelope.result.worktree
      : undefined;
  if (
    !worktree ||
    typeof worktree.id !== "string" ||
    typeof worktree.path !== "string" ||
    worktree.repoId !== repoId ||
    !worktree.id.startsWith(`${repoId}::`) ||
    worktree.hostId !== "local" ||
    worktree.isBare === true ||
    worktree.isMainWorktree === true ||
    worktree.branch !== `refs/heads/${input.branch}`
  ) {
    const error = record(envelope.error) ? envelope.error : undefined;
    return {
      ...base,
      status: "unconfirmed",
      errorCode:
        error &&
        typeof error.code === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(error.code)
          ? error.code
          : "unverified_receipt",
    };
  }
  const result: WorktreeRecord = {
    name: input.name,
    branch: input.branch,
    id: worktree.id,
    path: worktree.path,
  };
  return validWorktreeRecord(result)
    ? { ...base, status: "ready", record: result }
    : { ...base, status: "unconfirmed", errorCode: "invalid_receipt" };
}
