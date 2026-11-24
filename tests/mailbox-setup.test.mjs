import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxSetup, ownLaunchEntries } from "../src/mailbox-setup.ts";
import { MailboxJournal, makeOwner } from "../src/mailbox-state.ts";

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-setup-"));
  try {
    const cwd = join(dir, "work");
    await mkdir(cwd);
    const root = join(dir, "state");
    const input = {
      sessionId: "session_one",
      file: join(dir, "session.jsonl"),
      cwd,
      entries: [],
    };
    const calls = [];
    let mutations = 0;
    const target = { run: "run_one", terminal: "term_one" };
    const read = async (args) => {
      calls.push(args);
      const op = args.slice(0, 2).join(" ");
      if (op === "worktree show")
        return {
          worktree: {
            id: `repo::${cwd}`,
            path: cwd,
            identity: { executionHostId: "local" },
          },
        };
      if (op === "terminal show")
        return {
          terminal: {
            handle: "term_one",
            connected: true,
            executionHostId: "local",
            worktreeId: `repo::${cwd}`,
            worktreePath: cwd,
            incarnationId: "inc_one",
          },
        };
      if (op === "orchestration run-show" || op === "orchestration run-current")
        return { run: { id: "run_one", coordinator_handle: "term_one" } };
      throw new Error("unexpected read");
    };
    const mutate = async (args) => {
      mutations++;
      const owner = await makeOwner(input.sessionId, input.file, cwd);
      const path = join(root, owner.key + ".jsonl");
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      const state = JSON.parse(lines.at(-1));
      assert.equal(
        state.phase,
        args[0] === "terminal" ? "terminal-pending" : "run-pending",
      );
      assert.ok(args.includes("local"));
      assert.ok(!args.includes("--focus"));
      assert.ok(!args.includes("--command"));
      return {
        code: 0,
        envelope: {
          ok: true,
          result:
            args[0] === "terminal"
              ? { terminal: { handle: "term_one" } }
              : { run: { id: "run_one", coordinator_handle: "term_one" } },
        },
      };
    };
    const service = new MailboxSetup({
      env: { PI_ORCA_STATE_DIR: root },
      read,
      mutate,
    });
    await fn({
      dir,
      cwd,
      root,
      input,
      calls,
      read,
      mutate,
      service,
      target,
      count: () => mutations,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("setup journals before effects, claims both identities and restores without creation", () =>
  fixture(async ({ service, input, count, target }) => {
    const a = await service.open(input);
    assert.deepEqual(a.target, target);
    assert.equal(count(), 2);
    a.close();
    const b = await service.open(input);
    assert.deepEqual(b.target, target);
    assert.equal(count(), 2);
    b.close();
  }));
test("uncertain terminal creation is never resubmitted", () =>
  fixture(async ({ root, input, read }) => {
    let count = 0;
    const s = new MailboxSetup({
      env: { PI_ORCA_STATE_DIR: root },
      read,
      mutate: async () => {
        count++;
        return { code: null, problem: "deadline" };
      },
    });
    await assert.rejects(s.open(input), /uncertain|pending/i);
    await assert.rejects(s.open(input), /uncertain|pending/i);
    assert.equal(count, 1);
  }));
test("a separate owner cannot explicitly adopt a claimed mailbox", () =>
  fixture(async ({ service, input, target }) => {
    const a = await service.open(input);
    a.close();
    await assert.rejects(
      service.open({ ...input, sessionId: "session_two" }, undefined, {
        adopt: target,
      }),
      /another.*session|owner/i,
    );
  }));
test("target changes and remote caller environments are rejected", () =>
  fixture(async ({ service, input, root, read, mutate }) => {
    const a = await service.open(input);
    a.close();
    await assert.rejects(
      service.open(input, undefined, {
        adopt: { run: "run_other", terminal: "term_one" },
      }),
      /target|replace/i,
    );
    const s = new MailboxSetup({
      env: { PI_ORCA_STATE_DIR: root, ORCA_ENVIRONMENT: "remote" },
      read,
      mutate,
    });
    await assert.rejects(s.open(input), /local|identity/i);
  }));
test("pause and uncertain reads persist; delivery replay does not consume twice", () =>
  fixture(async ({ service, input }) => {
    const a = await service.open(input);
    a.beginRead();
    a.close();
    await assert.rejects(service.open(input), /read|history/i);
    const b = await service.open(input, undefined, {
      adopt: { run: "run_one", terminal: "term_one" },
    });
    b.beginRead();
    const result = {
      runId: "run_one",
      messages: [
        {
          id: "msg_one",
          type: "worker_done",
          run_id: "run_one",
          to_handle: "run:run_one",
        },
      ],
    };
    b.saveDelivery(result);
    const id = b.delivery.id;
    b.close();
    const c = await service.open(input);
    assert.equal(c.delivery.id, id);
    assert.deepEqual(c.delivery.result, result);
    c.pause();
    c.close();
    await assert.rejects(service.open(input), /paused/i);
    const d = await service.open(input, undefined, { unpause: true });
    assert.equal(d.delivery.id, id);
    d.close();
  }));
test("structural fork classification works for startup/resume and keeps own child launches", () =>
  fixture(async ({ dir, input }) => {
    const parent = join(dir, "parent.jsonl");
    const inherited = {
      type: "custom",
      id: "entry_one",
      customType: "orca-launch-journal",
      data: { opaque: "same" },
    };
    const own = { ...inherited, id: "entry_two", data: { opaque: "child" } };
    await writeFile(
      parent,
      JSON.stringify({ type: "session", id: "parent_id", cwd: input.cwd }) +
        "\n" +
        JSON.stringify(inherited) +
        "\n",
    );
    assert.deepEqual(
      await ownLaunchEntries({
        ...input,
        parentSession: parent,
        entries: [inherited, own],
      }),
      [own],
    );
    await rm(parent);
    await assert.rejects(
      ownLaunchEntries({
        ...input,
        parentSession: parent,
        entries: [inherited],
      }),
      /parent|fork/i,
    );
  }));
test(
  "the long-poll reader outlives the short metadata timeout",
  { timeout: 10000 },
  () =>
    fixture(async ({ dir, root }) => {
      const binary = join(dir, "fixture-cli");
      await writeFile(
        binary,
        `#!${process.execPath}\nsetTimeout(()=>console.log(JSON.stringify({ok:true,result:{runId:'run_one',messages:[]}})),5250);\n`,
        { mode: 0o700 },
      );
      await chmod(binary, 0o700);
      const service = new MailboxSetup({
        env: { PI_ORCA_STATE_DIR: root, ORCA_CLI_COMMAND: binary },
      });
      assert.deepEqual(
        await service.client.peek({ run: "run_one", terminal: "term_one" }),
        [],
      );
    }),
);

test(
  "foreground verification and check keep the normal inbox deadline",
  { timeout: 10000 },
  () =>
    fixture(async ({ dir, root }) => {
      const binary = join(dir, "slow-reader");
      await writeFile(
        binary,
        `#!${process.execPath}\nif(process.argv.includes('run-show'))setTimeout(()=>console.log(JSON.stringify({ok:true,result:{run:{id:'run_one',coordinator_handle:'term_one'}}})),5250);else console.log(JSON.stringify({ok:true,result:{runId:'run_one',messages:[],deliveryAcknowledged:true}}));\n`,
        { mode: 0o700 },
      );
      await chmod(binary, 0o700);
      const service = new MailboxSetup({
        env: { PI_ORCA_STATE_DIR: root, ORCA_CLI_COMMAND: binary },
      });
      assert.deepEqual(
        await service.client.read({ run: "run_one", terminal: "term_one" }),
        { runId: "run_one", messages: [] },
      );
    }),
);

test("a known incarnation mismatch is not silently rebound", () =>
  fixture(async ({ service, input, root, read, mutate }) => {
    const a = await service.open(input);
    a.close();
    const badRead = async (args) => {
      const r = await read(args);
      if (r.terminal) r.terminal.incarnationId = "changed";
      return r;
    };
    const s = new MailboxSetup({
      env: { PI_ORCA_STATE_DIR: root },
      read: badRead,
      mutate,
    });
    await assert.rejects(s.open(input), /incarnation|identity/i);
  }));
