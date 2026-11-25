import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkerLauncher,
  parseLaunchInput,
  classifyLaunch,
} from "../src/launch.ts";

const target = { run: "run_test", terminal: "term_owned" };
const id = "b573b110-a9ee-4f26-b5f8-e07bd0c78c3b";
const input = {
  agent: "codex",
  title: "Read package name",
  spec: "Read package.json without editing.",
};
const terminal = {
  handle: target.terminal,
  worktreeId: "repo::/repo",
  worktreePath: "/repo",
  executionHostId: "local",
  connected: true,
  incarnationId: "incarnation-test",
};
const owner = { run: { id: target.run, coordinator_handle: target.terminal } };
function fixture(responses = [owner, { terminal }]) {
  const calls = [];
  const mutations = [];
  const launcher = new WorkerLauncher({
    env: {},
    read: async (args) => {
      calls.push(args);
      return responses.shift();
    },
    canonical: async (path) => path,
    mutate: async (args, brief) => {
      mutations.push({ args, brief });
      return { code: 0, envelope: ready(plan()) };
    },
  });
  return { launcher, calls, mutations };
}
function plan() {
  return {
    requestId: id,
    target,
    worktreeId: terminal.worktreeId,
    workspacePath: "/repo",
    incarnationId: terminal.incarnationId,
    ...input,
    brief: "Read only. " + input.spec,
  };
}
function ready(p) {
  return {
    ok: true,
    result: {
      state: "ready",
      runId: p.target.run,
      run: { id: p.target.run, created: false },
      taskId: "task_test",
      dispatchId: "ctx_test",
      mutation: { requestId: p.requestId, replayed: false },
      launch: {
        effective: {
          agent: p.agent,
          model: p.model ?? null,
          effort: p.effort ?? null,
        },
      },
      effects: [{ kind: "worktree", id: p.worktreeId, action: "reused" }],
    },
  };
}

test("preflight verifies owner and exact local workspace before generating a request", async () => {
  const f = fixture();
  const p = await f.launcher.prepare(target, input, "/repo");
  assert.match(p.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(p.worktreeId, terminal.worktreeId);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].includes("run-show"));
  assert.ok(f.calls[1].includes("terminal"));
  assert.ok(p.brief.includes("READ-ONLY"));
  assert.ok(p.brief.includes(input.spec));
  assert.equal(f.mutations.length, 0);
});

test("wrong owner, remote terminal, or different cwd never reaches mutation", async () => {
  for (const responses of [
    [{ run: { id: target.run, coordinator_handle: "term_other" } }],
    [owner, { terminal: { ...terminal, executionHostId: "remote" } }],
    [owner, { terminal: { ...terminal, worktreePath: "/other" } }],
    [owner, { terminal: { ...terminal, worktreeId: "repo::/other" } }],
    [owner, { terminal: { ...terminal, connected: false } }],
  ]) {
    const f = fixture(responses);
    await assert.rejects(f.launcher.prepare(target, input, "/repo"));
    assert.equal(f.mutations.length, 0);
  }
});

test("invalid launch arguments fail before preflight", async () => {
  for (const args of [
    { ...input, agent: "--on" },
    { ...input, spec: "x\0y" },
    { ...input, spec: "x".repeat(40000) },
    { ...input, model: "--unsafe" },
    { ...input, effort: "high" },
    { ...input, on: "remote" },
    { ...input, title: "" },
    { ...input, title: "--unsafe" },
    { ...input, title: "one\ntwo" },
    { ...input, model: "model\nname" },
  ]) {
    assert.throws(() => parseLaunchInput(args));
    const f = fixture();
    await assert.rejects(f.launcher.prepare(target, args, "/repo"));
    assert.equal(f.calls.length, 0);
  }
});

test("remote and injected caller environments are refused", async () => {
  for (const name of [
    "ORCA_AGENT_SESSION_ID",
    "ORCA_TERMINAL_HANDLE",
    "ORCA_PANE_KEY",
    "ORCA_PAIRING_CODE",
    "ORCA_REMOTE_PAIRING",
    "ORCA_ENVIRONMENT",
    "ORCA_WORKTREE_ID",
    "ORCA_WORKSPACE_ID",
    "ORCA_CLI_CWD",
    "ORCA_USER_DATA_PATH",
  ]) {
    const launcher = new WorkerLauncher({ env: { [name]: "untrusted" } });
    await assert.rejects(
      launcher.prepare(target, input, "/repo"),
      /local|identity/i,
    );
  }
});

test("launch argv has pinned ownership, exact workspace and pre-recorded request id", async () => {
  const f = fixture();
  await f.launcher.submit(plan());
  const { args, brief } = f.mutations[0];
  assert.equal(brief, plan().brief);
  for (const [flag, value] of [
    ["--run", target.run],
    ["--from", target.terminal],
    ["--worktree", "id:repo::/repo"],
    ["--retry-request", id],
    ["--spec-file", "-"],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  for (const flag of [
    "--on",
    "--keep-open",
    "--setup",
    "--repo",
    "--name",
    "--terminal",
    "--spec",
  ])
    assert.ok(!args.includes(flag));
});

test("ready requires matching run, request, agent and reused workspace", () => {
  assert.equal(
    classifyLaunch(plan(), { code: 0, envelope: ready(plan()) }).status,
    "ready",
  );
  for (const mutate of [
    (r) => (r.runId = "run_other"),
    (r) => (r.run.created = true),
    (r) => (r.mutation.requestId = "wrong"),
    (r) => (r.launch.effective.agent = "other"),
    (r) => (r.effects[0].action = "created"),
  ]) {
    const e = ready(plan());
    mutate(e.result);
    assert.equal(
      classifyLaunch(plan(), { code: 0, envelope: e }).status,
      "blocked",
    );
  }
});

test("nonzero receipts and unobserved starts are not silently retried or called ready", () => {
  const e = ready(plan());
  e.result.state = "outcome_unknown";
  e.result.turnStart = "unobserved";
  assert.equal(
    classifyLaunch(plan(), { code: 1, envelope: e }).status,
    "unconfirmed",
  );
  e.result.state = "failed";
  assert.equal(
    classifyLaunch(plan(), { code: 1, envelope: e }).status,
    "blocked",
  );
  const failure = {
    ok: false,
    error: {
      code: "operation_unknown",
      data: { dispatchId: "ctx_test", failedStage: "readiness" },
    },
  };
  const result = classifyLaunch(plan(), { code: 1, envelope: failure });
  assert.equal(result.status, "blocked");
  assert.equal(result.dispatchId, "ctx_test");
  assert.equal(
    classifyLaunch(plan(), { code: null, problem: "deadline" }).status,
    "blocked",
  );
});

test("read-only reconciliation only accepts a completed matching ready receipt", async () => {
  const completed = {
    requestId: id,
    state: "completed",
    method: "orchestration.workerStart",
    receipt: ready(plan()).result,
  };
  const f = fixture([completed]);
  assert.equal((await f.launcher.inspect(plan())).status, "ready");
  assert.ok(f.calls[0].includes("request-show"));
  assert.equal(f.mutations.length, 0);
  for (const response of [
    { ...completed, state: "absent" },
    { ...completed, state: "pending" },
    { ...completed, requestId: "different" },
    { ...completed, method: "orchestration.other" },
    { ...completed, receipt: { ...completed.receipt, mutation: undefined } },
    { ...completed, receipt: { ...completed.receipt, state: "failed" } },
  ]) {
    const probe = fixture([response]);
    assert.equal((await probe.launcher.inspect(plan())).status, "blocked");
    assert.equal(probe.mutations.length, 0);
  }
});

test("canonical placement accepts matching symlinks and rejects mismatching ones", async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-placement-"));
  try {
    const actual = join(dir, "workspace"),
      other = join(dir, "other");
    const link = join(dir, "workspace-link"),
      wrong = join(dir, "wrong-link");
    await mkdir(actual);
    await mkdir(other);
    await symlink(actual, link, "dir");
    await symlink(other, wrong, "dir");
    const local = {
      ...terminal,
      worktreePath: actual,
      worktreeId: `repo::${link}`,
    };
    const make = (t) => {
      const rows = [owner, { terminal: t }];
      return new WorkerLauncher({ env: {}, read: async () => rows.shift() });
    };
    assert.equal(
      (await make(local).prepare(target, input, link)).worktreeId,
      local.worktreeId,
    );
    await assert.rejects(
      make(local).prepare(target, input, wrong),
      /workspace/,
    );
    await assert.rejects(
      make({ ...local, worktreeId: `repo::${wrong}` }).prepare(
        target,
        input,
        actual,
      ),
      /workspace/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const owned = { id: "repo::/wt/feature", path: "/wt/feature" };
const liveWorktree = {
  id: owned.id,
  repoId: "repo",
  hostId: "local",
  path: owned.path,
  isBare: false,
  isArchived: false,
};

test("an owned worktree is verified live before it becomes the workspace", async () => {
  const f = fixture([owner, { terminal }, { worktree: liveWorktree }]);
  const p = await f.launcher.prepare(target, input, "/repo", owned);
  assert.equal(p.worktreeId, owned.id);
  assert.equal(p.workspacePath, owned.path);
  assert.ok(p.brief.includes("Workspace: /wt/feature"));
  assert.ok(f.calls[2].includes("worktree"));
  assert.ok(f.calls[2].includes(`id:${owned.id}`));
  assert.equal(f.mutations.length, 0);
});

test("an owned worktree that is foreign, stale or unsafe is refused", async () => {
  for (const [worktree, live] of [
    [{ ...owned, id: "other::/wt/feature" }, liveWorktree],
    [{ ...owned, path: "relative" }, liveWorktree],
    [owned, { ...liveWorktree, id: "repo::/wt/else" }],
    [owned, { ...liveWorktree, repoId: "other" }],
    [owned, { ...liveWorktree, hostId: "remote" }],
    [owned, { ...liveWorktree, isBare: true }],
    [owned, { ...liveWorktree, isArchived: true }],
    [owned, { ...liveWorktree, path: "/wt/moved" }],
  ]) {
    const f = fixture([owner, { terminal }, { worktree: live }]);
    await assert.rejects(
      f.launcher.prepare(target, input, "/repo", worktree),
      /worktree/i,
    );
    assert.equal(f.mutations.length, 0);
  }
});

test("the session terminal must still own the session workspace when a worktree is named", async () => {
  const f = fixture([
    owner,
    { terminal: { ...terminal, worktreePath: "/other" } },
  ]);
  await assert.rejects(f.launcher.prepare(target, input, "/repo", owned));
  assert.equal(f.calls.length, 2);
});
