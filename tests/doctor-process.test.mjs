import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  access,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readGitMetadata } from "../src/doctor-process.ts";
import { gitFixture } from "./git-fixture.mjs";
const script = resolve("scripts/doctor.mjs");
test("bounded text probes sanitize errors, nonzero output and output limits", async () => {
  const ctx = { cwd: process.cwd(), env: {}, timeoutMs: 100, maxBytes: 128 };
  assert.equal(
    await readGitMetadata(
      process.execPath,
      ["-e", 'process.stdout.write("root")'],
      { ...ctx, timeoutMs: 1000 },
    ),
    "root",
  );
  for (const code of [
    'process.stderr.write("private-value");process.exit(2)',
    'process.stdout.write("a".repeat(10000))',
    "setInterval(()=>{},1000)",
  ]) {
    await assert.rejects(
      readGitMetadata(process.execPath, ["-e", code], ctx),
      (error) => !error.message.includes("private-value"),
    );
  }
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    readGitMetadata(process.execPath, [], { ...ctx, signal: c.signal }),
  );
});
test("text probe deadline settles despite descendant-held output pipes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-doctor-pipe-"));
  const file = join(dir, "pid");
  try {
    const started = Date.now();
    const code = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});require('node:fs').writeFileSync(${JSON.stringify(file)},String(p.pid));setInterval(()=>{},1000);`;
    await assert.rejects(
      readGitMetadata(process.execPath, ["-e", code], {
        cwd: dir,
        env: {},
        timeoutMs: 200,
      }),
    );
    assert.ok(Date.now() - started < 4000);
  } finally {
    try {
      const pid = Number(await readFile(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
test("standalone help and invalid args perform zero executable discovery/probes", () => {
  const env = {
    ...process.env,
    ORCA_CLI_COMMAND: "/not-an-executable",
    ORCA_TERMINAL_HANDLE: "managed",
  };
  const help = spawnSync(process.execPath, [script, "--help"], {
    env,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /No model requests/);
  for (const args of [
    ["--bad"],
    ["--agent", "not-supported"],
    ["--agent"],
    ["--json", "--json"],
  ]) {
    const out = spawnSync(process.execPath, [script, ...args], {
      env,
      encoding: "utf8",
    });
    assert.equal(out.status, 2);
    assert.doesNotMatch(out.stderr, /ERR_MODULE|stack|managed/);
  }
});
test("executable candidates are never run; standalone metadata and JSON work with synthetic Orca", () =>
  gitFixture(async ({ root, env }) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    const marker = join(root, "executed");
    for (const name of ["pi", "codex"])
      await writeFile(
        join(bin, name),
        `#!/bin/sh\necho unsafe > ${JSON.stringify(marker)}\n`,
        { mode: 0o700 },
      );
    const cli = join(bin, "orca-fixture");
    await writeFile(
      cli,
      `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['worktree','show','--worktree',${JSON.stringify("path:" + root)},'--json','--environment','local']))process.exit(2);console.log(JSON.stringify({ok:true,result:{worktree:{id:${JSON.stringify("fixture::" + root)},path:${JSON.stringify(root)},identity:{executionHostId:'local'}}}}));\n`,
      { mode: 0o700 },
    );
    const childEnv = {
      ...env,
      PATH: bin + ":/usr/bin:/bin",
      ORCA_CLI_COMMAND: cli,
    };
    const out = spawnSync(
      process.execPath,
      [script, "--agent", "codex", "--json"],
      { cwd: root, env: childEnv, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(out.status, 0, out.stderr);
    const report = JSON.parse(out.stdout);
    assert.equal(report.status, "live-test-required");
    assert.ok(!out.stdout.includes(root));
    await assert.rejects(access(marker));
    const text = spawnSync(process.execPath, [script, "--agent", "codex"], {
      cwd: root,
      env: childEnv,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(text.status, 0);
    assert.ok(text.stdout.includes(report.status));
    await assert.rejects(access(marker));
  }));

test("standalone node_modules layout fails with actionable Git/Pi guidance", async () => {
  const { cp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pi-orca-layout-"));
  try {
    const pkg = join(root, "node_modules", "pi-orca");
    await mkdir(join(pkg, "scripts"), { recursive: true });
    await cp(script, join(pkg, "scripts", "doctor.mjs"));
    await cp(new URL("../src/", import.meta.url), join(pkg, "src"), {
      recursive: true,
    });
    const out = spawnSync(
      process.execPath,
      [join(pkg, "scripts", "doctor.mjs"), "--json"],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /outside node_modules/);
    assert.match(out.stderr, /orca-doctor/);
    assert.doesNotMatch(out.stderr, /ERR_UNSUPPORTED|stack/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
