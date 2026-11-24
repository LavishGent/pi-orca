import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { OrcaClient, executable, runJson, validateTarget } from "./orca.ts";
import type { Runner, Target, ReadResult } from "./orca.ts";
import {
  assertLocalCaller,
  localEnvironment,
  runMutation,
} from "./launch-process.ts";
import type { MutationResult } from "./launch-process.ts";
import { launchEntryType, readLaunchJournal } from "./launch-journal.ts";
import {
  MailboxJournal,
  makeOwner,
  record,
  hasDeliveryReceipt,
} from "./mailbox-state.ts";
import type { MailboxOwner, MailboxState, Delivery } from "./mailbox-state.ts";

export interface MailboxInput {
  sessionId: string;
  file: string;
  cwd: string;
  entries: readonly SessionEntry[];
  parentSession?: string;
}
interface OpenOptions {
  adopt?: Target;
  unpause?: boolean;
}
const sameTarget = (a: Target, b: Target) =>
  a.run === b.run && a.terminal === b.terminal;
const bounded = (x: unknown, max = 4096): x is string =>
  typeof x === "string" &&
  x.length > 0 &&
  Buffer.byteLength(x) <= max &&
  !/[\u0000-\u001f\u007f]/u.test(x);

// Fork APIs preserve custom-entry IDs/data, but not a single event reason.
export async function ownLaunchEntries(
  input: MailboxInput,
): Promise<readonly SessionEntry[]> {
  const entries = input.entries.filter(
    (e) => e.type === "custom" && e.customType === launchEntryType,
  );
  if (!input.parentSession || entries.length === 0) return entries;
  try {
    if (
      !isAbsolute(input.parentSession) ||
      !input.parentSession.endsWith(".jsonl")
    )
      throw new Error();
    const path = await realpath(input.parentSession);
    if (path === (await makeOwner(input.sessionId, input.file, input.cwd)).file)
      throw new Error();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const s = fstatSync(fd);
      const limit = 32 * 1024 * 1024;
      if (
        !s.isFile() ||
        (process.getuid && s.uid !== process.getuid()) ||
        s.size > limit
      )
        throw new Error();
      const buffer = Buffer.alloc(s.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (n === 0) break;
        bytes += n;
      }
      if (bytes > limit || bytes > s.size) throw new Error();
      text = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = text.trimEnd().split("\n");
    const header: unknown = JSON.parse(lines.shift() ?? "");
    if (
      !record(header) ||
      header.type !== "session" ||
      !bounded(header.id, 160) ||
      header.id === input.sessionId
    )
      throw new Error();
    const parent = new Map<string, string>();
    for (const line of lines) {
      const e: unknown = JSON.parse(line);
      if (
        record(e) &&
        e.type === "custom" &&
        e.customType === launchEntryType &&
        typeof e.id === "string"
      )
        parent.set(
          e.id,
          createHash("sha256").update(JSON.stringify(e.data)).digest("hex"),
        );
    }
    return entries.filter(
      (e) =>
        e.type !== "custom" ||
        parent.get(e.id) !==
          createHash("sha256").update(JSON.stringify(e.data)).digest("hex"),
    );
  } catch {
    throw new Error(
      "Fork parent history could not be verified within its limits. No mailbox was provisioned.",
    );
  }
}

export class MailboxConnection {
  private readonly journal: MailboxJournal;
  constructor(journal: MailboxJournal) {
    this.journal = journal;
  }
  get target(): Target {
    const target = this.journal.state?.target;
    if (!target) throw new Error("Mailbox has no verified target.");
    return { ...target };
  }
  get delivery(): Delivery | undefined {
    return this.journal.state?.delivery;
  }
  get state(): MailboxState {
    const state = this.journal.state;
    if (!state) throw new Error("Mailbox state missing.");
    return state;
  }
  beginRead(): void {
    if (this.state.phase !== "ready")
      throw new Error("Mailbox is not ready for another consuming read.");
    this.journal.checkpoint(this.state);
    this.journal.write({ ...this.state, phase: "reading" });
  }
  saveDelivery(result: ReadResult): Delivery {
    const delivery = { id: randomUUID(), result };
    this.journal.write({ ...this.state, phase: "delivering", delivery });
    return delivery;
  }
  acknowledge(entries: readonly unknown[]): boolean {
    if (!hasDeliveryReceipt(entries, this.state)) return false;
    const { delivery: _delivery, ...state } = this.state;
    this.journal.checkpoint({ ...state, phase: "ready" });
    return true;
  }
  pause(): void {
    if (!this.state.paused) this.journal.write({ ...this.state, paused: true });
  }
  close(): void {
    this.journal.close();
  }
}

export class MailboxSetup {
  readonly client: OrcaClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly read: Runner;
  private readonly mutate: (args: string[]) => Promise<MutationResult>;
  private readonly root: string;
  constructor({
    env = process.env,
    read,
    mutate,
  }: {
    env?: NodeJS.ProcessEnv;
    read?: Runner;
    mutate?: (args: string[]) => Promise<MutationResult>;
  } = {}) {
    this.env = { ...env };
    const binary = executable(this.env);
    this.root =
      this.env.PI_ORCA_STATE_DIR ??
      join(homedir(), ".pi", "agent", "orca-mailboxes");
    this.read = (args, signal) =>
      (
        read ??
        ((a, s) =>
          runJson(binary, a, {
            signal: s,
            env: localEnvironment(this.env),
            timeoutMs:
              a[0] === "orchestration" &&
              (a[1] === "check" || a[1] === "run-show")
                ? 35000
                : 5000,
          }))
      )([...args, "--environment", "local"], signal);
    this.mutate =
      mutate ?? ((args) => runMutation(binary, args, "", { env: this.env }));
    this.client = new OrcaClient(this.read);
  }
  automatic(): boolean {
    const value = this.env.PI_ORCA_AUTO_ATTACH;
    if (value !== undefined && value !== "0" && value !== "1")
      throw new Error("PI_ORCA_AUTO_ATTACH must be 0 or 1.");
    return value !== "0";
  }
  async pause(input: MailboxInput): Promise<void> {
    const owner = await makeOwner(input.sessionId, input.file, input.cwd);
    const j = MailboxJournal.open(this.root, owner);
    try {
      j.write({
        ...(j.state ?? { version: 1, owner, phase: "empty", paused: false }),
        paused: true,
      });
    } finally {
      j.close();
    }
  }
  async open(
    input: MailboxInput,
    signal?: AbortSignal,
    options: OpenOptions = {},
  ): Promise<MailboxConnection> {
    assertLocalCaller(this.env);
    signal?.throwIfAborted();
    const owner = await makeOwner(input.sessionId, input.file, input.cwd);
    signal?.throwIfAborted();
    const j = MailboxJournal.open(this.root, owner);
    const save = (value: MailboxState) =>
      j.write({ ...value, paused: j.state?.paused ?? value.paused });
    try {
      let state = j.state;
      if (state?.paused && !options.unpause && !options.adopt)
        throw new Error(
          "Orca automatic attachment is paused. Use /orca-watch connect to resume.",
        );
      if (state && (options.unpause || options.adopt) && state.paused) {
        j.write({ ...state, paused: false });
        state = j.state;
      }
      if (state?.phase === "terminal-pending" || state?.phase === "run-pending")
        throw new Error(
          `Orca setup is pending or uncertain (${state.nonce}). Inspect ${j.path}; no creation was repeated.`,
        );
      if (state?.phase === "reading" && !options.adopt)
        throw new Error(
          `A prior consuming read is uncertain. Inspect retained inbox history for ${state.target?.run}, then explicitly attach the same target.`,
        );
      if (options.adopt) {
        validateTarget(options.adopt);
        if (state?.target && !sameTarget(state.target, options.adopt))
          throw new Error(
            "Changing the recorded mailbox target is not supported.",
          );
        if (state?.terminal && state.terminal !== options.adopt.terminal)
          throw new Error("Replacing the recorded terminal is not supported.");
      }
      if (!state || state.phase === "empty") {
        const legacy = [
          ...readLaunchJournal(await ownLaunchEntries(input)).values(),
        ];
        if (legacy.length) {
          const latest = legacy.at(-1);
          if (
            !options.adopt ||
            !latest ||
            !sameTarget(latest.plan.target, options.adopt) ||
            legacy.some(
              (r) =>
                r.status !== "ready" &&
                !sameTarget(r.plan.target, options.adopt as Target),
            )
          )
            throw new Error(
              "Legacy worker history requires explicit attachment to its latest owned target; resolve other uncertain launches first.",
            );
        }
        if (!state) {
          j.write({ version: 1, owner, phase: "empty", paused: false });
          state = j.state;
        }
      }
      signal?.throwIfAborted();
      const worktreeId = await this.workspace(owner, signal);
      signal?.throwIfAborted();
      if (state?.worktreeId && state.worktreeId !== worktreeId)
        throw new Error("Mailbox workspace identity changed.");
      if (options.adopt) {
        const incarnation = await this.terminal(
          owner,
          worktreeId,
          options.adopt.terminal,
          state?.incarnation,
          signal,
        );
        await this.verifyTarget(options.adopt, signal);
        signal?.throwIfAborted();
        const established = state?.target !== undefined;
        j.claim(
          "terminal",
          options.adopt.terminal,
          !established && state?.phase !== "bound",
        );
        j.claim(
          "run",
          options.adopt.run,
          !established || state?.phase === "bound",
        );
        const next: MailboxState = {
          version: 1,
          owner,
          phase: "ready",
          paused: false,
          nonce: state?.nonce ?? randomUUID(),
          worktreeId,
          terminal: options.adopt.terminal,
          incarnation,
          target: { ...options.adopt },
        };
        if (state?.phase === "delivering") j.write({ ...state, paused: false });
        else if (state?.phase === "reading") j.checkpoint(next);
        else save(next);
        return new MailboxConnection(j);
      }
      if (!state || state.phase === "empty") {
        const pending: MailboxState = {
          version: 1,
          owner,
          phase: "terminal-pending",
          paused: false,
          nonce: randomUUID(),
          worktreeId,
        };
        save(pending);
        signal?.throwIfAborted();
        const response = await this.mutate([
          "terminal",
          "create",
          "--worktree",
          `id:${worktreeId}`,
          "--title",
          `Pi mailbox ${pending.nonce}`,
          "--environment",
          "local",
          "--json",
        ]);
        const result = this.result(response);
        const terminal = record(result.terminal)
          ? result.terminal.handle
          : undefined;
        if (
          typeof terminal !== "string" ||
          !/^term_[A-Za-z0-9_-]{1,160}$/.test(terminal)
        )
          throw new Error(
            "Terminal creation is uncertain; its pending record was retained.",
          );
        save({ ...pending, phase: "terminal", terminal });
        state = j.state;
      }
      signal?.throwIfAborted();
      if (state?.phase === "terminal") {
        const terminal = state.terminal;
        if (!terminal) throw new Error("Missing terminal.");
        j.claim("terminal", terminal);
        const incarnation = await this.terminal(
          owner,
          worktreeId,
          terminal,
          state.incarnation,
          signal,
        );
        signal?.throwIfAborted();
        save({ ...state, incarnation });
        state = j.state;
        if (!state) throw new Error("Missing mailbox state.");
        save({ ...state, phase: "run-pending" });
        signal?.throwIfAborted();
        const response = await this.mutate([
          "orchestration",
          "run-create",
          "--from",
          terminal,
          "--objective",
          `Pi session mailbox ${state.nonce}`,
          "--environment",
          "local",
          "--full",
          "--json",
        ]);
        const result = this.result(response);
        const run = record(result.run) ? result.run : undefined;
        if (
          !run ||
          typeof run.id !== "string" ||
          run.coordinator_handle !== terminal
        )
          throw new Error(
            "Run creation is uncertain; pending state was retained.",
          );
        const target = { run: run.id, terminal };
        validateTarget(target);
        save({ ...state, phase: "bound", target });
        state = j.state;
      }
      signal?.throwIfAborted();
      if (!state?.target || !state.terminal)
        throw new Error("Mailbox has no restorable target.");
      j.claim("terminal", state.terminal, false);
      j.claim("run", state.target.run, state.phase === "bound");
      await this.terminal(
        owner,
        worktreeId,
        state.terminal,
        state.incarnation,
        signal,
      );
      await this.verifyTarget(state.target, signal);
      signal?.throwIfAborted();
      if (state.phase === "bound") save({ ...state, phase: "ready" });
      return new MailboxConnection(j);
    } catch (error) {
      j.close();
      throw error;
    }
  }
  private result(response: MutationResult): Record<string, unknown> {
    if (
      response.problem ||
      !record(response.envelope) ||
      response.envelope.ok !== true ||
      !record(response.envelope.result)
    )
      throw new Error(
        "Orca creation is uncertain; inspect the pending journal. Nothing was retried.",
      );
    return response.envelope.result;
  }
  private async workspace(
    owner: MailboxOwner,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.read(
      ["worktree", "show", "--worktree", `path:${owner.cwd}`, "--json"],
      signal,
    );
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
      (await realpath(w.path)) !== owner.cwd ||
      (await realpath(w.id.slice(w.id.indexOf("::") + 2))) !== owner.cwd
    )
      throw new Error(
        "Pi must run at an already registered local Git worktree root.",
      );
    return w.id;
  }
  private async terminal(
    owner: MailboxOwner,
    worktreeId: string,
    handle: string,
    expected: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.read(
      ["terminal", "show", "--terminal", handle, "--json"],
      signal,
    );
    const t =
      record(response) && record(response.terminal)
        ? response.terminal
        : undefined;
    if (
      !t ||
      t.handle !== handle ||
      t.executionHostId !== "local" ||
      t.connected !== true ||
      t.worktreeId !== worktreeId ||
      !bounded(t.worktreePath) ||
      (await realpath(t.worktreePath)) !== owner.cwd ||
      !bounded(t.incarnationId, 256) ||
      (expected !== undefined && t.incarnationId !== expected)
    )
      throw new Error(
        "Mailbox terminal identity, workspace or incarnation is no longer valid.",
      );
    return t.incarnationId;
  }
  private async verifyTarget(
    target: Target,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.verify(target, signal);
    const response = await this.read(
      [
        "orchestration",
        "run-current",
        "--from",
        target.terminal,
        "--full",
        "--json",
      ],
      signal,
    );
    if (
      !record(response) ||
      !record(response.run) ||
      response.run.id !== target.run ||
      response.run.coordinator_handle !== target.terminal
    )
      throw new Error("The terminal is no longer bound to its recorded Run.");
  }
}
