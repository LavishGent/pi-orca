import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MailboxJournal,
  makeOwner,
  deliveryMarker,
  hasDeliveryReceipt,
} from "../src/mailbox-state.ts";

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-state-"));
  try {
    const cwd = join(dir, "work");
    await mkdir(cwd);
    const root = join(dir, "state");
    const owner = await makeOwner(
      "session_one",
      join(dir, "missing", "session.jsonl"),
      cwd,
    );
    await fn({ dir, cwd, root, owner });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const initial = (owner) => ({
  version: 1,
  owner,
  phase: "empty",
  paused: false,
});
const ready = (owner) => ({
  ...initial(owner),
  phase: "ready",
  nonce: "fixture",
  worktreeId: `repo::${owner.cwd}`,
  terminal: "term_one",
  incarnation: "inc_one",
  target: { run: "run_one", terminal: "term_one" },
});

test("owner identity is stable before first flush and across path aliases", () =>
  fixture(async ({ dir, cwd, owner }) => {
    await mkdir(join(dir, "missing"));
    await writeFile(owner.file, "header");
    assert.deepEqual(await makeOwner(owner.sessionId, owner.file, cwd), owner);
    await symlink(dir, join(dir, "alias"));
    assert.deepEqual(
      await makeOwner(
        owner.sessionId,
        join(dir, "alias", "missing", "session.jsonl"),
        cwd,
      ),
      owner,
    );
    assert.notEqual(
      (await makeOwner("session_two", owner.file, cwd)).key,
      owner.key,
    );
    assert.notEqual(
      (await makeOwner(owner.sessionId, join(dir, "copy.jsonl"), cwd)).key,
      owner.key,
    );
  }));

test("exclusive owner lock prevents another process instance until clean close", () =>
  fixture(async ({ root, owner }) => {
    const first = MailboxJournal.open(root, owner);
    assert.throws(() => MailboxJournal.open(root, owner), /lock/i);
    first.write(initial(owner));
    first.close();
    first.close();
    const next = MailboxJournal.open(root, owner);
    assert.equal(next.state.phase, "empty");
    next.close();
  }));

test("terminal and Run claims reject different sessions and copied files", () =>
  fixture(async ({ root, owner, dir, cwd }) => {
    const a = MailboxJournal.open(root, owner);
    a.claim("terminal", "term_one");
    a.claim("run", "run_one");
    a.close();
    for (const other of [
      await makeOwner("session_two", owner.file, cwd),
      await makeOwner(owner.sessionId, join(dir, "copy.jsonl"), cwd),
    ]) {
      const b = MailboxJournal.open(root, other);
      assert.throws(
        () => b.claim("terminal", "term_one"),
        /another.*session|owner/i,
      );
      assert.throws(() => b.claim("run", "run_one"), /another.*session|owner/i);
      b.close();
    }
    const resumed = MailboxJournal.open(root, owner);
    resumed.claim("terminal", "term_one", false);
    resumed.claim("run", "run_one", false);
    resumed.close();
  }));

test("journal sync is visible before returning and unknown tails fail closed", () =>
  fixture(async ({ root, owner }) => {
    const j = MailboxJournal.open(root, owner);
    j.write(initial(owner));
    assert.equal(
      JSON.parse((await readFile(j.path, "utf8")).trim()).phase,
      "empty",
    );
    const path = j.path;
    j.close();
    await writeFile(path, '{"version":99}\n', { mode: 0o600 });
    assert.throws(() => MailboxJournal.open(root, owner), /journal|version/i);
    await writeFile(path, JSON.stringify(initial(owner)) + "\n{", {
      mode: 0o600,
    });
    assert.throws(() => MailboxJournal.open(root, owner), /journal|truncat/i);
  }));

test("unsafe modes, symlinks and cwd rebinding are refused", () =>
  fixture(async ({ root, owner, dir, cwd }) => {
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    assert.throws(
      () => MailboxJournal.open(root, owner),
      /private|permission/i,
    );
    await chmod(root, 0o700);
    const j = MailboxJournal.open(root, owner);
    j.write(initial(owner));
    const path = j.path;
    j.close();
    await chmod(path, 0o644);
    assert.throws(
      () => MailboxJournal.open(root, owner),
      /private|permission/i,
    );
    await chmod(path, 0o600);
    const changed = { ...owner, cwd: dir };
    assert.throws(() => MailboxJournal.open(root, changed), /owner|cwd/i);
    await rm(path);
    await symlink(join(cwd, "other"), path);
    assert.throws(
      () => MailboxJournal.open(root, owner),
      /journal|regular|symbolic/i,
    );
  }));

test("read barriers and retained receipts survive restart; stable checkpoint removes payload", () =>
  fixture(async ({ root, owner }) => {
    const j = MailboxJournal.open(root, owner);
    j.write(ready(owner));
    j.write({ ...j.state, phase: "reading" });
    assert.throws(
      () => j.checkpoint({ ...ready(owner), phase: "empty" }),
      /ready|checkpoint/i,
    );
    const result = {
      runId: "run_one",
      messages: [
        {
          id: "msg_one",
          type: "worker_done",
          run_id: "run_one",
          to_handle: "run:run_one",
          body: "private batch",
        },
      ],
    };
    const delivery = { id: "receipt_one", result };
    j.write({ ...j.state, phase: "delivering", delivery });
    const path = j.path;
    j.close();
    const restored = MailboxJournal.open(root, owner);
    assert.deepEqual(restored.state.delivery, delivery);
    assert.equal(hasDeliveryReceipt([], restored.state), false);
    await mkdir(join(owner.file, ".."), { recursive: true }).catch(() => {});
    await writeFile(owner.file, "session exists");
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "orca_inbox",
          content: [
            { type: "text", text: deliveryMarker(delivery.id) + "\ndata" },
          ],
        },
      },
    ];
    assert.equal(hasDeliveryReceipt(entries, restored.state), true);
    restored.checkpoint(ready(owner));
    assert.ok(!(await readFile(path, "utf8")).includes("private batch"));
    restored.close();
  }));

test("another Node process cannot acquire an active owner's lock", () =>
  fixture(async ({ root, owner }) => {
    const { spawnSync } = await import("node:child_process");
    const j = MailboxJournal.open(root, owner);
    try {
      const module = new URL("../src/mailbox-state.ts", import.meta.url).href;
      const script = `import {MailboxJournal} from ${JSON.stringify(module)}; try {MailboxJournal.open(${JSON.stringify(root)},${JSON.stringify(owner)});process.exitCode=2;} catch(error) {if(!error.message.includes('lock'))process.exitCode=3;}`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      j.close();
    }
  }));

test("oversized and excessive-record journals fail closed without truncation", () =>
  fixture(async ({ root, owner }) => {
    const j = MailboxJournal.open(root, owner);
    j.write(initial(owner));
    const path = j.path;
    j.close();
    await writeFile(path, " ".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => MailboxJournal.open(root, owner), /limit/i);
    const content = (JSON.stringify(initial(owner)) + "\n").repeat(4097);
    await writeFile(path, content, { mode: 0o600 });
    assert.throws(() => MailboxJournal.open(root, owner), /record limit/i);
    assert.equal((await readFile(path, "utf8")).length, content.length);
  }));

test("stable checkpointing bounds repeated report retention but refuses pending setup", () =>
  fixture(async ({ root, owner }) => {
    const j = MailboxJournal.open(root, owner);
    j.write(ready(owner));
    for (let i = 0; i < 16; i++) {
      j.checkpoint(ready(owner));
      j.write({ ...j.state, phase: "reading" });
      const result = {
        runId: "run_one",
        messages: [
          {
            id: `msg_${i}`,
            type: "worker_done",
            run_id: "run_one",
            to_handle: "run:run_one",
            body: "x".repeat(65536),
          },
        ],
      };
      j.write({
        ...j.state,
        phase: "delivering",
        delivery: { id: `receipt_${i}`, result },
      });
      j.checkpoint(ready(owner));
    }
    assert.ok((await readFile(j.path, "utf8")).length < 4096);
    j.close();
    const other = await makeOwner("session_pending", owner.file, owner.cwd);
    const pending = MailboxJournal.open(root, other);
    pending.write({
      ...initial(other),
      phase: "terminal-pending",
      nonce: "pending",
      worktreeId: `repo::${owner.cwd}`,
    });
    assert.throws(() => pending.checkpoint(ready(other)), /checkpoint|ready/i);
    pending.close();
  }));

test("record limits and post-close writes fail without clearing prior state", () =>
  fixture(async ({ root, owner }) => {
    const j = MailboxJournal.open(root, owner);
    j.write(initial(owner));
    assert.throws(
      () => j.write({ ...initial(owner), phase: "invalid" }),
      /journal|state/i,
    );
    assert.throws(
      () => j.write({ ...initial(owner), nonce: "x".repeat(3 * 1024 * 1024) }),
      /limit|journal|state/i,
    );
    assert.equal(j.state.phase, "empty");
    j.close();
    assert.throws(() => j.write(initial(owner)), /closed|lease/i);
  }));
