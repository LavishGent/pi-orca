import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createExtension } from "../src/index.ts";

const input = {
  agent: "codex",
  title: "Read name",
  spec: "Read package name.",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function plan(target = { run: "run_test", terminal: "term_owned" }) {
  return {
    requestId: randomUUID(),
    target,
    worktreeId: "repo::/repo",
    workspacePath: "/repo",
    incarnationId: "test-incarnation",
    ...input,
    brief: "READ-ONLY task: " + input.spec,
  };
}
function outcome(p, status = "ready") {
  return {
    status,
    requestId: p.requestId,
    runId: p.target.run,
    dispatchId: "ctx_test",
    taskId: "task_test",
  };
}
function setup(records = [], overrides = {}, env = {}) {
  const tools = new Map(),
    commands = new Map(),
    handlers = new Map();
  let submits = 0,
    prepares = 0,
    inspections = 0;
  const launcher = {
    async prepare(target) {
      prepares++;
      return plan(target);
    },
    async submit(p) {
      submits++;
      assert.ok(
        records.some(
          (row) =>
            row.data?.plan?.requestId === p.requestId &&
            row.data.status === "pending",
        ),
        "Journal must precede mutation",
      );
      return outcome(p);
    },
    async inspect(p) {
      inspections++;
      return outcome(p);
    },
    ...overrides,
  };
  const ctx = {
    cwd: "/repo",
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => "session-test",
      getSessionFile: () => "/session.jsonl",
      getEntries: () => records,
    },
  };
  const append = (customType, data) =>
    records.push({ type: "custom", customType, data: structuredClone(data) });
  createExtension(
    { verify: async () => {}, peek: async () => new Promise(() => {}) },
    env,
    launcher,
  )({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: append,
    sendMessage() {},
  });
  return {
    records,
    ctx,
    handlers,
    tools,
    launcher,
    attach: () =>
      commands.get("orca-watch").handler("attach run_test term_owned", ctx),
    stop: () => commands.get("orca-watch").handler("stop", ctx),
    start: (signal) =>
      tools
        .get("orca_worker_start")
        .execute("start-call", input, signal, undefined, ctx),
    inspect: (id) =>
      tools
        .get("orca_launch_status")
        .execute("status-call", { requestId: id }, undefined, undefined, ctx),
    counts: () => ({ submits, prepares, inspections }),
  };
}

test("launch recovery guidance honors the configured CLI", async () => {
  const s = setup([], {}, { ORCA_CLI_COMMAND: "/trusted/custom-orca" });
  await s.attach();
  const result = await s.start();
  assert.ok(
    result.content[0].text.includes(
      "/trusted/custom-orca orchestration request-show",
    ),
  );
  assert.ok(result.content[0].text.includes("--environment local"));
  s.handlers.get("session_shutdown")();
});

test("launch requires an attached persistent session and records before mutation", async () => {
  const s = setup();
  assert.equal((await s.start()).isError, true);
  await s.attach();
  await tick();
  const result = await s.start();
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    s.records.map((x) => x.data.status),
    ["pending", "ready"],
  );
  assert.equal(s.counts().submits, 1);
  s.handlers.get("session_shutdown")();
});

test("ephemeral sessions and already-cancelled calls never submit", async () => {
  const s = setup();
  await s.attach();
  await tick();
  s.ctx.sessionManager.getSessionFile = () => null;
  assert.equal((await s.start()).isError, true);
  s.ctx.sessionManager.getSessionFile = () => "/session.jsonl";
  const c = new AbortController();
  c.abort();
  assert.equal((await s.start(c.signal)).isError, true);
  assert.equal(s.counts().submits, 0);
  assert.equal(s.records.length, 0);
  s.handlers.get("session_shutdown")();
});

test("ambiguous starts block after stop, reattachment and extension replacement", async () => {
  const records = [];
  const s = setup(records, { submit: async (p) => outcome(p, "blocked") });
  await s.attach();
  await tick();
  await s.start();
  await s.stop();
  await s.attach();
  await tick();
  const before = s.counts().prepares;
  assert.equal((await s.start()).isError, true);
  assert.equal(s.counts().prepares, before);
  s.handlers.get("session_shutdown")();
  const next = setup(records);
  await next.attach();
  await tick();
  assert.equal((await next.start()).isError, true);
  assert.equal(next.counts().submits, 0);
  next.handlers.get("session_shutdown")();
});

test("concurrent starts for a run are refused before a second preflight", async () => {
  const gate = deferred();
  let prepares = 0;
  const s = setup([], {
    prepare: async (target) => {
      prepares++;
      await gate.promise;
      return plan(target);
    },
  });
  await s.attach();
  await tick();
  const first = s.start();
  assert.equal((await s.start()).isError, true);
  assert.equal(prepares, 1);
  gate.resolve();
  await first;
  assert.equal(s.counts().submits, 1);
  s.handlers.get("session_shutdown")();
});

test("a model abort after submission does not pretend to cancel the worker", async () => {
  const gate = deferred();
  let submitted;
  const s = setup([], {
    submit: async (p) => {
      submitted = p;
      await gate.promise;
      return outcome(p);
    },
  });
  await s.attach();
  await tick();
  const c = new AbortController();
  const start = s.start(c.signal);
  await tick();
  c.abort();
  gate.resolve();
  const result = await start;
  assert.equal(result.details.requestId, submitted.requestId);
  assert.equal(result.details.status, "ready");
  assert.equal(s.records.at(-1).data.status, "ready");
  s.handlers.get("session_shutdown")();
});

test("reload during submission leaves a pending record until read-only reconciliation", async () => {
  const gate = deferred();
  const records = [];
  const s = setup(records, {
    submit: async (p) => {
      await gate.promise;
      return outcome(p);
    },
  });
  await s.attach();
  await tick();
  const start = s.start();
  await tick();
  const request = records[0].data.plan.requestId;
  s.handlers.get("session_shutdown")();
  gate.resolve();
  assert.equal((await start).isError, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.status, "pending");
  const next = setup(records);
  await next.attach();
  await tick();
  assert.equal((await next.start()).isError, true);
  const inspected = await next.inspect(request);
  assert.equal(inspected.details.status, "ready");
  assert.ok(inspected.content[0].text.includes("recorded launch receipt"));
  assert.ok(!inspected.content[0].text.includes("End the turn and await"));
  assert.equal(next.counts().submits, 0);
  assert.equal((await next.start()).isError, undefined);
  assert.equal(next.counts().submits, 1);
  next.handlers.get("session_shutdown")();
});

test("unknown inspection does not clear a pending block or issue another start", async () => {
  const p = plan();
  const records = [
    {
      type: "custom",
      customType: "orca-launch-journal",
      data: { version: 1, plan: p, status: "pending" },
    },
  ];
  const s = setup(records, { inspect: async () => outcome(p, "blocked") });
  await s.attach();
  await tick();
  assert.equal((await s.inspect(p.requestId)).isError, true);
  assert.equal(records.length, 1);
  assert.equal((await s.start()).isError, true);
  assert.equal(s.counts().submits, 0);
  s.handlers.get("session_shutdown")();
});

test("malformed launch history fails closed before any preflight or mutation", async () => {
  const s = setup([
    {
      type: "custom",
      customType: "orca-launch-journal",
      data: { version: 999 },
    },
  ]);
  await s.attach();
  await tick();
  assert.equal((await s.start()).isError, true);
  assert.equal(s.counts().prepares, 0);
  assert.equal(s.counts().submits, 0);
  s.handlers.get("session_shutdown")();
});

test("journal write failure prevents submission", async () => {
  const records = [];
  records.push = () => {
    throw new Error("disk write failed");
  };
  const s = setup(records);
  await s.attach();
  await tick();
  assert.equal((await s.start()).isError, true);
  assert.equal(s.counts().submits, 0);
  s.handlers.get("session_shutdown")();
});

test("unconfirmed is reported without resending and still blocks a new start", async () => {
  const s = setup([], { submit: async (p) => outcome(p, "unconfirmed") });
  await s.attach();
  await tick();
  const first = await s.start();
  assert.equal(first.isError, undefined);
  assert.equal(first.details.status, "unconfirmed");
  assert.equal((await s.start()).isError, true);
  assert.equal(s.counts().prepares, 1);
  s.handlers.get("session_shutdown")();
});

test("a separate session file has a separate launch journal and no cross-session lock", async () => {
  const original = setup([], {
    submit: async (p) => outcome(p, "unconfirmed"),
  });
  await original.attach();
  await tick();
  await original.start();
  const separate = setup([]);
  separate.ctx.sessionManager.getSessionId = () => "separate-session";
  separate.ctx.sessionManager.getSessionFile = () => "/separate-session.jsonl";
  await separate.attach();
  await tick();
  assert.equal((await separate.start()).isError, undefined);
  assert.equal(separate.counts().submits, 1);
  original.handlers.get("session_shutdown")();
  separate.handlers.get("session_shutdown")();
});

function attachedWithWorktree(records, creator) {
  const s = setup(records, {
    async prepare(target, _input, _cwd, worktree) {
      s.prepared.push(worktree);
      return {
        ...plan(target),
        ...(worktree
          ? { worktreeId: worktree.id, workspacePath: worktree.path }
          : {}),
      };
    },
  });
  s.prepared = [];
  return s;
}
const readyWorktree = {
  type: "custom",
  customType: "orca-worktree-journal",
  data: {
    version: 1,
    name: "feat-auth",
    status: "ready",
    record: {
      name: "feat-auth",
      branch: "feat/auth",
      id: "repo::/wt/feat-auth",
      path: "/wt/feat-auth",
    },
  },
};

test("worker start can target a worktree this session created", async () => {
  const records = [structuredClone(readyWorktree)];
  const s = attachedWithWorktree(records);
  await s.attach();
  await tick();
  const result = await s.tools
    .get("orca_worker_start")
    .execute(
      "c",
      { ...input, worktree: "feat-auth" },
      undefined,
      undefined,
      s.ctx,
    );
  assert.equal(result.isError, undefined);
  assert.deepEqual(s.prepared, [
    { id: "repo::/wt/feat-auth", path: "/wt/feat-auth" },
  ]);
  s.handlers.get("session_shutdown")();
});

test("worker start refuses worktrees this session did not create", async () => {
  const unconfirmed = structuredClone(readyWorktree);
  unconfirmed.data.status = "unconfirmed";
  for (const [records, name] of [
    [[], "feat-auth"],
    [[unconfirmed], "feat-auth"],
    [[structuredClone(readyWorktree)], "other"],
    [[structuredClone(readyWorktree)], 7],
  ]) {
    const s = attachedWithWorktree(records);
    await s.attach();
    await tick();
    const result = await s.tools
      .get("orca_worker_start")
      .execute("c", { ...input, worktree: name }, undefined, undefined, s.ctx);
    assert.equal(result.isError, true);
    assert.equal(s.counts().prepares, 0);
    assert.equal(s.counts().submits, 0);
    s.handlers.get("session_shutdown")();
  }
});

function withCreator(records, outcome) {
  const calls = [];
  const tools = new Map(),
    handlers = new Map(),
    commands = new Map();
  const ctx = {
    cwd: "/repo",
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => "session-test",
      getSessionFile: () => "/session.jsonl",
      getEntries: () => records,
    },
  };
  createExtension(
    { verify: async () => {}, peek: async () => new Promise(() => {}) },
    {},
    {
      prepare: async () => plan(),
      submit: async () => outcome,
      inspect: async () => outcome,
    },
    undefined,
    {
      async create(...args) {
        calls.push(args);
        return outcome;
      },
    },
  )({
    on: (n, h) => handlers.set(n, h),
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (n, c) => commands.set(n, c),
    appendEntry: (customType, data) =>
      records.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage() {},
  });
  return {
    calls,
    handlers,
    attach: () =>
      commands.get("orca-watch").handler("attach run_test term_owned", ctx),
    create: (params) =>
      tools
        .get("orca_worktree_create")
        .execute("c", params, undefined, undefined, ctx),
  };
}

test("worktree creation journals before and after, and grants ownership only when ready", async () => {
  const records = [];
  const record = {
    name: "feat-auth",
    branch: "feat/auth",
    id: "repo::/wt/feat-auth",
    path: "/wt/feat-auth",
  };
  const s = withCreator(records, {
    status: "ready",
    name: "feat-auth",
    record,
  });
  const params = { name: "feat-auth", branch: "feat/auth" };
  assert.equal((await s.create(params)).isError, true);
  await s.attach();
  await tick();
  const result = await s.create(params);
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    records.map((r) => r.data.status),
    ["pending", "ready"],
  );
  assert.deepEqual(records[1].data.record, record);
  // The name is single use, so a repeat never reaches Orca.
  assert.equal((await s.create(params)).isError, true);
  assert.equal(s.calls.length, 1);
  s.handlers.get("session_shutdown")();
});

test("an unconfirmed creation is an error, grants nothing and is not resent", async () => {
  const records = [];
  const s = withCreator(records, {
    status: "unconfirmed",
    name: "x",
    errorCode: "deadline",
  });
  await s.attach();
  await tick();
  const result = await s.create({ name: "x", branch: "feat/x" });
  assert.equal(result.isError, true);
  assert.deepEqual(
    records.map((r) => r.data.status),
    ["pending", "unconfirmed"],
  );
  assert.equal((await s.create({ name: "x", branch: "feat/x" })).isError, true);
  assert.equal(s.calls.length, 1);
  s.handlers.get("session_shutdown")();
});

test("invalid worktree input never journals or calls Orca", async () => {
  const records = [];
  const s = withCreator(records, { status: "ready", name: "x" });
  await s.attach();
  await tick();
  const result = await s.create({ name: "x", branch: "--bad" });
  assert.equal(result.isError, true);
  assert.equal(records.length, 0);
  assert.equal(s.calls.length, 0);
  s.handlers.get("session_shutdown")();
});
