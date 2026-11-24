import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, access, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createExtension } from "../src/index.ts";
import { join } from "node:path";
import {
  CoordinatorClient,
  registerInventoryTool,
} from "../src/coordinator.ts";

const row = {
  id: "opencode",
  cli: "opencode",
  installed: true,
  billingPool: "metered",
  modelHint: "fireworks-ai/accounts/fireworks/routers/glm-latest",
  nativeAgentHint: null,
  effortHint: { kind: "none", levels: [] },
  authStatus: "unchecked",
  capacityStatus: "unknown",
  catalogStatus: "unchecked",
};
const body = () => ({
  schema: "coordinator.harnesses.v1",
  scope: "registry-hints",
  harnesses: [structuredClone(row)],
});

test("inventory uses a fixed isolated CLI operation, not repository config or launch strings", async () => {
  const calls = [];
  const client = new CoordinatorClient({
    env: { PI_ORCA_COORDINATOR_SCRIPT: "/approved/harnesses.py" },
    run: async (...args) => {
      calls.push(args);
      return body();
    },
  });
  const result = await client.inspect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/python3");
  assert.deepEqual(calls[0][1], [
    "-I",
    "/approved/harnesses.py",
    "inspect",
    "--schema",
    "coordinator.harnesses.v1",
  ]);
  assert.deepEqual(result, body());
});

test("default helper matches the documented checkout regardless of XDG_DATA_HOME", async () => {
  for (const value of [
    undefined,
    "/another-data-root",
    "",
    "./relative-data",
  ]) {
    const calls = [];
    const client = new CoordinatorClient({
      env: value === undefined ? {} : { XDG_DATA_HOME: value },
      run: async (...args) => {
        calls.push(args);
        return body();
      },
    });
    await client.inspect();
    assert.equal(
      calls[0][1][1],
      join(
        homedir(),
        ".local",
        "share",
        "coordinator",
        "scripts",
        "harnesses.py",
      ),
    );
  }
});

test("extension inventory uses its injected environment without attachment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-env-"));
  try {
    const expected = {
      ...body(),
      harnesses: [{ ...row, id: "from-injected-env" }],
    };
    const script = join(dir, "harnesses.py");
    await writeFile(
      script,
      `import json\nprint(json.dumps(json.loads(${JSON.stringify(JSON.stringify({ ok: true, result: expected }))})))\n`,
    );
    const tools = new Map();
    createExtension(
      {},
      {
        ...process.env,
        PI_ORCA_COORDINATOR_SCRIPT: script,
        PI_ORCA_PYTHON: "/usr/bin/python3",
      },
    )({
      on() {},
      registerCommand() {},
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    });
    const result = await tools
      .get("orca_harnesses")
      .execute("test", {}, undefined, undefined, {});
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.details, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown schemas, duplicate IDs and false readiness claims fail closed without fallback", async () => {
  const invalid = [
    { ...body(), schema: "future" },
    { ...body(), harnesses: [row, row] },
    { ...body(), harnesses: [{ ...row, authStatus: "ready" }] },
    { ...body(), harnesses: [{ ...row, capacityStatus: "fresh" }] },
    { ...body(), harnesses: [{ ...row, catalogStatus: "verified" }] },
    { ...body(), harnesses: [{ ...row, installed: "yes" }] },
  ];
  for (const response of invalid) {
    let calls = 0;
    const c = new CoordinatorClient({
      env: { PI_ORCA_COORDINATOR_SCRIPT: "/approved/harnesses.py" },
      run: async () => {
        calls++;
        return response;
      },
    });
    await assert.rejects(c.inspect());
    assert.equal(calls, 1);
  }
});

test("extra fields are omitted instead of leaking command or credential data", async () => {
  const c = new CoordinatorClient({
    env: { PI_ORCA_COORDINATOR_SCRIPT: "/approved/harnesses.py" },
    run: async () => ({
      ...body(),
      secret: "SYNTHETIC_SECRET",
      harnesses: [{ ...row, launchCommand: "SYNTHETIC_SECRET" }],
    }),
  });
  assert.ok(!JSON.stringify(await c.inspect()).includes("SYNTHETIC_SECRET"));
});

test("relative helper and interpreter paths are refused before execution", async () => {
  for (const env of [
    { PI_ORCA_COORDINATOR_SCRIPT: "./scripts/harnesses.py" },
    {
      PI_ORCA_COORDINATOR_SCRIPT: "/approved/harnesses.py",
      PI_ORCA_PYTHON: "python3",
    },
    {
      PI_ORCA_COORDINATOR_SCRIPT: "/approved/harnesses.py",
      PI_ORCA_PYTHON: "../python3",
    },
  ]) {
    let calls = 0;
    const c = new CoordinatorClient({
      env,
      run: async () => {
        calls++;
        return body();
      },
    });
    await assert.rejects(c.inspect());
    assert.equal(calls, 0);
  }
});

test("the actual interpreter ignores Python startup code from an untrusted path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-inventory-"));
  try {
    const marker = join(dir, "executed");
    await writeFile(
      join(dir, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("bad")\n`,
    );
    const script = join(dir, "harnesses.py");
    // The fixture crosses the same JSON boundary as the real helper.
    await writeFile(
      script,
      `import json\nprint(json.dumps(json.loads(${JSON.stringify(JSON.stringify({ ok: true, result: body() }))})))\n`,
    );
    await writeFile(join(dir, "python3"), "#!/bin/sh\nexit 99\n");
    await chmod(join(dir, "python3"), 0o700);
    const c = new CoordinatorClient({
      env: {
        ...process.env,
        PI_ORCA_COORDINATOR_SCRIPT: script,
        PYTHONPATH: dir,
        PATH: `${dir}:${process.env.PATH}`,
      },
    });
    assert.equal((await c.inspect()).harnesses[0].id, "opencode");
    await assert.rejects(access(marker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inventory tool is callable without attachment and sanitizes failures", async () => {
  let tool;
  registerInventoryTool(
    {
      registerTool: (value) => {
        tool = value;
      },
    },
    {
      inspect: async () => {
        throw new Error("SYNTHETIC_SECRET");
      },
    },
  );
  assert.equal(tool.name, "orca_harnesses");
  const result = await tool.execute("call", {}, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_SECRET"));
});
