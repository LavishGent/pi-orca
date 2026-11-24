import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { WorkerLauncher } from "../src/launch.ts";
import { createExtension } from "../src/index.ts";
import { gitFixture } from "./git-fixture.mjs";

const input = {
  agent: "codex",
  title: "Edit fixture",
  spec: "Make only the authorized edit.",
  mode: "edit",
  files: ["new.ts"],
};
const target = { run: "run_test", terminal: "term_owned" };
async function planFor(value = input, owner = target, root = "/repo") {
  const l = new WorkerLauncher({
    env: {},
    canonical: async (p) => p,
    read: async (args) =>
      args.includes("run-show")
        ? { run: { id: owner.run, coordinator_handle: owner.terminal } }
        : {
            terminal: {
              handle: owner.terminal,
              worktreeId: `repo::${root}`,
              worktreePath: root,
              executionHostId: "local",
              connected: true,
              incarnationId: "fixture",
            },
          },
  });
  return l.prepare(owner, value, root);
}
function creation(p) {
  return {
    state: "ready",
    runId: p.target.run,
    run: { id: p.target.run, created: false },
    mutation: { requestId: p.requestId },
    taskId: "task_test",
    dispatchId: "ctx_test",
    launch: { effective: { agent: p.agent, model: null, effort: null } },
    effects: [{ kind: "worktree", id: p.worktreeId, action: "reused" }],
  };
}
const exited = JSON.parse(
  await readFile(
    new URL("./fixtures/exited-worker.json", import.meta.url),
    "utf8",
  ),
);
for (const patch of [{}, { state: "failed" }, { state: "cancelled" }]) {
  test(`verified ${patch.state ?? "succeeded"} exited worker permits another editor`, () =>
    gitFixture(async ({ root }) => {
      const old = await planFor(input, target, root),
        next = await planFor(input, { ...target, run: "run_next" }, root);
      const seen = [];
      const l = new WorkerLauncher({
        env: {},
        read: async (args, signal) => {
          seen.push({ args, signal });
          if (args.includes("request-show"))
            return {
              state: "completed",
              method: "orchestration.workerStart",
              requestId: old.requestId,
              receipt: creation(old),
            };
          return { ...exited, workspace: old.worktreeId, ...patch };
        },
      });
      await l.validateEdits(next, [old]);
      assert.equal(seen.length, 2);
      assert.ok(seen.every((x) => x.signal instanceof AbortSignal));
    }));
}
for (const patch of [
  { liveness: "live" },
  { stage: "running" },
  { terminalState: "active" },
  { taskId: "task_wrong" },
  { dispatchId: "ctx_wrong" },
  { runId: "run_wrong" },
  { workspace: "repo::/wrong" },
  {},
]) {
  test(`unverified worker blocks edits (${JSON.stringify(patch)})`, () =>
    gitFixture(async ({ root }) => {
      const old = await planFor(input, target, root),
        next = await planFor(input, target, root);
      const l = new WorkerLauncher({
        env: {},
        read: async (args) =>
          args.includes("request-show")
            ? {
                state: "completed",
                method: "orchestration.workerStart",
                requestId: old.requestId,
                receipt: creation(old),
              }
            : Object.keys(patch).length
              ? { ...exited, workspace: old.worktreeId, ...patch }
              : undefined,
      });
      await assert.rejects(l.validateEdits(next, [old]));
    }));
}

test("history errors are sanitized and inspection receives caller cancellation", async () => {
  const p = await planFor();
  const controller = new AbortController();
  let received;
  const l = new WorkerLauncher({
    env: {},
    read: async (_args, signal) => {
      received = signal;
      throw new Error("SYNTHETIC_SECRET");
    },
  });
  await assert.rejects(l.inspect(p, controller.signal));
  assert.equal(received, controller.signal);
  await assert.rejects(
    l.validateEdits(p, [p]),
    (error) => !error.message.includes("SYNTHETIC_SECRET"),
  );
  assert.ok(
    received instanceof AbortSignal,
    "The bounded history signal must reach request inspection",
  );
  controller.abort();
  await assert.rejects(l.validateEdits(p, [], controller.signal));
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function setup(records = [], overrides = {}) {
  const tools = new Map(),
    commands = new Map(),
    events = new Map();
  let submits = 0,
    checks = 0;
  const ctx = {
    cwd: "/repo",
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "/session.jsonl",
      getEntries: () => records,
    },
  };
  const launcher = {
    prepare: async (t, value) => planFor(value, t),
    validateEdits: async () => {
      checks++;
    },
    submit: async (p) => {
      submits++;
      return {
        status: "ready",
        requestId: p.requestId,
        runId: p.target.run,
        taskId: "task_test",
        dispatchId: "ctx_test",
      };
    },
    inspect: async (p) => ({
      status: "ready",
      requestId: p.requestId,
      runId: p.target.run,
      taskId: "task_test",
      dispatchId: "ctx_test",
    }),
    ...overrides,
  };
  createExtension(
    { verify: async () => {}, peek: async () => new Promise(() => {}) },
    {},
    launcher,
  )({
    on: (name, fn) => events.set(name, fn),
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (name, c) => commands.set(name, c),
    appendEntry: (customType, data) =>
      records.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage() {},
  });
  return {
    records,
    ctx,
    events,
    tools,
    launcher,
    counts: () => ({ submits, checks }),
    attach: (run = "run_test") =>
      commands.get("orca-watch").handler(`attach ${run} term_owned`, ctx),
    stop: () => commands.get("orca-watch").handler("stop", ctx),
    start: (value = input, signal) =>
      tools
        .get("orca_worker_start")
        .execute("test", value, signal, undefined, ctx),
  };
}
const record = (p, status = "ready") => ({
  type: "custom",
  customType: "orca-launch-journal",
  data: { version: 2, plan: p, status },
});

test("edit lifecycle journals v2, reports scope, and read-only remains v1", async () => {
  const s = setup();
  await s.attach();
  const result = await s.start();
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.files, input.files);
  assert.deepEqual(
    s.records.map((x) => x.data.version),
    [2, 2],
  );
  const read = { agent: "codex", title: "Read", spec: "Read only." };
  await s.start(read);
  assert.deepEqual(
    s.records.slice(-2).map((x) => x.data.version),
    [1, 1],
  );
  await s.stop();
});

test("uncertain edit records in another run block this workspace but not ordinary read-only starts", async () => {
  const old = await planFor(input, { ...target, run: "run_old" });
  const s = setup([record(old, "pending")]);
  await s.attach();
  assert.equal((await s.start()).isError, true);
  assert.equal(s.counts().submits, 0);
  assert.equal(
    (await s.start({ agent: "codex", title: "Read", spec: "Inspect only." }))
      .isError,
    undefined,
  );
  assert.equal(s.counts().submits, 1);
  await s.stop();
});

test("workspace alias identities cannot bypass an unresolved editor", async () => {
  const old = await planFor(input, { ...target, run: "run_old" });
  old.worktreeId = "alternate::/alias";
  const s = setup([record(old, "pending")]);
  await s.attach();
  assert.equal((await s.start()).isError, true);
  assert.equal(s.counts().submits, 0);
  await s.stop();
});

test("valid history inspection failures block only edit launches", async () => {
  const old = await planFor();
  const s = setup([record(old)], {
    validateEdits: async () => {
      throw new Error("SYNTHETIC_SECRET");
    },
  });
  await s.attach();
  const result = await s.start();
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
  assert.equal(
    (await s.start({ agent: "codex", title: "Read", spec: "Inspect only." }))
      .isError,
    undefined,
  );
  await s.stop();
});

test("edit-submission lock survives reattachment to another run", async () => {
  const gate = deferred();
  let entered = false;
  const s = setup([], {
    validateEdits: async () => {
      entered = true;
      await gate.promise;
    },
  });
  await s.attach();
  const first = s.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, true);
  await s.attach("run_other");
  const second = await s.start();
  assert.equal(second.isError, true);
  assert.equal(s.counts().submits, 0);
  gate.resolve();
  assert.equal((await first).isError, true);
  assert.equal(s.records.length, 0);
  await s.stop();
});

test("shutdown during edit preflight prevents journaling and submission", async () => {
  const gate = deferred();
  let entered = false;
  const s = setup([], {
    validateEdits: async () => {
      entered = true;
      await gate.promise;
    },
  });
  await s.attach();
  const first = s.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, true);
  s.events.get("session_shutdown")();
  gate.resolve();
  assert.equal((await first).isError, true);
  assert.equal(s.records.length, 0);
  assert.equal(s.counts().submits, 0);
});

test("prepared tasks cannot replace the requested brief, harness or model", async () => {
  for (const replacement of [
    { spec: "Unrequested task." },
    { agent: "claude" },
    { model: "unrequested-model" },
  ]) {
    const s = setup([], {
      prepare: async (t, value) => planFor({ ...value, ...replacement }, t),
    });
    await s.attach();
    assert.equal((await s.start()).isError, true);
    assert.equal(s.records.length, 0);
    assert.equal(s.counts().checks, 0);
    assert.equal(s.counts().submits, 0);
    await s.stop();
  }
});

test("scope is checked again after an injected validator returns", async () => {
  const s = setup([], {
    validateEdits: async (p) => {
      p.files = ["elsewhere.ts"];
    },
  });
  await s.attach();
  assert.equal((await s.start()).isError, true);
  assert.equal(s.records.length, 0);
  assert.equal(s.counts().submits, 0);
  await s.stop();
});

test("missing edit support, history cap and malformed edit journals refuse safely", async () => {
  for (const records of [
    [],
    [record({ ...(await planFor()), mode: "unexpected" })],
    await Promise.all(
      Array.from({ length: 33 }, async () => record(await planFor())),
    ),
  ]) {
    const s = setup(
      records,
      records.length ? {} : { validateEdits: undefined },
    );
    await s.attach();
    assert.equal((await s.start()).isError, true);
    assert.equal(s.counts().submits, 0);
    await s.stop();
  }
});

test("edit reconciliation and exception appends preserve journal version 2", async () => {
  for (const throwing of [false, true]) {
    const records = [];
    const s = setup(
      records,
      throwing
        ? {
            submit: async () => {
              throw new Error("SYNTHETIC_SECRET");
            },
          }
        : {},
    );
    await s.attach();
    await s.start();
    const p = records[0].data.plan;
    await s.tools
      .get("orca_launch_status")
      .execute(
        "status",
        { requestId: p.requestId },
        undefined,
        undefined,
        s.ctx,
      );
    assert.ok(records.every((x) => x.data.version === 2));
    assert.equal(records.at(-1).data.status, "ready");
    await s.stop();
  }
});
