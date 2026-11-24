import assert from "node:assert/strict";
import test from "node:test";
import { registerDoctorTools } from "../src/doctor-tools.ts";
import { createExtension } from "../src/index.ts";
const report = {
  schema: "pi-orca.doctor.v1",
  status: "live-test-required",
  checks: [],
};
test("tool and command share diagnostics and reject identity/command overrides before probing", async () => {
  const tools = new Map(),
    commands = new Map(),
    calls = [],
    notices = [];
  registerDoctorTools(
    {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (n, c) => commands.set(n, c),
    },
    { PATH: "/trusted" },
    async (...args) => {
      calls.push(args);
      return report;
    },
  );
  const ctx = {
    cwd: "/workspace",
    ui: { notify: (...args) => notices.push(args) },
  };
  const tool = tools.get("orca_doctor");
  assert.ok(tool);
  assert.equal(tool.parameters.additionalProperties, false);
  const value = await tool.execute(
    "call",
    { agent: "codex" },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(value.details, report);
  assert.equal(calls[0][0], ctx.cwd);
  assert.equal(calls[0][2].env.PATH, "/trusted");
  await commands.get("orca-doctor").handler("claude", ctx);
  assert.equal(calls.length, 2);
  assert.equal(notices.length, 1);
  for (const params of [{ command: "bad" }, { agent: "unknown" }, null])
    await tool.execute("bad", params, undefined, undefined, ctx);
  await commands.get("orca-doctor").handler("codex --anything", ctx);
  assert.equal(calls.length, 2);
});
test("diagnostic registration/loading never uses launch or mailbox APIs", () => {
  const tools = new Map(),
    commands = new Map();
  let calls = 0;
  const forbidden = () => {
    calls++;
    throw new Error("Unexpected lifecycle access");
  };
  createExtension(
    { verify: forbidden, peek: forbidden, read: forbidden },
    {},
    { prepare: forbidden, submit: forbidden, inspect: forbidden },
  )({
    on() {},
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (n, c) => commands.set(n, c),
  });
  assert.ok(tools.has("orca_doctor"));
  assert.ok(commands.has("orca-doctor"));
  assert.equal(calls, 0);
});
