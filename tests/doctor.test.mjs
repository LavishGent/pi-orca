import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnose,
  formatDoctor,
  supportsNode,
  parseAgent,
  findExecutable,
} from "../src/doctor.ts";

function fixture(overrides = {}) {
  const calls = [];
  const options = {
    env: { PATH: "/trusted" },
    platform: "darwin",
    nodeVersion: "v22.19.0",
    canonical: async (path) => (path === "/alias" ? "/workspace" : path),
    find: async (name) => "/trusted/" + name.split("/").at(-1),
    git: async (binary, args, context) => {
      calls.push({ kind: "git", binary, args, context });
      return "/workspace\n";
    },
    orca: async (binary, args, context) => {
      calls.push({ kind: "orca", binary, args, context });
      return {
        worktree: {
          id: "fixture::/workspace",
          path: "/workspace",
          identity: { executionHostId: "local" },
        },
      };
    },
    ...overrides,
  };
  return { calls, run: (agent) => diagnose("/workspace", agent, options) };
}
test("doctor checks only Git root and local Orca metadata; versions and accounts stay unknown", async () => {
  const f = fixture();
  const report = await f.run("codex");
  assert.equal(report.schema, "pi-orca.doctor.v1");
  assert.equal(report.status, "live-test-required");
  assert.deepEqual(
    f.calls.map((c) => [c.kind, c.args]),
    [
      ["git", ["rev-parse", "--show-toplevel"]],
      [
        "orca",
        [
          "worktree",
          "show",
          "--worktree",
          "path:/workspace",
          "--json",
          "--environment",
          "local",
        ],
      ],
    ],
  );
  for (const id of [
    "versions",
    "identity",
    "authentication",
    "quota",
    "live-test",
  ])
    assert.equal(report.checks.find((c) => c.id === id).status, "unknown");
  assert.equal(f.calls[0].context.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(f.calls[0].context.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.ok(!("ORCA_ENVIRONMENT" in f.calls[1].context.env));
  assert.ok(formatDoctor(report).includes("live-test-required"));
});
test("no selected harness is explicitly skipped, not an all-four requirement", async () => {
  const report = await fixture().run();
  assert.equal(report.status, "live-test-required");
  assert.equal(report.checks.find((c) => c.id === "agent").status, "skipped");
});
test("invalid public inputs and unsupported callers never schedule probes", async () => {
  for (const agent of ["other", "codex --help", {}, null]) {
    const f = fixture();
    const r = await f.run(agent);
    assert.equal(r.status, "blocked");
    assert.equal(f.calls.length, 0);
  }
  for (const extra of [
    { platform: "win32" },
    { nodeVersion: "v22.18.0" },
    { env: { ORCA_TERMINAL_HANDLE: "private" } },
    { env: { ORCA_ENVIRONMENT: "remote" } },
  ]) {
    const f = fixture(extra);
    assert.equal((await f.run()).status, "blocked");
    assert.equal(f.calls.length, 0);
  }
});
test("Node minimum and supported agent validation are explicit", () => {
  for (const v of ["22.19.0", "v22.20.0", "23.0.0", "26.0.0"])
    assert.ok(supportsNode(v));
  for (const v of ["22.18.99", "20.19.0", "garbage"])
    assert.ok(!supportsNode(v));
  assert.equal(parseAgent(undefined), undefined);
  assert.equal(parseAgent("claude"), "claude");
  assert.throws(() => parseAgent("bash"));
});
test("missing candidates block without silently substituting an override", async () => {
  const found = [];
  const f = fixture({
    env: { ORCA_CLI_COMMAND: "/missing/custom" },
    find: async (name) => {
      found.push(name);
      return name.includes("custom") ? undefined : "/trusted/candidate";
    },
  });
  assert.equal((await f.run("codex")).status, "blocked");
  assert.ok(found.includes("/missing/custom"));
  assert.equal(
    f.calls.some((c) => c.kind === "orca"),
    false,
  );
});
test("canonical worktree aliases match, but wrong root, host and malformed responses fail closed", async () => {
  const ok = fixture({
    orca: async () => ({
      worktree: {
        id: "fixture::/alias",
        path: "/alias",
        identity: { executionHostId: "local" },
      },
    }),
  });
  assert.equal((await ok.run()).status, "live-test-required");
  for (const worktree of [
    {
      id: "fixture::/wrong",
      path: "/workspace",
      identity: { executionHostId: "local" },
    },
    {
      id: "fixture::/workspace",
      path: "/workspace",
      identity: { executionHostId: "remote" },
    },
    { id: "bad", path: "/workspace" },
    null,
  ]) {
    assert.equal(
      (await fixture({ orca: async () => ({ worktree }) }).run()).status,
      "blocked",
    );
  }
  const f = fixture({ git: async () => "/parent\n" });
  assert.equal((await f.run()).status, "blocked");
  assert.equal(f.calls.length, 0);
});
test("raw output, errors, paths and identity values never become report text", async () => {
  const secret = "synthetic-private-value";
  const f = fixture({
    git: async () => {
      throw new Error(secret);
    },
    orca: async () => {
      throw new Error(secret);
    },
  });
  const r = await f.run();
  assert.equal(r.status, "blocked");
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.ok(!JSON.stringify(r).includes("/workspace"));
  const bad = fixture({
    orca: async () => ({
      worktree: {
        id: secret,
        path: secret,
        identity: { executionHostId: secret },
      },
    }),
  });
  assert.ok(!JSON.stringify(await bad.run()).includes(secret));
});
test("Git probe does not inherit executable/config/trace injection", async () => {
  const f = fixture({
    env: {
      PATH: "/trusted",
      GIT_CONFIG_COUNT: "1",
      GIT_DIR: "/elsewhere",
      GIT_TRACE: "/private-log",
      GIT_SSH_COMMAND: "bad",
      NODE_OPTIONS: "bad",
    },
  });
  await f.run();
  const env = f.calls[0].context.env;
  for (const key of [
    "GIT_CONFIG_COUNT",
    "GIT_DIR",
    "GIT_TRACE",
    "GIT_SSH_COMMAND",
    "NODE_OPTIONS",
  ])
    assert.ok(!(key in env));
});
test("cancellation before and during metadata probes wins late success", async () => {
  const c = new AbortController();
  c.abort();
  const f = fixture({ signal: c.signal });
  assert.equal((await f.run()).status, "blocked");
  assert.equal(f.calls.length, 0);
  const d = new AbortController();
  const other = fixture({
    signal: d.signal,
    git: async () => {
      d.abort();
      return "/workspace\n";
    },
  });
  assert.equal((await other.run()).status, "blocked");
  assert.equal(other.calls.length, 0);
});

test("passive search is finite and absolute overrides do not depend on PATH", async () => {
  const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-orca-find-"));
  try {
    const cli = join(root, "candidate");
    await writeFile(cli, "not executed", { mode: 0o700 });
    await mkdir(join(root, "directory"));
    assert.equal(
      await findExecutable(cli, root, { PATH: "x".repeat(40000) }),
      cli,
    );
    assert.equal(await findExecutable("candidate", root, { PATH: root }), cli);
    assert.equal(
      await findExecutable("directory", root, { PATH: root }),
      undefined,
    );
    assert.equal(
      await findExecutable("candidate", root, {
        PATH: Array(130).fill(root).join(":"),
      }),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling pending filesystem discovery returns without waiting for its callback", async () => {
  const c = new AbortController();
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const f = fixture({
    signal: c.signal,
    find: async () => {
      started();
      return new Promise(() => {});
    },
  });
  const pending = f.run();
  await ready;
  c.abort();
  const result = await Promise.race([
    pending,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Cancellation hung")), 500),
    ),
  ]);
  assert.equal(result.status, "blocked");
  assert.equal(f.calls.length, 0);
});

test("macOS never executes the Apple Git installer launcher", async () => {
  const lookups = [];
  const missing = fixture({
    find: async (name) => {
      lookups.push(name);
      if (name === "/usr/bin/git") return name;
      if (name.startsWith("/Library/") || name.startsWith("/Applications/"))
        return undefined;
      return "/trusted/" + name;
    },
  });
  assert.equal((await missing.run()).status, "blocked");
  assert.equal(missing.calls.length, 0);
  assert.ok(
    lookups.includes("/Library/Developer/CommandLineTools/usr/bin/git"),
  );
  const ready = fixture({
    find: async (name) => (name.startsWith("/") ? name : "/trusted/" + name),
  });
  assert.equal((await ready.run()).status, "live-test-required");
  assert.equal(
    ready.calls[0].binary,
    "/Library/Developer/CommandLineTools/usr/bin/git",
  );
  const override = fixture({
    env: { PI_ORCA_GIT: "/usr/bin/git" },
    find: async (name) => (name.startsWith("/") ? name : "/trusted/" + name),
  });
  assert.equal((await override.run()).status, "blocked");
  assert.equal(override.calls.length, 0);
});
