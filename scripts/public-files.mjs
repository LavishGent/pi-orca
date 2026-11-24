import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

export const publicRoots = [
  ".gitignore",
  ".github",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "src",
  "tests",
  "scripts",
  "skills",
];
export function publicFiles(root) {
  const files = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error(
        `Public resources cannot be symlinks: ${relative(root, path)}`,
      );
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (stat.isFile()) {
      const name = relative(root, path).split("\\").join("/");
      const allowed =
        publicRoots.includes(name) ||
        /^src\/[^/]+\.ts$/.test(name) ||
        /^tests\/(?:[^/]+\.mjs|fixtures\/[^/]+\.(?:json|ts))$/.test(name) ||
        /^scripts\/[^/]+\.mjs$/.test(name) ||
        /^skills\/[^/]+\/SKILL\.md$/.test(name) ||
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name);
      if (!allowed) throw new Error(`Unapproved public file type: ${name}`);
      files.push(name);
    } else
      throw new Error(`Unsupported public resource: ${relative(root, path)}`);
  };
  for (const entry of publicRoots) visit(join(root, entry));
  return files.sort();
}
const checks = [
  ["private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{30,}/],
  ["cloud access key", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["provider key", /sk-(?:proj-|ant-)[A-Za-z0-9_-]{24,}/],
  ["personal macOS path", /\/Users\/[A-Za-z0-9_.-]+\//],
  ["local temporary path", /\/var\/folders\/[A-Za-z0-9_./-]+/],
  [
    "real runtime identity",
    /\b(?:run|task|ctx)_[a-f0-9]{12}\b|\bterm_[a-f0-9]{8}-[a-f0-9-]{27,}\b/,
  ],
];
export function auditText(text, name) {
  for (const [label, pattern] of checks)
    if (pattern.test(text))
      throw new Error(
        `Public audit found ${label} in ${name}; inspect locally. Matched content was not printed.`,
      );
}
export function auditTrackedFiles(root, files) {
  if (!existsSync(join(root, ".git"))) return;
  const output = execFileSync("/usr/bin/git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  const allowed = new Set(files);
  for (const name of output.split("\0").filter(Boolean))
    if (!allowed.has(name)) throw new Error(`Unapproved tracked file: ${name}`);
}
export function auditPublic(root) {
  const files = publicFiles(root);
  for (const name of files)
    auditText(readFileSync(join(root, name), "utf8"), name);
  auditTrackedFiles(root, files);
  return files;
}
