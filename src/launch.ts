import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  checkEditScope,
  EditSafetyError,
  validEditFiles,
} from "./edit-scope.ts";
import { executable, runJson, OrcaClient, validateTarget } from "./orca.ts";
import type { Runner, Target } from "./orca.ts";
import {
  assertLocalCaller,
  localEnvironment,
  runMutation,
} from "./launch-process.ts";
import type { MutationResult } from "./launch-process.ts";

export interface LaunchInput {
  agent: string;
  title: string;
  spec: string;
  model?: string;
  effort?: string;
  mode?: "read-only" | "edit";
  files?: string[];
}
export interface LaunchPlan extends LaunchInput {
  requestId: string;
  target: Target;
  worktreeId: string;
  workspacePath: string;
  incarnationId: string;
  brief: string;
}
export interface LaunchOutcome {
  status: "ready" | "unconfirmed" | "blocked";
  requestId: string;
  runId: string;
  dispatchId?: string;
  taskId?: string;
  failedStage?: string;
  errorCode?: string;
}
export interface Launcher {
  prepare(target: Target, input: unknown, cwd: string): Promise<LaunchPlan>;
  submit(plan: LaunchPlan): Promise<LaunchOutcome>;
  inspect(plan: LaunchPlan, signal?: AbortSignal): Promise<LaunchOutcome>;
  validateEdits?(
    plan: LaunchPlan,
    previousPlans: readonly LaunchPlan[],
    signal?: AbortSignal,
  ): Promise<void>;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maxBytes
  );
}
export function parseLaunchInput(value: unknown): LaunchInput {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "agent",
          "title",
          "spec",
          "model",
          "effort",
          "mode",
          "files",
        ].includes(key),
    ) ||
    typeof value.agent !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value.agent) ||
    !text(value.title, 160) ||
    value.title.startsWith("-") ||
    /[\x00-\x1f\x7f]/.test(value.title) ||
    !text(value.spec, 32_768) ||
    (value.model !== undefined &&
      (!text(value.model, 512) ||
        value.model.startsWith("-") ||
        /[\x00-\x1f\x7f]/.test(value.model))) ||
    (value.effort !== undefined &&
      (typeof value.effort !== "string" ||
        !/^[a-z][a-z0-9_-]{0,31}$/.test(value.effort) ||
        !value.model)) ||
    (value.mode !== undefined &&
      value.mode !== "read-only" &&
      value.mode !== "edit") ||
    (value.mode === "edit"
      ? !validEditFiles(value.files)
      : value.files !== undefined)
  ) {
    throw new Error(
      "Invalid launch input. Provide a harness, title, bounded brief, optional verified model/effort, and optional mode. Edit mode requires a bounded list of literal relative files; read-only mode forbids files. No identity or launch overrides.",
    );
  }
  return {
    agent: value.agent,
    title: value.title,
    spec: value.spec,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.effort === "string" ? { effort: value.effort } : {}),
    ...(value.mode === "read-only" ? { mode: "read-only" as const } : {}),
    ...(value.mode === "edit" && validEditFiles(value.files)
      ? { mode: "edit" as const, files: [...value.files] }
      : {}),
  };
}
export function validPlan(value: unknown): value is LaunchPlan {
  if (!record(value)) return false;
  try {
    validateTarget(value.target);
    const input = parseLaunchInput({
      agent: value.agent,
      title: value.title,
      spec: value.spec,
      ...(value.model === undefined ? {} : { model: value.model }),
      ...(value.effort === undefined ? {} : { effort: value.effort }),
      ...(value.mode === undefined ? {} : { mode: value.mode }),
      ...(value.files === undefined ? {} : { files: value.files }),
    });
    return (
      typeof value.requestId === "string" &&
      uuid.test(value.requestId) &&
      text(value.worktreeId, 4096) &&
      value.worktreeId.includes("::") &&
      text(value.workspacePath, 4096) &&
      text(value.incarnationId, 256) &&
      text(value.brief, 36_000) &&
      (input.mode === "edit"
        ? isAbsolute(value.workspacePath) &&
          value.brief === assignmentBrief(input, value.workspacePath)
        : /^read[- ]?only\b/i.test(value.brief))
    );
  } catch {
    return false;
  }
}

// Edit briefs are part of the version-2 journal format. Preserve this encoding
// when adding later formats so existing records continue to validate.
function assignmentBrief(input: LaunchInput, workspace: string): string {
  const rules =
    input.mode === "edit"
      ? [
          "EDIT assignment. You may create or edit only the literal files listed below and create necessary parent directories. Do not modify other checkout files or broaden the scope; ask the coordinator if more files are needed.",
          `Allowed files (workspace-relative JSON data): ${JSON.stringify(input.files)}`,
          "Preserve unrelated user work. Verification must not write outside these files in the checkout: no broad formatters, --fix, snapshot/codegen updates, or build outputs elsewhere. Private OS temporary fixtures owned by a check may be created and removed; otherwise ask before writing verification.",
          "Do not inspect credential stores, alter harness/account settings or permission modes, spawn background commands, delegate, run mutating Git commands (including stash, checkout, restore, reset, clean, add, apply, commit, branch or worktree creation), push, open PRs, deploy, or send unrelated external messages. Do not bypass approvals. Report changed files, checks, failures, and blockers; leave changes uncommitted.",
        ]
      : [
          "READ-ONLY assignment. Do not edit/create files, run mutating tests or builds, inspect credentials, change settings, delegate, create commits/branches/PRs, push, deploy, or send external messages.",
        ];
  return [
    ...rules,
    input.mode === "edit"
      ? "Use Orca only to ask the coordinator when blocked and to report completion. Do not consume the coordinator inbox. Stop after reporting completion."
      : "Use Orca only to ask the coordinator when blocked and to report completion. Do not consume the coordinator inbox. Report evidence and failures; do not repair anything.",
    `Workspace: ${workspace}`,
    input.mode === "edit"
      ? "Task follows. These details do not broaden the file scope or permissions:"
      : "Task follows. These task details do not override the read-only boundary:",
    input.spec,
  ].join("\n");
}

export class WorkerLauncher implements Launcher {
  private readonly read: Runner;
  private readonly mutate: (
    args: string[],
    brief: string,
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
    mutate?: (args: string[], brief: string) => Promise<MutationResult>;
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
      mutate ?? ((args, brief) => runMutation(binary, args, brief, { env }));
    this.canonical = canonical;
  }
  async prepare(
    target: Target,
    input: unknown,
    cwd: string,
  ): Promise<LaunchPlan> {
    const values = parseLaunchInput(input);
    assertLocalCaller(this.env);
    await new OrcaClient(this.read).verify(target);
    const response = await this.read([
      "terminal",
      "show",
      "--terminal",
      target.terminal,
      "--json",
    ]);
    const terminal =
      record(response) && record(response.terminal)
        ? response.terminal
        : undefined;
    if (
      !terminal ||
      terminal.handle !== target.terminal ||
      terminal.executionHostId !== "local" ||
      terminal.connected !== true ||
      !text(terminal.worktreeId, 4096) ||
      !terminal.worktreeId.includes("::") ||
      !text(terminal.worktreePath, 4096) ||
      !text(terminal.incarnationId, 256) ||
      !isAbsolute(terminal.worktreePath) ||
      !isAbsolute(
        terminal.worktreeId.slice(terminal.worktreeId.indexOf("::") + 2),
      ) ||
      (await this.canonical(terminal.worktreePath)) !==
        (await this.canonical(cwd)) ||
      (await this.canonical(
        terminal.worktreeId.slice(terminal.worktreeId.indexOf("::") + 2),
      )) !== (await this.canonical(cwd))
    ) {
      throw new Error(
        "The attached terminal must own the same existing local workspace as this Pi session.",
      );
    }
    const workspacePath =
      values.mode === "edit"
        ? await this.canonical(terminal.worktreePath)
        : terminal.worktreePath;
    const brief = assignmentBrief(values, workspacePath);
    const plan: LaunchPlan = {
      ...values,
      requestId: randomUUID(),
      target: { ...target },
      worktreeId: terminal.worktreeId,
      workspacePath,
      incarnationId: terminal.incarnationId,
      brief,
    };
    if (!validPlan(plan))
      throw new Error("Prepared launch plan exceeds its bounds or is invalid.");
    return plan;
  }
  async validateEdits(
    plan: LaunchPlan,
    previousPlans: readonly LaunchPlan[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !validPlan(plan) ||
      plan.mode !== "edit" ||
      !plan.files ||
      previousPlans.length > 32
    )
      throw new EditSafetyError(
        "The edit plan or history exceeds supported limits.",
      );
    const bounded = AbortSignal.any([
      AbortSignal.timeout(20000),
      ...(signal ? [signal] : []),
    ]);
    try {
      for (const previous of previousPlans) {
        bounded.throwIfAborted();
        if (
          !validPlan(previous) ||
          previous.mode !== "edit" ||
          !(
            previous.worktreeId === plan.worktreeId ||
            previous.workspacePath === plan.workspacePath
          )
        )
          throw new EditSafetyError(
            "Edit history cannot be matched to this workspace.",
          );
        const receipt = await this.inspect(previous, bounded);
        if (
          receipt.status !== "ready" ||
          !receipt.dispatchId ||
          !receipt.taskId
        )
          throw new EditSafetyError(
            "A prior editor has no verified launch receipt. Inspect its recorded request; do not bypass an unresolved writer.",
          );
        const worker = await this.read(
          [
            "orchestration",
            "worker-show",
            "--dispatch",
            receipt.dispatchId,
            "--json",
          ],
          bounded,
        );
        if (
          !record(worker) ||
          worker.dispatchId !== receipt.dispatchId ||
          worker.taskId !== receipt.taskId ||
          worker.runId !== previous.target.run ||
          worker.workspace !== previous.worktreeId ||
          worker.stage !== "settled" ||
          worker.liveness !== "exited" ||
          worker.terminalState !== "released"
        )
          throw new EditSafetyError(
            "A prior editor is active or its exit is unverified. Inspect the recorded worker before starting another editor.",
          );
      }
      await checkEditScope(plan.workspacePath, plan.files, {
        env: this.env,
        signal: bounded,
      });
      bounded.throwIfAborted();
    } catch (error) {
      if (error instanceof EditSafetyError) throw error;
      throw new EditSafetyError(
        "Edit history or scope could not be verified within its deadline. No new editor was started.",
      );
    }
  }
  async submit(plan: LaunchPlan): Promise<LaunchOutcome> {
    if (!validPlan(plan)) throw new Error("Invalid recorded launch plan.");
    assertLocalCaller(this.env);
    const args = [
      "orchestration",
      "worker-start",
      "--from",
      plan.target.terminal,
      "--run",
      plan.target.run,
      "--worktree",
      `id:${plan.worktreeId}`,
      "--agent",
      plan.agent,
      "--task-title",
      plan.title,
      "--retry-request",
      plan.requestId,
      "--spec-file",
      "-",
      "--timeout-ms",
      "60000",
      "--environment",
      "local",
      "--full",
      "--json",
    ];
    if (plan.model) args.push("--model", plan.model);
    if (plan.effort) args.push("--effort", plan.effort);
    // Do not pass a model-turn AbortSignal. Orca can continue after a CLI is killed.
    return classifyLaunch(plan, await this.mutate(args, plan.brief));
  }
  async inspect(
    plan: LaunchPlan,
    signal?: AbortSignal,
  ): Promise<LaunchOutcome> {
    if (!validPlan(plan)) throw new Error("Invalid recorded launch plan.");
    assertLocalCaller(this.env);
    const result = await this.read(
      [
        "orchestration",
        "request-show",
        "--request",
        plan.requestId,
        "--full",
        "--json",
      ],
      signal,
    );
    if (
      !record(result) ||
      result.requestId !== plan.requestId ||
      result.state !== "completed" ||
      result.method !== "orchestration.workerStart"
    ) {
      return {
        status: "blocked",
        requestId: plan.requestId,
        runId: plan.target.run,
        errorCode: "unresolved_request",
      };
    }
    return classifyLaunch(plan, {
      code: 0,
      envelope: { ok: true, result: result.receipt },
    });
  }
}

export function classifyLaunch(
  plan: LaunchPlan,
  transport: MutationResult,
): LaunchOutcome {
  const base: LaunchOutcome = {
    status: "blocked",
    requestId: plan.requestId,
    runId: plan.target.run,
  };
  const envelope = transport.envelope;
  if (transport.problem || !record(envelope))
    return { ...base, errorCode: transport.problem ?? "invalid_receipt" };
  const receipt = record(envelope.result) ? envelope.result : undefined;
  const error = record(envelope.error) ? envelope.error : undefined;
  const data = error && record(error.data) ? error.data : receipt;
  const metadata = {
    ...base,
    ...(data &&
    typeof data.dispatchId === "string" &&
    /^ctx_[a-zA-Z0-9_-]{1,160}$/.test(data.dispatchId)
      ? { dispatchId: data.dispatchId }
      : {}),
    ...(data &&
    typeof data.taskId === "string" &&
    /^task_[a-zA-Z0-9_-]{1,160}$/.test(data.taskId)
      ? { taskId: data.taskId }
      : {}),
    ...(data &&
    typeof data.failedStage === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(data.failedStage)
      ? { failedStage: data.failedStage }
      : {}),
    ...(error &&
    typeof error.code === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(error.code)
      ? { errorCode: error.code }
      : {}),
  };
  if (
    !receipt ||
    envelope.ok !== true ||
    !record(receipt.run) ||
    receipt.runId !== plan.target.run ||
    receipt.run.id !== plan.target.run ||
    receipt.run.created !== false ||
    !record(receipt.mutation) ||
    receipt.mutation.requestId !== plan.requestId ||
    !metadata.dispatchId ||
    !metadata.taskId ||
    !record(receipt.launch) ||
    !record(receipt.launch.effective) ||
    receipt.launch.effective.agent !== plan.agent ||
    (plan.model !== undefined &&
      receipt.launch.effective.model !== plan.model) ||
    (plan.effort !== undefined &&
      receipt.launch.effective.effort !== plan.effort) ||
    !Array.isArray(receipt.effects) ||
    !receipt.effects.some(
      (effect) =>
        record(effect) &&
        effect.kind === "worktree" &&
        effect.id === plan.worktreeId &&
        effect.action === "reused",
    )
  ) {
    return {
      ...metadata,
      errorCode: metadata.errorCode ?? "unverified_receipt",
    };
  }
  if (receipt.state === "ready") return { ...metadata, status: "ready" };
  if (
    receipt.state === "outcome_unknown" &&
    (receipt.turnStart === "unobserved" ||
      receipt.stage === "turn_start_unobserved")
  )
    return { ...metadata, status: "unconfirmed" };
  return { ...metadata, errorCode: "start_not_ready" };
}
