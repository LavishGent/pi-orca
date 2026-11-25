import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Target } from "./orca.ts";
import { commandText } from "./orca.ts";
import type {
  Launcher,
  LaunchOutcome,
  LaunchPlan,
  LaunchInput,
} from "./launch.ts";
import { parseLaunchInput, validPlan } from "./launch.ts";
import { EditSafetyError } from "./edit-scope.ts";
import { ownedWorktrees } from "./worktree-tools.ts";
import type { WorktreeRecord } from "./worktree.ts";
import {
  launchEntryType,
  readLaunchJournal,
  recordVersion,
} from "./launch-journal.ts";

interface Connection {
  target: Target;
  sessionId: string;
  ctx: ExtensionContext;
}
interface Access {
  get(): Connection | undefined;
  active(): boolean;
  ready?(ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
}
function result(text: string, details: unknown = {}, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}
function summary(
  outcome: LaunchOutcome,
  inspection: boolean,
  env: NodeJS.ProcessEnv,
): string {
  return [
    JSON.stringify(outcome),
    inspection
      ? "Read-only inspection of the recorded launch request. A recorded launch receipt is not current worker/task status. No worker was started or retried."
      : outcome.status === "ready"
        ? "Worker started. End the turn and await its report through orca_inbox."
        : outcome.status === "unconfirmed"
          ? "The worker may be starting; do not resend. New starts for this run are blocked pending inspection."
          : "The start is unresolved. Do not retry or start another worker for this run.",
    `Inspect without retrying: ${commandText(["orchestration", "request-show", "--request", outcome.requestId, "--full", "--json", "--environment", "local"], env)}`,
    "Use orca_launch_status to reconcile the recorded request. It never retries a launch.",
  ].join("\n");
}

export function registerLaunchTools(
  pi: ExtensionAPI,
  launcher: Launcher,
  access: Access,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const inFlight = new Set<string>();
  let editInFlight = false;
  pi.registerTool({
    name: "orca_worker_start",
    label: "Start scoped Orca worker",
    description:
      "Start one user-authorized task in the owned existing local workspace, or in a worktree this session created with orca_worktree_create (optional `worktree` name). Default mode is read-only. Opt-in mode=edit requires an exact files list: clean tracked files or genuinely new files only, no existing user changes, directories, symlinks or Git metadata. Edit scopes are task instructions, not a sandbox. Prior edit workers in this session workspace must be verified exited; this does not lock other sessions, forks or Pi's own file tools. No arbitrary launch commands, remote placement, credential setup, commits or permission bypasses. Models/effort must be verified and authorized; no model selection here. Uncertain starts block further starts in this session file. Never resend them.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string" },
        title: { type: "string" },
        spec: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        mode: { type: "string", enum: ["read-only", "edit"] },
        worktree: { type: "string" },
        files: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 32,
        },
      },
      required: ["agent", "title", "spec"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (access.ready) await access.ready(ctx, signal);
      } catch {
        return result(
          "Orca setup is unavailable or this call was cancelled. No worker was started; inspect /orca-watch status.",
          {},
          true,
        );
      }
      const value = access.get();
      if (!value || value.sessionId !== ctx.sessionManager.getSessionId())
        return result(
          "Attach this conversation to its owned local run and ensure the observer is watching or notified before starting a worker.",
          {},
          true,
        );
      if (!ctx.sessionManager.getSessionFile())
        return result(
          "Worker launches require a persistent Pi session for the launch journal.",
          {},
          true,
        );
      let input: LaunchInput;
      let owned: WorktreeRecord | undefined;
      try {
        const { worktree, ...rest } = (params ?? {}) as Record<string, unknown>;
        input = parseLaunchInput(rest);
        if (worktree !== undefined) {
          owned =
            typeof worktree === "string"
              ? ownedWorktrees(ctx.sessionManager.getEntries()).get(worktree)
              : undefined;
          if (!owned)
            return result(
              "The worktree must be one created by orca_worktree_create in this session and confirmed ready. No worker was started.",
              {},
              true,
            );
        }
      } catch {
        return result(
          "Invalid launch input or edit file scope. No worker was started.",
          {},
          true,
        );
      }
      const editing = input.mode === "edit";
      const run = value.target.run;
      if (inFlight.has(run))
        return result(
          "A worker start is already in progress for this run. Do not resend.",
          {},
          true,
        );
      if (editing && editInFlight)
        return result(
          "Another edit submission is in progress in this Pi extension. No new start was issued.",
          {},
          true,
        );
      if (editing) editInFlight = true;
      inFlight.add(run);
      let plan: LaunchPlan | undefined;
      let recorded = false;
      try {
        const blocked = [
          ...readLaunchJournal(ctx.sessionManager.getEntries()).values(),
        ].find((row) => row.plan.target.run === run && row.status !== "ready");
        if (blocked)
          return result(
            `Request ${blocked.plan.requestId} remains unresolved. Inspect it with orca_launch_status; no new start was issued.`,
            { requestId: blocked.plan.requestId },
            true,
          );
        if (signal?.aborted)
          return result(
            "Cancelled before launch; no start was issued.",
            {},
            true,
          );
        plan = await launcher.prepare(
          value.target,
          input,
          ctx.cwd,
          owned ? { id: owned.id, path: owned.path } : undefined,
        );
        const verifyPreparedPlan = () => {
          if (
            !plan ||
            !validPlan(plan) ||
            plan.target.run !== value.target.run ||
            plan.target.terminal !== value.target.terminal ||
            (["agent", "title", "spec", "model", "effort"] as const).some(
              (field) => plan?.[field] !== input[field],
            ) ||
            (plan.mode ?? "read-only") !== (input.mode ?? "read-only") ||
            JSON.stringify(plan.files ?? []) !==
              JSON.stringify(input.files ?? [])
          )
            throw new EditSafetyError(
              "The prepared plan does not match the requested permissions or exceeds its bounds.",
            );
        };
        verifyPreparedPlan();
        if (editing) {
          if (!launcher.validateEdits)
            throw new EditSafetyError(
              "This launcher does not support scoped edits.",
            );
          const previous = [
            ...readLaunchJournal(ctx.sessionManager.getEntries()).values(),
          ].filter(
            (row) =>
              row.plan.mode === "edit" &&
              (row.plan.worktreeId === plan?.worktreeId ||
                row.plan.workspacePath === plan?.workspacePath),
          );
          const unresolved = previous.find((row) => row.status !== "ready");
          if (unresolved)
            throw new EditSafetyError(
              `Editor request ${unresolved.plan.requestId} remains unresolved. Inspect it; do not bypass the record.`,
            );
          if (previous.length > 32)
            throw new EditSafetyError(
              "Edit history exceeds 32 plans. Manually verify prior writers before considering a fresh session with a new owned run; never bypass unresolved mutations.",
            );
          await launcher.validateEdits(
            plan,
            previous.map((row) => row.plan),
            signal,
          );
          verifyPreparedPlan();
        }
        if (
          signal?.aborted ||
          access.get() !== value ||
          !access.active() ||
          ctx.sessionManager.getSessionId() !== value.sessionId
        )
          return result(
            "The attachment changed or the call was cancelled during preflight. No start was issued.",
            {},
            true,
          );
        pi.appendEntry(launchEntryType, {
          version: recordVersion(plan),
          plan,
          status: "pending",
        });
        recorded = true;
        const outcome = await launcher.submit(plan);
        if (
          !access.active() ||
          value.ctx.sessionManager.getSessionId() !== value.sessionId
        ) {
          return result(
            `The extension session changed after submission. Request ${plan.requestId} may have started. Its pending journal entry requires reconciliation.`,
            { requestId: plan.requestId },
            true,
          );
        }
        pi.appendEntry(launchEntryType, {
          version: recordVersion(plan),
          plan,
          status: outcome.status,
          outcome,
        });
        const observerWarning =
          access.get() !== value
            ? "\nThe original attachment is no longer eligible to receive reports. Do not relaunch; restore the owned attachment or inspect the recorded dispatch."
            : "";
        return result(
          summary(outcome, false, env) +
            observerWarning +
            (editing
              ? `\nEdit scope: ${JSON.stringify(plan.files)}. Pi must not edit these files concurrently. Review scoped diffs and verification evidence after completion; this receipt is not proof of editor exit.`
              : ""),
          editing ? { ...outcome, mode: "edit", files: plan.files } : outcome,
          outcome.status === "blocked",
        );
      } catch (error) {
        if (recorded && plan) {
          const outcome: LaunchOutcome = {
            status: "blocked",
            requestId: plan.requestId,
            runId: run,
            errorCode: "unresolved_start",
          };
          if (
            access.active() &&
            value.ctx.sessionManager.getSessionId() === value.sessionId
          ) {
            try {
              pi.appendEntry(launchEntryType, {
                version: recordVersion(plan),
                plan,
                status: "blocked",
                outcome,
              });
            } catch {
              /* The pending entry still blocks another start. */
            }
          }
          return result(summary(outcome, false, env), outcome, true);
        }
        if (error instanceof EditSafetyError)
          return result(
            `${error.message} No worker-start request was issued.`,
            {},
            true,
          );
        return result(
          "Launch preflight or journal recording failed. No worker-start request was issued. Check the caller identity, local workspace, input and session journal.",
          {},
          true,
        );
      } finally {
        inFlight.delete(run);
        if (editing) editInFlight = false;
      }
    },
  });

  pi.registerTool({
    name: "orca_launch_status",
    label: "Inspect recorded Orca launch",
    description:
      "Read-only reconciliation of a request recorded in this Pi session's launch journal. It never starts, retries, stops or deletes a worker. Only a verified ready receipt clears a launch block; pending, absent and failed receipts remain blocked.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      if (
        !params ||
        typeof params !== "object" ||
        !("requestId" in params) ||
        typeof params.requestId !== "string"
      )
        return result("Provide a recorded request ID.", {}, true);
      try {
        const record = readLaunchJournal(ctx.sessionManager.getEntries()).get(
          params.requestId,
        );
        if (!record)
          return result(
            "That request is not recorded in this Pi session. No query was issued.",
            {},
            true,
          );
        if (inFlight.has(record.plan.target.run))
          return result(
            "The original launch call is still running. Wait for its receipt; nothing was retried.",
            {},
            true,
          );
        const sessionId = ctx.sessionManager.getSessionId();
        const outcome = await launcher.inspect(record.plan);
        if (!access.active() || ctx.sessionManager.getSessionId() !== sessionId)
          return result(
            "Session changed during read-only inspection. The journal was not updated.",
            {},
            true,
          );
        if (outcome.status === "ready")
          pi.appendEntry(launchEntryType, {
            version: recordVersion(record.plan),
            plan: record.plan,
            status: "ready",
            outcome,
          });
        return result(
          summary(outcome, true, env),
          outcome,
          outcome.status === "blocked",
        );
      } catch {
        return result(
          "Read-only reconciliation failed. No worker was started or retried, and the journal block was not cleared.",
          {},
          true,
        );
      }
    },
  });
}
