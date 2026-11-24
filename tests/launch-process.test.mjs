import assert from "node:assert/strict";
import test from "node:test";
import { runMutation, localEnvironment } from "../src/launch-process.ts";

test("mutation runner sends brief on stdin and preserves nonzero JSON receipts", async () => {
  const result = await runMutation(
    process.execPath,
    [
      "-e",
      `let text=''; process.stdin.on('data',x=>text+=x); process.stdin.on('end',()=>{console.log(JSON.stringify({ok:false,error:{code:'fixture',received:text}}));process.exitCode=1;});`,
    ],
    "brief with $() and quotes",
  );
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error.received, "brief with $() and quotes");
});

test("mutation runner reports uncertainty without exposing invalid output", async () => {
  const bad = await runMutation(
    process.execPath,
    ["-e", `console.log('SYNTHETIC_SECRET')`],
    "brief",
  );
  assert.equal(bad.problem, "invalid_json");
  assert.ok(!JSON.stringify(bad).includes("SYNTHETIC_SECRET"));
  const large = await runMutation(
    process.execPath,
    [
      "-e",
      `process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000);`,
    ],
    "brief",
    { maxBytes: 100 },
  );
  assert.equal(large.problem, "output_limit");
  const timeout = await runMutation(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    "brief",
    { timeoutMs: 30 },
  );
  assert.equal(timeout.problem, "deadline");
});

test("mutation deadline settles even when a descendant retains the output pipes", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-pipe-deadline-"));
  const pidFile = join(dir, "descendant.pid");
  try {
    const started = Date.now();
    const result = await runMutation(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore',1,2]}); writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`,
        pidFile,
      ],
      "",
      { timeoutMs: 200 },
    );
    assert.equal(result.problem, "deadline");
    assert.ok(
      Date.now() - started < 3000,
      "deadline must not wait for descendant pipe closure",
    );
  } finally {
    try {
      process.kill(Number(await readFile(pidFile, "utf8")), "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutation runner scrubs remote and injected identities from child environment", () => {
  const env = localEnvironment({
    PATH: "/bin",
    ORCA_ENVIRONMENT: "remote",
    ORCA_PAIRING_CODE: "secret",
    ORCA_AGENT_SESSION_ID: "other",
    ORCA_TERMINAL_HANDLE: "term_other",
    ORCA_PANE_KEY: "pane",
    ORCA_WORKTREE_ID: "other",
    ORCA_WORKSPACE_ID: "other",
    ORCA_CLI_CWD: "/other",
    ORCA_USER_DATA_PATH: "/other",
  });
  assert.equal(env.PATH, "/bin");
  for (const key of Object.keys(env))
    assert.ok(
      ![
        "ORCA_ENVIRONMENT",
        "ORCA_PAIRING_CODE",
        "ORCA_AGENT_SESSION_ID",
        "ORCA_TERMINAL_HANDLE",
        "ORCA_PANE_KEY",
        "ORCA_WORKTREE_ID",
        "ORCA_WORKSPACE_ID",
        "ORCA_CLI_CWD",
        "ORCA_USER_DATA_PATH",
      ].includes(key),
    );
});

test("a missing executable is reported as an uncertain spawn failure", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-missing-"));
  try {
    assert.equal(
      (await runMutation(join(dir, "missing-binary"), [], "brief")).problem,
      "spawn_failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a child closing stdin is reported without hanging or retrying", async () => {
  const outcome = await runMutation(
    process.execPath,
    ["-e", "require('node:fs').closeSync(0); setInterval(()=>{},1000);"],
    "x".repeat(2 * 1024 * 1024),
    { timeoutMs: 5000 },
  );
  assert.equal(outcome.problem, "stdin_closed");
});
