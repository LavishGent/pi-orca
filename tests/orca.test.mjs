import assert from "node:assert/strict";
import test from "node:test";
import { OrcaClient, runJson, commandText } from "../src/orca.ts";

const target = { run: "run_test", terminal: "term_owned" };
const row = {
  id: "msg_test",
  run_id: target.run,
  to_handle: `run:${target.run}`,
  type: "worker_done",
};

function clientFor(responses) {
  const calls = [];
  const client = new OrcaClient(async (args) => {
    calls.push(args);
    const response = responses.shift();
    if (!response) throw new Error("Unexpected call");
    return response;
  });
  return { client, calls };
}

test("recovery commands use the selected executable and quote shell metacharacters", () => {
  assert.equal(
    commandText(["skills", "get", "orchestration"], {}, "linux"),
    "orca-ide skills get orchestration",
  );
  assert.equal(
    commandText(["status"], { ORCA_DEV_REPO_ROOT: "/development" }, "darwin"),
    "orca-dev status",
  );
  const binary = "/trusted/bin/custom ' $(not-a-command)";
  const text = commandText(["status"], { ORCA_CLI_COMMAND: binary }, "darwin");
  assert.ok(text.startsWith("'/trusted/bin/custom "));
  assert.ok(text.includes("'\\''"));
  assert.ok(text.endsWith("' status"));
});

test("verifies the declared owner instead of inferring one from cwd", async () => {
  const { client, calls } = clientFor([
    { run: { id: target.run, coordinator_handle: target.terminal } },
  ]);
  await client.verify(target);
  assert.deepEqual(calls[0], [
    "orchestration",
    "run-show",
    "--id",
    target.run,
    "--full",
    "--json",
  ]);
});

test("refuses a mailbox owned by a different terminal", async () => {
  const { client } = clientFor([
    { run: { id: target.run, coordinator_handle: "term_other" } },
  ]);
  await assert.rejects(client.verify(target), /ownership/i);
});

test("peek uses explicit identity and never consumes or acknowledges", async () => {
  const { client, calls } = clientFor([
    { runId: target.run, messages: [row], acknowledged: null },
  ]);
  assert.deepEqual(await client.peek(target), [{ id: row.id, type: row.type }]);
  const args = calls[0];
  for (const flag of ["--peek", "--wait", "--full", "--json"])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--terminal") + 1], target.terminal);
  assert.equal(args[args.indexOf("--run") + 1], target.run);
  for (const flag of ["--ack", "--unread", "--inject"])
    assert.ok(!args.includes(flag));
});

test("rejects legacy, acknowledged, wrong-run, and malformed responses", async () => {
  const invalid = [
    {
      runId: target.run,
      messages: [row],
      legacyCompatibility: { readOnly: true },
    },
    { runId: target.run, messages: [row], acknowledged: true },
    { runId: "run_other", messages: [row] },
    { runId: target.run, messages: [{ ...row, run_id: "run_other" }] },
    { runId: target.run, messages: [{ ...row, to_handle: "run:run_other" }] },
    { runId: target.run, messages: [{ type: "worker_done" }] },
    { runId: target.run, messages: [], connectionLost: true },
    { messages: "invalid" },
  ];
  for (const response of invalid) {
    const { client } = clientFor([response]);
    await assert.rejects(client.peek(target));
  }
});

test("ignores progress and heartbeat messages", async () => {
  const { client } = clientFor([
    { runId: target.run, messages: [{ ...row, type: "heartbeat" }] },
  ]);
  assert.deepEqual(await client.peek(target), []);
});

test("invalid identifiers never reach the process runner", async () => {
  const { client, calls } = clientFor([]);
  await assert.rejects(client.verify({ ...target, run: "run_x; echo unsafe" }));
  assert.equal(calls.length, 0);
});

test("process runner parses JSON and does not use a shell", async () => {
  const result = await runJson(process.execPath, [
    "-e",
    "console.log(JSON.stringify({ok:true,result:{value:7}}))",
  ]);
  assert.deepEqual(result, { value: 7 });
});

test("process failures do not expose raw provider output", async () => {
  await assert.rejects(
    runJson(process.execPath, [
      "-e",
      'console.log("SYNTHETIC_SECRET"); process.exit(1)',
    ]),
    (error) => !error.message.includes("SYNTHETIC_SECRET"),
  );
});

test("bounds output and execution time", async () => {
  await assert.rejects(
    runJson(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(10000))'],
      { maxBytes: 100 },
    ),
    /limit/,
  );
  await assert.rejects(
    runJson(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 30,
    }),
    /deadline/,
  );
});

test("cancellation stops an in-flight process", async () => {
  const controller = new AbortController();
  const result = runJson(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(result, /cancel/i);
});

test("read cancellation settles when a descendant retains output pipes", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-read-pipe-"));
  const pidFile = join(dir, "descendant.pid");
  const controller = new AbortController();
  const started = Date.now();
  const cancel = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(
      runJson(
        process.execPath,
        [
          "-e",
          `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore',1,2]}); writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`,
          pidFile,
        ],
        { signal: controller.signal },
      ),
      /cancel/,
    );
    assert.ok(
      Date.now() - started < 3000,
      "cancellation must not wait for descendant pipe closure",
    );
  } finally {
    clearTimeout(cancel);
    try {
      process.kill(Number(await readFile(pidFile, "utf8")), "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("foreground read verifies ownership and consumes only the attached run", async () => {
  const { client, calls } = clientFor([
    { run: { id: target.run, coordinator_handle: target.terminal } },
    {
      runId: target.run,
      messages: [{ ...row, body: "worker evidence" }],
      deliveryAcknowledged: true,
    },
  ]);
  const result = await client.read(target);
  assert.equal(result.messages[0].body, "worker evidence");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("run-show"));
  const args = calls[1];
  assert.equal(args[args.indexOf("--terminal") + 1], target.terminal);
  for (const flag of ["--peek", "--wait", "--ack"])
    assert.ok(!args.includes(flag));
});

test("foreground read rejects unsupported acknowledgment and never retries", async () => {
  const { client, calls } = clientFor([
    { run: { id: target.run, coordinator_handle: target.terminal } },
    { runId: target.run, messages: [row], deliveryAcknowledged: false },
  ]);
  await assert.rejects(client.read(target), /acknowledg/i);
  assert.equal(calls.length, 2);
});

test("ownership changes block consumption before check is invoked", async () => {
  const { client, calls } = clientFor([
    { run: { id: target.run, coordinator_handle: "term_other" } },
  ]);
  await assert.rejects(client.read(target), /ownership/i);
  assert.equal(calls.length, 1);
});
