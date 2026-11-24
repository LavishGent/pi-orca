import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  unlinkSync,
  renameSync,
  existsSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ReadResult, Target } from "./orca.ts";
import { validateTarget } from "./orca.ts";

export interface MailboxOwner {
  sessionId: string;
  file: string;
  cwd: string;
  key: string;
}
export type SetupPhase =
  | "empty"
  | "terminal-pending"
  | "terminal"
  | "run-pending"
  | "bound"
  | "ready"
  | "reading"
  | "delivering";
export interface Delivery {
  id: string;
  result: ReadResult;
}
export interface MailboxState {
  version: 1;
  owner: MailboxOwner;
  phase: SetupPhase;
  paused: boolean;
  nonce?: string;
  worktreeId?: string;
  terminal?: string;
  incarnation?: string;
  target?: Target;
  delivery?: Delivery;
}
export function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
const small = (x: unknown, max = 4096): x is string =>
  typeof x === "string" &&
  x.length > 0 &&
  Buffer.byteLength(x) <= max &&
  !/[\u0000-\u001f\u007f]/u.test(x);

export async function canonicalFuture(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try {
      return join(await realpath(current), ...suffix);
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current)
        throw new Error("Cannot resolve session filename.");
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  throw new Error("Session path exceeds supported depth.");
}
export async function makeOwner(
  sessionId: string,
  file: string,
  cwd: string,
): Promise<MailboxOwner> {
  if (
    !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) ||
    !isAbsolute(file) ||
    !isAbsolute(cwd)
  )
    throw new Error("A persistent absolute session identity is required.");
  const canonicalFile = await canonicalFuture(file);
  const canonicalCwd = await realpath(cwd);
  return {
    sessionId,
    file: canonicalFile,
    cwd: canonicalCwd,
    key: hash(sessionId + "\0" + canonicalFile),
  };
}
const maxJournal = 4 * 1024 * 1024;
const maxRecord = 1200 * 1024;
function validState(
  value: unknown,
  owner: MailboxOwner,
): value is MailboxState {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.owner) ||
    JSON.stringify(value.owner) !== JSON.stringify(owner) ||
    typeof value.paused !== "boolean"
  )
    return false;
  if (
    Object.keys(value).some(
      (k) =>
        ![
          "version",
          "owner",
          "phase",
          "paused",
          "nonce",
          "worktreeId",
          "terminal",
          "incarnation",
          "target",
          "delivery",
        ].includes(k),
    )
  )
    return false;
  if (
    ![
      "empty",
      "terminal-pending",
      "terminal",
      "run-pending",
      "bound",
      "ready",
      "reading",
      "delivering",
    ].includes(String(value.phase))
  )
    return false;
  if (value.nonce !== undefined && !small(value.nonce, 160)) return false;
  if (
    value.phase !== "empty" &&
    (!small(value.worktreeId) || !small(value.nonce, 160))
  )
    return false;
  if (
    [
      "terminal",
      "run-pending",
      "bound",
      "ready",
      "reading",
      "delivering",
    ].includes(String(value.phase)) &&
    (typeof value.terminal !== "string" ||
      !/^term_[A-Za-z0-9_-]{1,160}$/.test(value.terminal))
  )
    return false;
  if (
    ["run-pending", "bound", "ready", "reading", "delivering"].includes(
      String(value.phase),
    ) &&
    !small(value.incarnation, 256)
  )
    return false;
  if (
    ["bound", "ready", "reading", "delivering"].includes(String(value.phase))
  ) {
    try {
      validateTarget(value.target);
    } catch {
      return false;
    }
    if (value.target.terminal !== value.terminal) return false;
  } else if (value.target !== undefined) return false;
  if (value.phase === "delivering") {
    const d = value.delivery;
    if (
      !record(d) ||
      !small(d.id, 160) ||
      !record(d.result) ||
      !record(value.target) ||
      d.result.runId !== value.target.run ||
      !Array.isArray(d.result.messages) ||
      d.result.messages.length > 2048 ||
      Buffer.byteLength(JSON.stringify(d.result)) > 1048576
    )
      return false;
    const target = value.target;
    if (
      d.result.messages.some(
        (m) =>
          !record(m) ||
          !small(m.id, 256) ||
          !small(m.type, 128) ||
          m.run_id !== target.run ||
          (m.to_handle !== target.terminal &&
            m.to_handle !== `run:${target.run}`),
      )
    )
      return false;
  } else if (value.delivery !== undefined) return false;
  return true;
}
function checkFile(stat: Stats, directory = false): void {
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    (!directory && stat.nlink !== 1)
  )
    throw new Error(
      "Mailbox storage must use regular private files, not symbolic links.",
    );
  if (
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(
      "Mailbox storage ownership or private permissions are unsafe.",
    );
}
function readPrivate(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    checkFile(s);
    if (s.size > max)
      throw new Error("Mailbox journal exceeds its size limit.");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > max)
      throw new Error("Mailbox journal exceeds its size limit.");
    return text;
  } finally {
    closeSync(fd);
  }
}
function writeNew(path: string, text: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class MailboxJournal {
  readonly path: string;
  readonly lockPath: string;
  readonly owner: MailboxOwner;
  private readonly root: string;
  private readonly fd: number;
  private readonly nonce: string;
  private closed = false;
  private bytes = 0;
  private count = 0;
  state: MailboxState | undefined;
  private constructor(
    root: string,
    owner: MailboxOwner,
    fd: number,
    nonce: string,
  ) {
    this.root = root;
    this.owner = owner;
    this.fd = fd;
    this.nonce = nonce;
    this.path = join(root, owner.key + ".jsonl");
    this.lockPath = join(root, owner.key + ".lock");
  }
  static open(root: string, owner: MailboxOwner): MailboxJournal {
    if (!isAbsolute(root))
      throw new Error("PI_ORCA_STATE_DIR must be absolute.");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    checkFile(lstatSync(root), true);
    const lock = join(root, owner.key + ".lock");
    let fd: number;
    try {
      fd = openSync(
        lock,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new Error(
        `Mailbox session lock is retained: ${lock}. Verify the old consumer has stopped and inspect its journal before operator recovery. Nothing was reclaimed.`,
      );
    }
    const nonce = randomUUID();
    const j = new MailboxJournal(root, owner, fd, nonce);
    try {
      writeFileSync(
        fd,
        JSON.stringify({ version: 1, nonce, pid: process.pid }) + "\n",
      );
      fsyncSync(fd);
      let text: string;
      try {
        text = readPrivate(j.path, maxJournal);
      } catch (error) {
        if (record(error) && error.code === "ENOENT") return j;
        throw error;
      }
      if (!text.endsWith("\n")) throw new Error("Truncated mailbox journal.");
      for (const line of text.trimEnd().split("\n")) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error("Malformed mailbox journal.");
        }
        if (!validState(value, owner))
          throw new Error(
            "Unsupported mailbox journal version, owner/cwd or state.",
          );
        j.state = value;
        j.count++;
      }
      if (j.count > 4096)
        throw new Error("Mailbox journal exceeds its record limit.");
      j.bytes = Buffer.byteLength(text);
      return j;
    } catch (error) {
      j.close();
      throw error;
    }
  }
  write(next: MailboxState): void {
    this.assertOpen();
    const text = JSON.stringify(next) + "\n";
    if (!validState(next, this.owner) || Buffer.byteLength(text) > maxRecord)
      throw new Error("Invalid mailbox journal state or record limit.");
    const prior = this.state;
    if (prior) {
      if (
        prior.target &&
        JSON.stringify(prior.target) !== JSON.stringify(next.target)
      )
        throw new Error("Mailbox target cannot be replaced.");
      if (prior.terminal && prior.terminal !== next.terminal)
        throw new Error("Mailbox terminal cannot be replaced.");
      if (prior.incarnation && prior.incarnation !== next.incarnation)
        throw new Error("Mailbox incarnation cannot be replaced.");
      const allowed: Record<SetupPhase, SetupPhase[]> = {
        empty: ["empty", "terminal-pending", "ready"],
        "terminal-pending": ["terminal-pending", "terminal"],
        terminal: ["terminal", "run-pending", "ready"],
        "run-pending": ["run-pending", "bound"],
        bound: ["bound", "ready"],
        ready: ["ready", "reading"],
        reading: ["reading", "delivering", "ready"],
        delivering: ["delivering", "ready"],
      };
      if (!allowed[prior.phase].includes(next.phase))
        throw new Error("Invalid mailbox journal transition.");
    }
    if (this.bytes + Buffer.byteLength(text) > maxJournal || this.count >= 4096)
      throw new Error(
        "Mailbox journal exceeds its limit; uncertainty was preserved.",
      );
    const fd = openSync(
      this.path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      checkFile(fstatSync(fd));
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.bytes += Buffer.byteLength(text);
    this.count++;
    this.state = JSON.parse(text) as MailboxState;
  }
  checkpoint(next: MailboxState): void {
    this.assertOpen();
    if (
      next.phase !== "ready" ||
      !this.state ||
      !["ready", "delivering", "reading"].includes(this.state.phase) ||
      !validState(next, this.owner) ||
      JSON.stringify(next.target) !== JSON.stringify(this.state.target) ||
      next.incarnation !== this.state.incarnation
    )
      throw new Error(
        "Only the verified same-target ready state can be checkpointed.",
      );
    const text = JSON.stringify(next) + "\n";
    const temp = this.path + "." + randomUUID() + ".tmp";
    try {
      writeNew(temp, text);
      renameSync(temp, this.path);
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
    this.state = JSON.parse(text) as MailboxState;
    this.bytes = Buffer.byteLength(text);
    this.count = 1;
  }
  claim(kind: "terminal" | "run", id: string, create = true): void {
    this.assertOpen();
    if (
      !(
        kind === "terminal"
          ? /^term_[A-Za-z0-9_-]{1,160}$/
          : /^run_[A-Za-z0-9_-]{1,160}$/
      ).test(id)
    )
      throw new Error("Invalid mailbox claim identity.");
    const path = join(this.root, kind + "-" + hash(id) + ".claim");
    const wanted = { version: 1, ownerKey: this.owner.key, kind, id };
    try {
      if (create) {
        try {
          writeNew(path, JSON.stringify(wanted) + "\n");
          return;
        } catch (error) {
          if (!record(error) || error.code !== "EEXIST") throw error;
        }
      }
      const actual: unknown = JSON.parse(readPrivate(path, 4096));
      if (JSON.stringify(actual) !== JSON.stringify(wanted))
        throw new Error("This mailbox is claimed by another Pi session owner.");
    } catch (error) {
      if (record(error) && error.code === "ENOENT")
        throw new Error(
          "The permanent mailbox ownership claim is missing. Inspect storage before recovery.",
        );
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const before = fstatSync(this.fd);
      const current = lstatSync(this.lockPath);
      if (
        before.ino === current.ino &&
        before.dev === current.dev &&
        JSON.parse(readPrivate(this.lockPath, 4096)).nonce === this.nonce
      )
        unlinkSync(this.lockPath);
    } finally {
      closeSync(this.fd);
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Mailbox journal lease is closed.");
  }
}
export function deliveryMarker(id: string): string {
  return `Orca delivery receipt: ${id}`;
}
export function hasDeliveryReceipt(
  entries: readonly unknown[],
  state: MailboxState,
): boolean {
  if (!state.delivery || !existsSync(state.owner.file)) return false;
  const marker = deliveryMarker(state.delivery.id) + "\n";
  return entries.some(
    (e) =>
      record(e) &&
      e.type === "message" &&
      record(e.message) &&
      e.message.role === "toolResult" &&
      e.message.toolName === "orca_inbox" &&
      Array.isArray(e.message.content) &&
      e.message.content.some(
        (c) =>
          record(c) &&
          c.type === "text" &&
          typeof c.text === "string" &&
          c.text.startsWith(marker),
      ),
  );
}
