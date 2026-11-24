import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  publicFiles,
  auditText,
  auditPublic,
  auditTrackedFiles,
} from "../scripts/public-files.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
test("public allowlist excludes local plans, installed dependencies and state", () => {
  const files = publicFiles(root);
  assert.ok(files.includes("src/index.ts"));
  assert.ok(files.includes("skills/pi-orca/SKILL.md"));
  assert.ok(
    !files.some((f) =>
      /PLAN\.md$|node_modules|\.env|orca-mailboxes|\.jsonl$/.test(f),
    ),
  );
});
test("public audit detects sensitive content without echoing it", () => {
  for (const text of [
    "gh" + "p_" + "a".repeat(40),
    ["", "Users", "someone", "private"].join("/"),
    "-----BEGIN " + "PRIVATE KEY-----",
    "run_" + "a".repeat(12),
  ]) {
    assert.throws(
      () => auditText(text, "fixture"),
      (error) =>
        error.message.includes("fixture") && !error.message.includes(text),
    );
  }
});
test("tracked extras cannot bypass the public allowlist", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-public-index-"));
  try {
    execFileSync("/usr/bin/git", ["init", "--initial-branch=main", dir], {
      stdio: "ignore",
    });
    await writeFile(join(dir, "unexpected.txt"), "synthetic fixture");
    execFileSync("/usr/bin/git", ["-C", dir, "add", "--", "unexpected.txt"]);
    assert.throws(() => auditTrackedFiles(dir, []), /Unapproved tracked file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all intended public files pass the content audit", () => {
  assert.ok(auditPublic(root).length > 20);
});
