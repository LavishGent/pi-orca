import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir, devNull } from "node:os";
import { join } from "node:path";

export async function gitFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-orca-scope-"));
  const root = await realpath(dir);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
  await mkdir(join(root, "hooks"));
  const git = (args, input) =>
    execFileSync(
      "/usr/bin/git",
      [
        "--no-pager",
        "-c",
        "core.hooksPath=" + join(root, "hooks"),
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        root,
        ...args,
      ],
      { env, input, encoding: "utf8", timeout: 10000 },
    );
  try {
    git(["init", "-q"]);
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "other.ts"), "other\n");
    await writeFile(join(root, ".gitignore"), "ignored.txt\nignored-dir/\n");
    git(["add", "--", "a.ts", "other.ts", ".gitignore"]);
    git(["commit", "-qm", "private fixture"]);
    await fn({ root, git, env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
