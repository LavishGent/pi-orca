import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
test("onboarding packages its standalone script and independently usable setup skill", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.ok(pkg.files.includes("scripts/doctor.mjs"));
  const skill = await read("skills/pi-orca-setup/SKILL.md");
  assert.match(skill, /name: pi-orca-setup/);
  assert.match(skill, /orca_doctor/);
  assert.match(skill, /Ask before/i);
  assert.match(skill, /multiple\s+billable/i);
  assert.doesNotMatch(
    skill,
    /gcloud|truffle-dev-keys|coordinator\.json|\.ruler\//,
  );
  assert.match(skill, /first usable/i);
  assert.match(skill, /already accepted/i);
  assert.match(skill, /orca_inbox[\s\S]*task\/dispatch/);
  assert.match(skill, /native.*worker_done/);
});
test("quickstart distinguishes candidate checks, metadata reads, consent and manual prerequisites", async () => {
  const readme = await read("README.md");
  for (const text of [
    "/orca-doctor codex",
    "/skill:pi-orca-setup",
    "scripts/doctor.mjs",
    "multiple billable",
    "nodejs.org",
    "pi.dev",
    "onorca.dev",
    "cursor.com",
    "opencode.ai",
    "developers.openai.com",
    "code.claude.com",
  ])
    assert.ok(readme.includes(text), text);
  assert.match(readme, /does not execute Pi or worker CLIs/i);
  assert.match(readme, /first usable/i);
  assert.match(readme, /already accepted/i);
  assert.match(
    readme,
    /metadata.*CLI.*(?:cache|logging)|CLI.*(?:cache|logging)/i,
  );
});
