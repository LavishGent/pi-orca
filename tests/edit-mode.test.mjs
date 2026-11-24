import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WorkerLauncher, parseLaunchInput, validPlan } from "../src/launch.ts";
import { readLaunchJournal } from "../src/launch-journal.ts";
import { readLaunchJournal as legacyReader } from "./fixtures/launch-journal-v1.ts";
import { createExtension } from "../src/index.ts";

const target = { run: "run_test", terminal: "term_owned" };
const input = {
  agent: "codex",
  title: "Scoped task",
  spec: "Perform the authorized task.",
};
const edit = {
  ...input,
  mode: "edit",
  files: ["src/example.ts", "src/new.test.ts"],
};
async function prepared(value = input) {
  const launcher = new WorkerLauncher({
    env: {},
    canonical: async (p) => p,
    read: async (args) =>
      args.includes("run-show")
        ? { run: { id: target.run, coordinator_handle: target.terminal } }
        : {
            terminal: {
              handle: target.terminal,
              worktreeId: "repo::/repo",
              worktreePath: "/repo",
              executionHostId: "local",
              connected: true,
              incarnationId: "test",
            },
          },
  });
  return launcher.prepare(target, value, "/repo");
}
function entry(version, plan, status = "ready") {
  return {
    type: "custom",
    customType: "orca-launch-journal",
    data: { version, plan, status },
  };
}

test("recorded version-2 edit brief remains valid independently of current preparation", async () => {
  const frozen = JSON.parse(
    await readFile(
      new URL("./fixtures/edit-plan-v2.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(validPlan(frozen), true);
  assert.equal(
    readLaunchJournal([entry(2, frozen)]).get(frozen.requestId).version,
    2,
  );
});

test("edit input is explicit and keeps the existing read-only default", () => {
  assert.deepEqual(parseLaunchInput(input), input);
  assert.equal(
    parseLaunchInput({ ...input, mode: "read-only" }).mode,
    "read-only",
  );
  assert.deepEqual(parseLaunchInput(edit), edit);
});

test("edit scope rejects missing, ambiguous and unsafe file grants", () => {
  for (const value of [
    { ...input, mode: "edit" },
    { ...edit, files: [] },
    { ...edit, mode: "unknown" },
    { ...input, files: ["file.ts"] },
    { ...edit, mode: "read-only" },
    ...[
      ["../file"],
      ["a/../file"],
      ["/file"],
      ["a//file"],
      ["a/./file"],
      ["a/*"],
      [".GIT/config"],
      ["a\u0000b"],
      ["a\\b"],
      ["same", "SAME"],
      ["é", "e\u0301"],
      Array.from({ length: 33 }, (_, i) => `f${i}`),
      Array.from({ length: 32 }, (_, i) => `${i}-${"p".repeat(200)}`),
      ["C:/file"],
      ["dir/file:stream"],
      ["file."],
      ["file "],
      ["CON"],
      ["dir/NUL.txt"],
      ["LPT¹.txt"],
      ["sub/.g\u200cit/config"],
      ["a\u202etxt"],
      ["file\ufeff.ts"],
      ["a\u034fb"],
      ["GIT~1/config"],
      ["bad\ud800.ts"],
      ["longna~1.ts"],
      ["a".repeat(513)],
    ].map((files) => ({ ...edit, files })),
  ])
    assert.throws(() => parseLaunchInput(value));
});

test("prepared edit briefs grant only the recorded scope and validate after serialization", async () => {
  const p = await prepared(edit);
  assert.equal(p.mode, "edit");
  assert.deepEqual(p.files, edit.files);
  assert.ok(p.brief.includes(JSON.stringify(edit.files)));
  assert.ok(!p.brief.startsWith("READ-ONLY assignment"));
  assert.ok(p.brief.includes("outside"));
  assert.equal(validPlan(JSON.parse(JSON.stringify(p))), true);
  assert.equal(validPlan({ ...p, files: ["another.ts"] }), false);
  assert.equal(validPlan({ ...p, brief: "READ-ONLY assignment." }), false);
});

test("edit plans record canonical workspace paths even for an alias terminal", async () => {
  const launcher = new WorkerLauncher({
    env: {},
    canonical: async (p) => (p === "/alias" ? "/repo" : p),
    read: async (args) =>
      args.includes("run-show")
        ? { run: { id: target.run, coordinator_handle: target.terminal } }
        : {
            terminal: {
              handle: target.terminal,
              worktreeId: "repo::/alias",
              worktreePath: "/alias",
              executionHostId: "local",
              connected: true,
              incarnationId: "test",
            },
          },
  });
  const p = await launcher.prepare(target, edit, "/repo");
  assert.equal(p.workspacePath, "/repo");
  assert.ok(p.brief.includes("Workspace: /repo"));
  assert.equal(validPlan(p), true);
});

test("record validation cannot silently downgrade malformed edit permissions", async () => {
  const p = await prepared();
  for (const extra of [
    { brief: "EDIT assignment. Change files." },
    { mode: "unknown" },
    { mode: "edit" },
    { files: ["file.ts"] },
    { mode: "read-only", files: ["file.ts"] },
  ])
    assert.equal(validPlan({ ...p, ...extra }), false);
});

test("final brief overflow fails during prepare rather than after journaling", async () => {
  const workspace = "/" + Array(20).fill("w".repeat(190)).join("/");
  const launcher = new WorkerLauncher({
    env: {},
    canonical: async (p) => p,
    read: async (args) =>
      args.includes("run-show")
        ? { run: { id: target.run, coordinator_handle: target.terminal } }
        : {
            terminal: {
              handle: target.terminal,
              worktreeId: `repo::${workspace}`,
              worktreePath: workspace,
              executionHostId: "local",
              connected: true,
              incarnationId: "test",
            },
          },
  });
  await assert.rejects(
    launcher.prepare(target, { ...input, spec: "x".repeat(32768) }, workspace),
  );
  const files = Array.from({ length: 32 }, (_, i) => `${i}-${"x".repeat(115)}`);
  await assert.rejects(
    launcher.prepare(
      target,
      { ...edit, spec: "x".repeat(32768), files },
      workspace,
    ),
  );
});

test("edit journal v2 blocks downgrade readers while read-only v1 stays compatible", async () => {
  const p = await prepared(edit);
  const record = entry(2, p);
  assert.equal(readLaunchJournal([record]).get(p.requestId).version, 2);
  assert.throws(() => legacyReader([record]));
  assert.throws(() => readLaunchJournal([entry(1, p)]));
  const read = await prepared();
  assert.equal(
    readLaunchJournal([entry(1, read)]).get(read.requestId).version,
    1,
  );
  assert.equal(legacyReader([entry(1, read)]).get(read.requestId).version, 1);
  assert.throws(() => readLaunchJournal([entry(2, read)]));
});

test("new SDK tool schema exposes opt-in edit scope without changing tool names", () => {
  const tools = new Map();
  createExtension(
    {},
    {},
  )({
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  const schema = tools.get("orca_worker_start").parameters;
  assert.deepEqual(schema.properties.mode.enum, ["read-only", "edit"]);
  assert.equal(schema.properties.files.type, "array");
  assert.equal(schema.properties.files.items.type, "string");
  assert.equal(schema.properties.files.minItems, 1);
  assert.equal(schema.properties.files.maxItems, 32);
  assert.equal(schema.additionalProperties, false);
});

test("an injected prepare cannot silently drop edit permissions before recording", async () => {
  const p = { ...(await prepared()), requestId: randomUUID() };
  const tools = new Map(),
    commands = new Map(),
    records = [];
  let submits = 0;
  const ctx = {
    cwd: "/repo",
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => "/session.jsonl",
      getEntries: () => records,
    },
  };
  createExtension(
    { verify: async () => {}, peek: async () => new Promise(() => {}) },
    {},
    {
      prepare: async () => p,
      validateEdits: async () => {},
      submit: async () => {
        submits++;
        return {
          status: "ready",
          requestId: p.requestId,
          runId: target.run,
          taskId: "task_test",
          dispatchId: "ctx_test",
        };
      },
      inspect: async () => {},
    },
  )({
    on() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType, data) {
      records.push({ type: "custom", customType, data });
    },
    sendMessage() {},
  });
  await commands.get("orca-watch").handler("attach run_test term_owned", ctx);
  const result = await tools
    .get("orca_worker_start")
    .execute("test", edit, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(submits, 0);
  assert.equal(records.length, 0);
  await commands.get("orca-watch").handler("stop", ctx);
});
