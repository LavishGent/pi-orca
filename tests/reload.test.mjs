import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Manifest tests exercise loading only. Native setup has separate acceptance tests.
process.env.PI_ORCA_AUTO_ATTACH = "0";

const root =
  process.env.PI_SDK_ROOT ??
  fileURLToPath(new URL("../node_modules/", import.meta.url));

test(
  "the package entry format reloads edited dependencies in the real Pi loader",
  { skip: !root },
  async () => {
    const { loadExtensions, clearExtensionCache } = await import(
      pathToFileURL(
        join(
          root,
          "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
        ),
      ).href
    );
    const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const manifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    );
    const entryName = basename(manifest.pi.extensions[0]);
    const helperName = `helper${extname(entryName)}`;
    const dir = await mkdtemp(join(tmpdir(), "pi-orca-reload-"));
    try {
      await writeFile(join(dir, "package.json"), '{"type":"module"}');
      await writeFile(
        join(dir, entryName),
        `import register from './${helperName}'; export default function(pi) { register(pi); }`,
      );
      const helper = join(dir, helperName);
      await writeFile(
        helper,
        'export default function(pi) { pi.registerCommand("before", {description:"before",handler(){}}); }',
      );
      const before = await loadExtensions([join(dir, entryName)], dir);
      assert.deepEqual(before.errors, []);
      assert.ok(before.extensions[0].commands.has("before"));
      await writeFile(
        helper,
        'export default function(pi) { pi.registerCommand("after", {description:"after",handler(){}}); }',
      );
      clearExtensionCache();
      const after = await loadExtensions([join(dir, entryName)], dir);
      assert.deepEqual(after.errors, []);
      assert.ok(
        after.extensions[0].commands.has("after"),
        "Reload must not reuse the old native ESM dependency",
      );
      assert.ok(!after.extensions[0].commands.has("before"));
    } finally {
      clearExtensionCache();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("the actual manifest entry registers orca_inbox through the real Pi loader", async () => {
  const { loadExtensions, clearExtensionCache } = await import(
    pathToFileURL(
      join(
        root,
        "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
      ),
    ).href
  );
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  try {
    clearExtensionCache();
    const result = await loadExtensions(
      [join(packageDir, manifest.pi.extensions[0])],
      packageDir,
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].tools.has("orca_inbox"));
    assert.ok(result.extensions[0].tools.has("orca_worker_start"));
    const schema =
      result.extensions[0].tools.get("orca_worker_start").definition.parameters;
    assert.deepEqual(schema.properties.mode.enum, ["read-only", "edit"]);
    assert.equal(schema.properties.files.type, "array");
    assert.equal(schema.properties.files.items.type, "string");
    assert.equal(schema.properties.files.minItems, 1);
    assert.equal(schema.properties.files.maxItems, 32);
    assert.equal(schema.additionalProperties, false);
    assert.ok(result.extensions[0].tools.has("orca_launch_status"));
    assert.ok(result.extensions[0].tools.has("orca_harnesses"));
    assert.ok(result.extensions[0].tools.has("orca_doctor"));
    assert.ok(result.extensions[0].commands.has("orca-watch"));
    assert.ok(result.extensions[0].commands.has("orca-doctor"));
  } finally {
    clearExtensionCache();
  }
});
