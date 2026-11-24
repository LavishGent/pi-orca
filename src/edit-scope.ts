import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export class EditSafetyError extends Error {}
const key = (value: string) =>
  value
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .normalize("NFC")
    .toLowerCase();
export function validEditFiles(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32)
    return false;
  const seen = new Set<string>();
  for (const file of value) {
    if (
      typeof file !== "string" ||
      Buffer.byteLength(file) > 512 ||
      isAbsolute(file) ||
      /^[a-z]:/i.test(file) ||
      /[\x00-\x1f\x7f\\:*?\[\]{}]/.test(file) ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u.test(file) ||
      file
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            key(part) === ".git" ||
            /~[0-9]+(?:\.|$)/i.test(part) ||
            /[. ]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(
              (part.split(".")[0] ?? "").trimEnd().normalize("NFKC"),
            ),
        ) ||
      seen.has(key(file))
    )
      return false;
    seen.add(key(file));
  }
  return Buffer.byteLength(JSON.stringify(value)) <= 4096;
}
interface Entry {
  path: string;
  mode: string;
  oid: string;
  tag?: string;
  stage?: string;
}
interface Options {
  git?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
function environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const name of [
    "HOME",
    "USER",
    "LOGNAME",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}
function parse(output: string, index: boolean): Entry[] {
  if (output !== "" && !output.endsWith("\0"))
    throw new EditSafetyError("Git metadata is incomplete.");
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = index
        ? /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t(.+)$/s.exec(
            line,
          )
        : /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/s.exec(
            line,
          );
      if (!match) throw new EditSafetyError("Git metadata is unsupported.");
      if (index) {
        const [, tag, mode, oid, stage, path] = match;
        if (!tag || !mode || !oid || !stage || !path)
          throw new EditSafetyError("Git metadata is incomplete.");
        return { tag, mode, oid, stage, path };
      }
      const [, mode, , oid, path] = match;
      if (!mode || !oid || !path)
        throw new EditSafetyError("Git metadata is incomplete.");
      return { mode, oid, path };
    });
}
function byPath(entries: Entry[]): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const entry of entries) {
    const k = key(entry.path);
    const values = out.get(k) ?? [];
    values.push(entry);
    out.set(k, values);
  }
  return out;
}
function lookup(
  entries: Map<string, Entry[]>,
  path: string,
): Entry | undefined {
  const values = entries.get(key(path)) ?? [];
  if (values.length > 1 || values.some((entry) => entry.path !== path))
    throw new EditSafetyError("Scope contains an ambiguous path or conflict.");
  return values[0];
}
async function fileState(root: string, file: string, signal?: AbortSignal) {
  let parent = root;
  const parts = file.split("/");
  for (const [i, part] of parts.entries()) {
    signal?.throwIfAborted();
    const matches = (await readdir(parent)).filter(
      (name) => key(name) === key(part),
    );
    if (matches.length > 1 || matches.some((name) => name !== part))
      throw new EditSafetyError("Scope contains a filesystem path alias.");
    if (matches.length === 0) {
      try {
        await lstat(join(parent, part));
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
      throw new EditSafetyError(
        "Scope resolves to an unlisted filesystem alias or changed during inspection.",
      );
    }
    const path = join(parent, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new EditSafetyError("Symlinks are not supported in edit scope.");
    if (i === parts.length - 1) {
      if (!stat.isFile())
        throw new EditSafetyError(
          "Edit scope must name regular files, not directories or special files.",
        );
      return stat;
    }
    if (!stat.isDirectory())
      throw new EditSafetyError("An edit path parent is not a directory.");
    parent = path;
  }
  return undefined;
}

export async function checkEditScope(
  workspace: string,
  files: readonly string[],
  options: Options = {},
): Promise<void> {
  if (!validEditFiles(files))
    throw new EditSafetyError(
      "Provide a bounded list of literal workspace-relative files.",
    );
  const source = options.env ?? process.env;
  const binary = options.git ?? source.PI_ORCA_GIT ?? "/usr/bin/git";
  if (!isAbsolute(binary) || binary.includes("\0"))
    throw new EditSafetyError(
      "Configure an absolute PI_ORCA_GIT executable that you trust.",
    );
  const env = environment(source);
  const git = async (args: string[]) => {
    try {
      options.signal?.throwIfAborted();
      const result = await execute(
        binary,
        [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "protocol.allow=never",
          "-C",
          workspace,
          ...args,
        ],
        {
          env,
          shell: false,
          encoding: "buffer",
          killSignal: "SIGKILL",
          timeout: Math.max(1, Math.min(options.timeoutMs ?? 10000, 10000)),
          maxBuffer: Math.max(
            1,
            Math.min(options.maxBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024),
          ),
          signal: options.signal,
        },
      );
      return result.stdout.toString("utf8");
    } catch {
      throw new EditSafetyError(
        "Git scope inspection failed or exceeded its limits; no edit worker was started.",
      );
    }
  };
  try {
    const root = await realpath(workspace);
    const reported = (await git(["rev-parse", "--show-toplevel"])).replace(
      /\r?\n$/,
      "",
    );
    if ((await realpath(reported)) !== root)
      throw new EditSafetyError(
        "Edit tasks require the exact Git checkout root.",
      );
    const index = byPath(
      parse(await git(["ls-files", "--stage", "-v", "-z"]), true),
    );
    const head = byPath(
      parse(await git(["ls-tree", "-r", "-z", "HEAD"]), false),
    );
    for (const file of files) {
      options.signal?.throwIfAborted();
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        if (lookup(index, ancestor) || lookup(head, ancestor))
          throw new EditSafetyError(
            "An edit path crosses a tracked file, sparse entry or submodule.",
          );
      }
      const prefix = key(file) + "/";
      for (const tree of [index, head]) {
        for (const path of tree.keys()) {
          if (path.startsWith(prefix))
            throw new EditSafetyError(
              "A tracked directory, including a sparse directory, cannot be replaced by a scoped file.",
            );
        }
      }
      const staged = lookup(index, file),
        committed = lookup(head, file);
      const stat = await fileState(root, file, options.signal);
      if (!stat) {
        if (staged || committed)
          throw new EditSafetyError(
            "A missing tracked file is a user deletion, not a new file.",
          );
        continue;
      }
      if (stat.nlink !== 1)
        throw new EditSafetyError(
          "Hard-linked files are not supported because edits could change another path.",
        );
      if (!staged || !committed)
        throw new EditSafetyError(
          "Existing untracked, ignored or newly staged files are not supported for edit delegation.",
        );
      if (
        staged.tag !== "H" ||
        staged.stage !== "0" ||
        !["100644", "100755"].includes(staged.mode) ||
        staged.mode !== committed.mode ||
        staged.oid !== committed.oid
      )
        throw new EditSafetyError(
          "Scoped files have staged changes, conflicts or unsupported index flags.",
        );
      if (Boolean(stat.mode & 0o111) !== (staged.mode === "100755"))
        throw new EditSafetyError(
          "A scoped file has an executable-mode change.",
        );
      const oid = (
        await git(["hash-object", "--no-filters", "--", join(root, file)])
      ).trim();
      if (oid !== staged.oid)
        throw new EditSafetyError(
          "A scoped file contains user changes or requires content conversion; edit delegation was refused.",
        );
    }
  } catch (error) {
    if (error instanceof EditSafetyError) throw error;
    throw new EditSafetyError(
      "Edit scope could not be verified; no edit worker was started.",
    );
  }
}
