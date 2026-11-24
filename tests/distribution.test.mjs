import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("GitHub Pi package declares its license, version and bundled routing skill", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, true, "npm publication is deliberately disabled");
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.equal(
    pkg.repository.url,
    "git+https://github.com/LavishGent/pi-orca.git",
  );
  assert.ok(
    pkg.files.includes("src") &&
      pkg.files.includes("skills") &&
      pkg.files.includes("LICENSE"),
  );
  assert.match(await read("LICENSE"), /Copyright \(c\) 2026 LavishGent/);
  assert.match(
    await read("LICENSE"),
    /Permission is hereby granted, free of charge/,
  );
});
test("public skill works without a separately installed personal policy", async () => {
  const skill = await read("skills/pi-orca/SKILL.md");
  assert.match(skill, /name: pi-orca/);
  assert.match(skill, /orca_worker_start/);
  assert.match(skill, /orca_inbox/);
  assert.doesNotMatch(
    skill,
    /~\/\.pi\/agent\/AGENTS|~\/\.agents\/skills|\.local\/share\/coordinator/,
  );
});
test("public README has portable install, limits and no promised sandbox", async () => {
  const text = await read("README.md");
  assert.match(text, /pi install git:github.com\/LavishGent\/pi-orca/);
  assert.match(text, /not.*sandbox/i);
  assert.match(text.replace(/\s+/g, " "), /Windows.*not supported/i);
  assert.match(text, /1\.5\.2/);
  assert.match(text, /1\.4\.255/);
});
test("CI is pinned and cannot provision live mailboxes", async () => {
  const text = await read(".github/workflows/verify.yml");
  assert.match(text, /contents: read/);
  assert.match(text, /PI_ORCA_AUTO_ATTACH: ['"]?0/);
  assert.match(text, /ubuntu-latest/);
  assert.match(text, /macos-latest/);
  const uses = [...text.matchAll(/uses:\s+([^\s#]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  assert.ok(uses.every((value) => /@[a-f0-9]{40}$/.test(value)));
  assert.match(text, /pnpm check/);
});
