import assert from "node:assert/strict";
import test from "node:test";
import {
  WorktreeManager,
  classifyWorktree,
  parseWorktreeInput,
  validRef,
} from "../src/worktree.ts";

const target = { run: "run_test", terminal: "term_owned" };
const terminal = {
  handle: target.terminal,
  worktreeId: "repo::/repo",
  worktreePath: "/repo",
  executionHostId: "local",
  connected: true,
  incarnationId: "incarnation-test",
};
const input = {
  name: "feat-auth",
  branch: "feat/auth",
  baseBranch: "origin/main",
};
const created = {
  id: "repo::/wt/feat-auth",
  repoId: "repo",
  hostId: "local",
  path: "/wt/feat-auth",
  branch: "refs/heads/feat/auth",
  isBare: false,
  isMainWorktree: false,
};

function manager(envelope, extra = {}) {
  const mutations = [];
  const reads = [];
  const m = new WorktreeManager({
    env: {},
    read: async (args) => {
      reads.push(args);
      return { terminal };
    },
    canonical: async (path) => path,
    mutate: async (args, stdin) => {
      mutations.push({ args, stdin });
      return envelope;
    },
    ...extra,
  });
  return { m, mutations, reads };
}

test("refs and names cannot be options, traversal or odd Git syntax", () => {
  for (const bad of [
    "-x",
    "--upload-pack=x",
    "a..b",
    "a//b",
    "a/",
    "a.lock",
    ".hid",
    "a/.b",
    "a b",
    "a\nb",
    "",
    "x".repeat(121),
  ])
    assert.equal(validRef(bad), false, bad);
  for (const good of ["feat/auth", "origin/main", "v1.2.3"])
    assert.equal(validRef(good), true, good);
  assert.deepEqual(parseWorktreeInput(input), input);
  for (const bad of [
    { ...input, name: "-x" },
    { ...input, name: "a/b" },
    { ...input, branch: "--bad" },
    { ...input, baseBranch: "-x" },
    { ...input, repo: "id:other" },
    { ...input, setup: "run" },
    null,
  ])
    assert.throws(() => parseWorktreeInput(bad));
});

test("creation targets the session repo with setup skipped and no parent", async () => {
  const { m, mutations } = manager({
    code: 0,
    envelope: { ok: true, result: { worktree: created } },
  });
  const outcome = await m.create(target, input, "/repo");
  assert.equal(outcome.status, "ready");
  assert.deepEqual(outcome.record, {
    name: "feat-auth",
    branch: "feat/auth",
    id: created.id,
    path: created.path,
  });
  const args = mutations[0].args;
  assert.deepEqual(args.slice(0, 4), [
    "worktree",
    "create",
    "--repo",
    "id:repo",
  ]);
  assert.equal(args[args.indexOf("--setup") + 1], "skip");
  assert.ok(args.includes("--no-parent"));
  assert.equal(args[args.indexOf("--base-branch") + 1], "origin/main");
  assert.ok(args.includes("--environment"));
});

test("a mismatched or failed receipt is unconfirmed, never a record", () => {
  const ok = (worktree) => ({
    code: 0,
    envelope: { ok: true, result: { worktree } },
  });
  for (const transport of [
    { code: null, problem: "deadline" },
    { code: 1, envelope: { ok: false, error: { code: "name_taken" } } },
    ok({ ...created, repoId: "other" }),
    ok({ ...created, id: "other::/wt" }),
    ok({ ...created, hostId: "remote" }),
    ok({ ...created, isMainWorktree: true }),
    ok({ ...created, isBare: true }),
    ok({ ...created, branch: "refs/heads/other" }),
    ok({ ...created, path: "relative" }),
  ]) {
    const outcome = classifyWorktree(input, "repo", transport);
    assert.equal(outcome.status, "unconfirmed");
    assert.equal(outcome.record, undefined);
  }
  assert.equal(
    classifyWorktree(input, "repo", {
      code: 1,
      envelope: { ok: false, error: { code: "name_taken" } },
    }).errorCode,
    "name_taken",
  );
});

test("a terminal outside the session workspace or a remote caller never mutates", async () => {
  const { m, mutations } = manager(
    { code: 0 },
    {
      read: async () => ({ terminal: { ...terminal, worktreePath: "/other" } }),
    },
  );
  await assert.rejects(m.create(target, input, "/repo"));
  const remote = new WorktreeManager({ env: { ORCA_TERMINAL_HANDLE: "x" } });
  await assert.rejects(
    remote.create(target, input, "/repo"),
    /local|identity/i,
  );
  assert.equal(mutations.length, 0);
});
