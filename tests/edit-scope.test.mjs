import assert from "node:assert/strict";
import test from "node:test";
import {
  writeFile,
  readFile,
  mkdir,
  unlink,
  symlink,
  link,
  chmod,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { checkEditScope } from "../src/edit-scope.ts";
import { gitFixture as fixture } from "./git-fixture.mjs";

const check = (root, files, options) => checkEditScope(root, files, options);

test("allows clean tracked files and genuinely new files despite unrelated user changes", () =>
  fixture(async ({ root }) => {
    await writeFile(join(root, "other.ts"), "user work\n");
    await writeFile(join(root, "ignored.txt"), "user secret fixture\n");
    await check(root, ["a.ts", "new/file.ts"]);
    assert.equal(await readFile(join(root, "other.ts"), "utf8"), "user work\n");
  }));

for (const kind of [
  "dirty",
  "staged",
  "deleted",
  "staged-deleted",
  "untracked",
  "ignored",
  "intent",
  "skip",
  "assume",
  "mode",
]) {
  test(`rejects scoped ${kind} user state`, () =>
    fixture(async ({ root, git }) => {
      let path = "a.ts";
      if (kind === "dirty" || kind === "staged") {
        await writeFile(join(root, path), "user changes\n");
        if (kind === "staged") git(["add", "--", path]);
      }
      if (kind === "deleted") await unlink(join(root, path));
      if (kind === "staged-deleted") git(["rm", "-q", "--", path]);
      if (kind === "untracked" || kind === "ignored" || kind === "intent") {
        path = kind === "ignored" ? "ignored.txt" : "untracked.ts";
        await writeFile(join(root, path), "user work\n");
        if (kind === "intent") git(["add", "-N", "--", path]);
      }
      if (kind === "skip") git(["update-index", "--skip-worktree", "--", path]);
      if (kind === "assume")
        git(["update-index", "--assume-unchanged", "--", path]);
      if (kind === "mode") {
        git(["config", "core.fileMode", "false"]);
        await chmod(join(root, path), 0o755);
      }
      await assert.rejects(check(root, [path]));
    }));
}

test("rejects conflict stages and gitlink ancestors", () =>
  fixture(async ({ root, git }) => {
    const blob = git(["rev-parse", "HEAD:a.ts"]).trim();
    git(
      ["update-index", "--index-info"],
      `0 ${"0".repeat(40)}\ta.ts\n100644 ${blob} 1\ta.ts\n100644 ${blob} 2\ta.ts\n100644 ${blob} 3\ta.ts\n`,
    );
    await assert.rejects(check(root, ["a.ts"]));
    const commit = git(["rev-parse", "HEAD"]).trim();
    git(["update-index", "--add", "--cacheinfo", `160000,${commit},module`]);
    await assert.rejects(check(root, ["module/new.ts"]));
  }));

test("missing sparse directories cannot be claimed as new regular files", () =>
  fixture(async ({ root, git }) => {
    await mkdir(join(root, "src", "foo"), { recursive: true });
    await writeFile(join(root, "src", "foo", "tracked.ts"), "tracked\n");
    git(["add", "--", "src/foo/tracked.ts"]);
    git(["commit", "-qm", "private sparse fixture"]);
    git(["sparse-checkout", "init", "--cone"]);
    await assert.rejects(readFile(join(root, "src", "foo", "tracked.ts")));
    await assert.rejects(check(root, ["src/foo"]));
  }));

test("invisible characters in tracked metadata cannot disguise a new-file alias", () =>
  fixture(async ({ root, git }) => {
    const hidden = "a\u200cb.ts";
    await writeFile(join(root, hidden), "tracked\n");
    git(["add", "--", hidden]);
    git(["commit", "-qm", "private invisible-name fixture"]);
    await unlink(join(root, hidden));
    await assert.rejects(check(root, ["ab.ts"]));
  }));

test("rejects symlink ancestors, symlink leaves, directories and case aliases", () =>
  fixture(async ({ root }) => {
    await mkdir(join(root, "directory"));
    await symlink(join(root, "directory"), join(root, "link"));
    for (const files of [["link/new.ts"], ["link"], ["directory"], ["A.ts"]])
      await assert.rejects(check(root, files));
  }));

test("hard links cannot carry an edit outside the named file", () =>
  fixture(async ({ root }) => {
    await link(join(root, "a.ts"), join(root, "another-link.ts"));
    await assert.rejects(check(root, ["a.ts"]));
  }));

test("Git plumbing executes neither conversion filters nor repo-local fsmonitor", () =>
  fixture(async ({ root, git }) => {
    const marker = join(root, "executed");
    const script = join(root, "sentinel.cjs");
    await writeFile(
      script,
      `require('fs').writeFileSync(${JSON.stringify(marker)},'bad');process.stdout.write(require('fs').readFileSync(0));`,
    );
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    const command = quote(process.execPath) + " " + quote(script);
    git(["config", "filter.probe.clean", command]);
    git(["config", "filter.probe.process", command]);
    await writeFile(join(root, ".gitattributes"), "a.ts filter=probe\n");
    git(["config", "core.fsmonitor", command]);
    await check(root, ["a.ts"]);
    await assert.rejects(readFile(marker));
    await writeFile(join(root, "a.ts"), "export const a = 2;\n");
    await assert.rejects(check(root, ["a.ts"]));
    await assert.rejects(readFile(marker));
  }));

test("literal leading-dash files cannot inject hash-object write options", () =>
  fixture(async ({ root, git }) => {
    await writeFile(join(root, "-w"), "literal file\n");
    git(["add", "--", "-w"]);
    git(["commit", "-qm", "private dash fixture"]);
    async function objects() {
      const base = join(root, ".git", "objects");
      const out = [];
      for (const dir of await readdir(base)) {
        if (!/^[0-9a-f]{2}$/.test(dir)) continue;
        for (const file of await readdir(join(base, dir)))
          out.push(dir + "/" + file);
      }
      return out.sort();
    }
    const before = await objects();
    await check(root, ["-w", "a.ts"]);
    assert.deepEqual(await objects(), before);
  }));

test("raw CRLF conversion mismatches fail closed", () =>
  fixture(async ({ root }) => {
    await writeFile(join(root, "a.ts"), "export const a = 1;\r\n");
    await assert.rejects(check(root, ["a.ts"]));
  }));

test("missing partial-clone objects cannot invoke remote transport helpers", () =>
  fixture(async ({ root, git }) => {
    const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
    const marker = join(root, "transport-ran");
    const script = join(root, "ssh.cjs");
    await writeFile(
      script,
      `require('fs').writeFileSync(${JSON.stringify(marker)},'bad');process.exit(1);`,
    );
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    git(["config", "remote.origin.url", "ssh://fixture.invalid/repo"]);
    git(["config", "remote.origin.promisor", "true"]);
    git(["config", "extensions.partialClone", "origin"]);
    git([
      "config",
      "core.sshCommand",
      quote(process.execPath) + " " + quote(script),
    ]);
    await unlink(
      join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2)),
    );
    await assert.rejects(check(root, ["a.ts"]));
    await assert.rejects(readFile(marker));
  }));

test("repository-wide metadata exceeding the configured bound fails closed", () =>
  fixture(async ({ root, git }) => {
    const names = Array.from({ length: 100 }, (_, i) => `metadata-${i}.txt`);
    await Promise.all(
      names.map((name) => writeFile(join(root, name), "fixture\n")),
    );
    git(["add", "--", ...names]);
    await assert.rejects(
      check(root, ["a.ts"], { maxBytes: Buffer.byteLength(root) + 128 }),
      (error) => error.message.includes("limits"),
    );
  }));

test("Git process errors, output caps and deadlines never echo raw output", () =>
  fixture(async ({ root }) => {
    const script = join(root, "fake-git");
    const run = async (source, options) => {
      await writeFile(script, `#!${process.execPath}\n${source}\n`);
      await chmod(script, 0o700);
      await assert.rejects(
        check(root, ["a.ts"], { git: script, ...options }),
        (error) => !error.message.includes("SYNTHETIC_SECRET"),
      );
    };
    await run("process.stderr.write('SYNTHETIC_SECRET');process.exit(1)");
    await run("process.stdout.write('x'.repeat(10000))", { maxBytes: 128 });
    await run("setTimeout(()=>{},10000)", { timeoutMs: 30 });
  }));
