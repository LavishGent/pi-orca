import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Target } from "./orca.ts";
import { parseWorktreeInput, validWorktreeRecord } from "./worktree.ts";
import type { WorktreeCreator, WorktreeRecord } from "./worktree.ts";

export const worktreeEntryType = "orca-worktree-journal";

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

/**
 * Worktrees this session created and Orca confirmed. Only these may be named by
 * orca_worker_start. Every transcript branch is read, and malformed entries
 * grant nothing.
 */
export function ownedWorktrees(
  entries: readonly SessionEntry[],
): Map<string, WorktreeRecord> {
  const owned = new Map<string, WorktreeRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== worktreeEntryType)
      continue;
    const data: unknown = entry.data;
    if (
      data &&
      typeof data === "object" &&
      "version" in data &&
      data.version === 1 &&
      "status" in data &&
      data.status === "ready" &&
      "record" in data &&
      validWorktreeRecord(data.record)
    )
      owned.set(data.record.name, data.record);
  }
  return owned;
}

function journaledNames(entries: readonly SessionEntry[]): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== worktreeEntryType)
      continue;
    const data: unknown = entry.data;
    if (
      data &&
      typeof data === "object" &&
      "name" in data &&
      typeof data.name === "string"
    )
      names.add(data.name);
  }
  return names;
}

export function registerWorktreeTools(
  pi: ExtensionAPI,
  creator: WorktreeCreator,
  access: Access,
): void {
  let inFlight = false;
  pi.registerTool({
    name: "orca_worktree_create",
    label: "Create Orca worktree",
    description:
      "Create one new Orca-managed Git worktree and branch in this session's repository, so workers can run there instead of in the user's checkout. Runs `orca worktree create --setup skip --no-parent`: no install or setup hooks, no remote placement. Only worktrees created here can be named by orca_worker_start's `worktree` option. A name is single-use per session. If the result is unconfirmed, inspect with `orca worktree list` instead of resending. The new checkout has no node_modules or .env files.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        branch: { type: "string" },
        baseBranch: { type: "string" },
      },
      required: ["name", "branch"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (access.ready) await access.ready(ctx, signal);
      } catch {
        return result(
          "Orca setup is unavailable or this call was cancelled. No worktree was created.",
          {},
          true,
        );
      }
      const value = access.get();
      if (!value || value.sessionId !== ctx.sessionManager.getSessionId())
        return result(
          "Attach this conversation to its owned local run before creating a worktree.",
          {},
          true,
        );
      if (!ctx.sessionManager.getSessionFile())
        return result(
          "Worktree creation requires a persistent Pi session for its journal.",
          {},
          true,
        );
      let input;
      try {
        input = parseWorktreeInput(params);
      } catch (error) {
        return result(
          `${error instanceof Error ? error.message : "Invalid input."} No worktree was created.`,
          {},
          true,
        );
      }
      if (inFlight)
        return result(
          "A worktree creation is already in progress. Do not resend.",
          {},
          true,
        );
      if (journaledNames(ctx.sessionManager.getEntries()).has(input.name))
        return result(
          "That worktree name was already used in this session. Pick another name; do not resend.",
          {},
          true,
        );
      if (signal?.aborted)
        return result("Cancelled before creation.", {}, true);
      inFlight = true;
      let recorded = false;
      try {
        pi.appendEntry(worktreeEntryType, {
          version: 1,
          name: input.name,
          input,
          status: "pending",
        });
        recorded = true;
        const outcome = await creator.create(value.target, input, ctx.cwd);
        if (
          !access.active() ||
          value.ctx.sessionManager.getSessionId() !== value.sessionId
        )
          return result(
            `The extension session changed after the request. Worktree ${input.name} may exist; inspect with orca worktree list.`,
            {},
            true,
          );
        pi.appendEntry(worktreeEntryType, {
          version: 1,
          name: input.name,
          input,
          status: outcome.status,
          ...(outcome.record ? { record: outcome.record } : {}),
        });
        if (outcome.status !== "ready" || !outcome.record)
          return result(
            `Worktree ${input.name} is unconfirmed (${outcome.errorCode ?? "unknown"}). It may exist; inspect with orca worktree list. Do not resend.`,
            outcome,
            true,
          );
        return result(
          [
            `Worktree ready: ${JSON.stringify(outcome.record)}`,
            `Start workers there with orca_worker_start and worktree="${outcome.record.name}".`,
            "It has no installed dependencies or env files; install them once, yourself, before workers that need them.",
          ].join("\n"),
          outcome,
        );
      } catch {
        return result(
          recorded
            ? `Worktree ${input.name} may have been created. Inspect with orca worktree list. Do not resend.`
            : "Worktree preflight failed. No creation request was issued. Check the caller identity and local workspace.",
          {},
          true,
        );
      } finally {
        inFlight = false;
      }
    },
  });
}
