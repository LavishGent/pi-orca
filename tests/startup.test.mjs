import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../src/index.ts";
const tick = () => new Promise((r) => setImmediate(r));
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-startup-"));
  const file = join(dir, "session.jsonl");
  const handlers = new Map(),
    tools = new Map(),
    commands = new Map(),
    notices = [];
  let opens = 0,
    closed = 0;
  const entries = [];
  const peek = deferred();
  const target = { run: "run_one", terminal: "term_one" };
  const client = {
    verify: async () => {},
    peek: async () => peek.promise,
    read: async () => ({ runId: target.run, messages: [] }),
  };
  const conn = {
    target,
    delivery: undefined,
    close: () => closed++,
    acknowledge: () => false,
    pause: () => {},
    beginRead: () => {},
    saveDelivery: (result) => ({ id: "receipt_one", result }),
  };
  const service = {
    automatic: () => true,
    pause: async () => {},
    open: async () => {
      opens++;
      return conn;
    },
  };
  const ctx = {
    cwd: dir,
    sessionManager: {
      getSessionId: () => "session_one",
      getSessionFile: () => file,
      getEntries: () => entries,
      getHeader: () => ({ id: "session_one" }),
    },
    ui: { notify: (...x) => notices.push(x) },
  };
  const pi = {
    on: (name, f) => handlers.set(name, f),
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (name, c) => commands.set(name, c),
    sendMessage: () => {},
    appendEntry: () => {},
  };
  try {
    await fn({
      dir,
      file,
      handlers,
      tools,
      commands,
      ctx,
      pi,
      client,
      service,
      conn,
      entries,
      notices,
      opens: () => opens,
      closed: () => closed,
    });
  } finally {
    await handlers.get("session_shutdown")?.();
    peek.resolve([]);
    await rm(dir, { recursive: true, force: true });
  }
}
test("startup defers an unflushed session, then starts without delaying the first agent event", () =>
  fixture(async (s) => {
    const gate = deferred();
    s.service.open = async () => gate.promise;
    createExtension(s.client, {}, undefined, s.service)(s.pi);
    assert.ok(s.handlers.has("session_start"));
    await s.handlers.get("session_start")({ reason: "startup" }, s.ctx);
    assert.equal(s.closed(), 0);
    await s.handlers.get("agent_start")({}, s.ctx);
    await tick();
    assert.ok(
      s.notices.some(
        (x) => x[0].includes("first message") || x[0].includes("Connecting"),
      ),
    );
    gate.resolve(s.conn);
    await tick();
    await tick();
    assert.ok(
      s.notices.some(
        (x) => x[0].includes("Watching") || x[0].includes("connected"),
      ),
    );
  }));
test("a saved session reconnects automatically without an attach command", () =>
  fixture(async (s) => {
    await writeFile(s.file, "session");
    createExtension(s.client, {}, undefined, s.service)(s.pi);
    await s.handlers.get("session_start")({ reason: "resume" }, s.ctx);
    await tick();
    await tick();
    assert.equal(s.opens(), 1);
  }));
test("shutdown fences immediately but awaits an accepted setup before closing its lease", () =>
  fixture(async (s) => {
    await writeFile(s.file, "session");
    const gate = deferred();
    s.service.open = async () => gate.promise;
    createExtension(s.client, {}, undefined, s.service)(s.pi);
    await s.handlers.get("session_start")({ reason: "startup" }, s.ctx);
    await tick();
    let settled = false;
    const stopping = Promise.resolve(s.handlers.get("session_shutdown")()).then(
      () => (settled = true),
    );
    await tick();
    assert.equal(settled, false);
    gate.resolve(s.conn);
    await stopping;
    assert.equal(s.closed(), 1);
    assert.ok(!s.notices.some((x) => x[0].includes("Watching")));
  }));
test("restored delivery is reoffered without consuming again and waits for its tool receipt", () =>
  fixture(async (s) => {
    await writeFile(s.file, "session");
    let consumes = 0;
    s.client.read = async () => {
      consumes++;
      throw new Error("must not consume a retained batch");
    };
    const batch = {
      runId: "run_one",
      messages: [
        {
          id: "msg_saved",
          type: "worker_done",
          run_id: "run_one",
          to_handle: "run:run_one",
          body: "saved report",
        },
      ],
    };
    s.conn.delivery = { id: "receipt_saved", result: batch };
    s.conn.beginRead = () => {
      throw new Error("must not begin a second read");
    };
    s.conn.acknowledge = (entries) => {
      if (entries.some((e) => e.message?.toolName === "orca_inbox")) {
        s.conn.delivery = undefined;
        return true;
      }
      return false;
    };
    createExtension(s.client, {}, undefined, s.service)(s.pi);
    await s.handlers.get("session_start")({ reason: "resume" }, s.ctx);
    await tick();
    await tick();
    const result = await s.tools
      .get("orca_inbox")
      .execute("saved", {}, undefined, undefined, s.ctx);
    assert.equal(result.isError, undefined);
    assert.ok(
      result.content[0].text.startsWith(
        "Orca delivery receipt: receipt_saved\n",
      ),
    );
    assert.equal(consumes, 0);
    assert.ok(
      s.conn.delivery,
      "returning the result is not proof Pi persisted it",
    );
    s.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "orca_inbox",
        content: result.content,
      },
    });
    await s.handlers.get("context")({}, s.ctx);
    assert.equal(s.conn.delivery, undefined);
    assert.equal(consumes, 0);
  }));

test("tree navigation restarts setup after fencing and settling the earlier attempt", () =>
  fixture(async (s) => {
    await writeFile(s.file, "session");
    const first = deferred();
    let calls = 0;
    s.service.open = async () => (++calls === 1 ? first.promise : s.conn);
    createExtension(s.client, {}, undefined, s.service)(s.pi);
    await s.handlers.get("session_start")({ reason: "startup" }, s.ctx);
    await tick();
    assert.equal(calls, 1);
    const tree = s.handlers.get("session_tree")({}, s.ctx);
    first.resolve(s.conn);
    await tree;
    assert.equal(calls, 2);
    await s.commands.get("orca-watch").handler("status", s.ctx);
    assert.ok(s.notices.at(-1)[0].includes("watching"));
  }));

test("cancelled retained delivery reports that the saved batch remains safe", () =>
  fixture(async (s) => {
    await writeFile(s.file, "session");
    s.conn.delivery = {
      id: "receipt_retained",
      result: {
        runId: "run_one",
        messages: [
          {
            id: "msg_saved",
            type: "worker_done",
            run_id: "run_one",
            to_handle: "run:run_one",
          },
        ],
      },
    };
    createExtension(s.client, {}, undefined, s.service)(s.pi);
    await s.handlers.get("session_start")({ reason: "resume" }, s.ctx);
    await tick();
    await tick();
    const controller = new AbortController();
    controller.abort();
    const result = await s.tools
      .get("orca_inbox")
      .execute("cancelled", {}, controller.signal, undefined, s.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /saved batch.*retained/i);
    assert.doesNotMatch(result.content[0].text, /reconcile.*history/i);
    assert.equal(s.conn.delivery.id, "receipt_retained");
  }));

test("automatic opt-out never calls setup", () =>
  fixture(async (s) => {
    s.service.automatic = () => false;
    await writeFile(s.file, "session");
    createExtension(s.client, {}, undefined, s.service)(s.pi);
    await s.handlers.get("session_start")({ reason: "startup" }, s.ctx);
    await s.handlers.get("agent_start")({}, s.ctx);
    await tick();
    assert.equal(s.opens(), 0);
  }));

test("doctor leaves independently waiting, connecting and connected setup untouched", () =>
  fixture(async (s) => {
    const gate = deferred();
    let opens = 0,
      reads = 0;
    let setupSignal;
    s.service.open = async (_input, signal) => {
      opens++;
      setupSignal = signal;
      return gate.promise;
    };
    s.client.read = async () => {
      reads++;
      throw new Error("Unexpected read");
    };
    createExtension(
      s.client,
      { ORCA_TERMINAL_HANDLE: "synthetic-managed" },
      undefined,
      s.service,
    )(s.pi);
    await s.handlers.get("session_start")({ reason: "startup" }, s.ctx);
    const doctor = () =>
      s.tools
        .get("orca_doctor")
        .execute("doctor", {}, undefined, undefined, s.ctx);
    assert.equal((await doctor()).details.status, "blocked");
    assert.equal(opens, 0);
    await s.handlers.get("agent_start")({}, s.ctx);
    await tick();
    assert.equal(opens, 1);
    await doctor();
    assert.equal(setupSignal.aborted, false);
    gate.resolve(s.conn);
    await tick();
    await tick();
    await doctor();
    assert.equal(opens, 1);
    assert.equal(s.closed(), 0);
    assert.equal(reads, 0);
  }));

for (const scenario of [
  "first-retained",
  "accepted-duplicate",
  "unrelated-retained",
  "failed-target",
  "malformed-target",
]) {
  test(`onboarding scripted consumer receives ${scenario} evidence only through retained inbox`, () =>
    fixture(async (s) => {
      await writeFile(s.file, "session");
      let consumes = 0;
      const notifications = [];
      s.pi.sendMessage = (message) => notifications.push(message);
      s.client.read = async () => {
        consumes++;
        throw new Error("Retained evidence must not consume again");
      };
      const pending = {
        taskId: "task_test",
        dispatchId: "ctx_test",
        marker: "ONBOARDING_fixture_marker",
      };
      const data = {
        taskId:
          scenario === "unrelated-retained" ? "task_other" : pending.taskId,
        dispatchId: pending.dispatchId,
        outcome: scenario === "failed-target" ? "failed" : "succeeded",
      };
      const row = {
        id: "msg_saved",
        type: "worker_done",
        run_id: "run_one",
        to_handle: "run:run_one",
        body: pending.marker,
        payload:
          scenario === "malformed-target" ? "not-json" : JSON.stringify(data),
      };
      s.conn.delivery = {
        id: "receipt_saved",
        result: { runId: "run_one", messages: [row] },
      };
      createExtension(s.client, {}, undefined, s.service)(s.pi);
      await s.handlers.get("session_start")({ reason: "resume" }, s.ctx);
      await tick();
      await tick();
      assert.equal(notifications.length, 1);
      assert.ok(!notifications[0].content.includes(pending.marker));
      const received = await s.tools
        .get("orca_inbox")
        .execute("saved", {}, undefined, undefined, s.ctx);
      assert.deepEqual(received.details.messages, [row]);
      assert.equal(consumes, 0);
      // This scripted consumer models the skill's rule; it is not an agent-behavior guarantee.
      const accepted = new Set(
        scenario === "accepted-duplicate" ? [pending.taskId] : [],
      );
      let newlyAccepted = 0;
      for (const message of received.details.messages) {
        try {
          const payload = JSON.parse(message.payload);
          if (
            message.type === "worker_done" &&
            payload.taskId === pending.taskId &&
            payload.dispatchId === pending.dispatchId &&
            payload.outcome === "succeeded" &&
            message.body === pending.marker &&
            !accepted.has(pending.taskId)
          ) {
            accepted.add(pending.taskId);
            newlyAccepted++;
          }
        } catch {}
      }
      assert.equal(newlyAccepted, scenario === "first-retained" ? 1 : 0);
      assert.equal(
        accepted.has(pending.taskId),
        ["first-retained", "accepted-duplicate"].includes(scenario),
      );
    }));
}

test("successful diagnostic metadata probes coexist with waiting, connecting and watching setup", () =>
  fixture(async (s) => {
    const { mkdir, realpath, readFile } = await import("node:fs/promises");
    const root = await realpath(s.dir),
      bin = join(root, "doctor-bin"),
      log = join(root, "probes");
    await mkdir(bin);
    const git = join(bin, "git-fixture"),
      orca = join(bin, "orca-fixture");
    await writeFile(join(bin, "pi"), "candidate only", { mode: 0o700 });
    await writeFile(
      git,
      `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['rev-parse','--show-toplevel']))process.exit(2);require('node:fs').appendFileSync(${JSON.stringify(log)},'git\\n');console.log(${JSON.stringify(root)});\n`,
      { mode: 0o700 },
    );
    await writeFile(
      orca,
      `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['worktree','show','--worktree',${JSON.stringify("path:" + root)},'--json','--environment','local']))process.exit(2);require('node:fs').appendFileSync(${JSON.stringify(log)},'orca\\n');console.log(JSON.stringify({ok:true,result:{worktree:{id:${JSON.stringify("fixture::" + root)},path:${JSON.stringify(root)},identity:{executionHostId:'local'}}}}));\n`,
      { mode: 0o700 },
    );
    const gate = deferred();
    let opens = 0,
      reads = 0,
      setupSignal;
    s.service.open = async (_input, signal) => {
      opens++;
      setupSignal = signal;
      return gate.promise;
    };
    s.client.read = async () => {
      reads++;
      throw new Error("Unexpected mailbox read");
    };
    createExtension(
      s.client,
      { PATH: bin, PI_ORCA_GIT: git, ORCA_CLI_COMMAND: orca },
      undefined,
      s.service,
    )(s.pi);
    await s.handlers.get("session_start")({ reason: "startup" }, s.ctx);
    const doctor = async () => {
      const result = await s.tools
        .get("orca_doctor")
        .execute("doctor", {}, undefined, undefined, s.ctx);
      assert.equal(result.details.status, "live-test-required");
    };
    await doctor();
    assert.equal(opens, 0);
    await s.handlers.get("agent_start")({}, s.ctx);
    await tick();
    assert.equal(opens, 1);
    await doctor();
    assert.equal(setupSignal.aborted, false);
    gate.resolve(s.conn);
    await tick();
    await tick();
    await doctor();
    assert.equal(opens, 1);
    assert.equal(s.closed(), 0);
    assert.equal(reads, 0);
    assert.equal(
      (await readFile(log, "utf8")).split("\n").filter(Boolean).length,
      6,
    );
  }));
