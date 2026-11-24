import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createExtension } from "../src/index.ts";
import { MailboxSetup } from "../src/mailbox-setup.ts";
import { WorkerLauncher } from "../src/launch.ts";
const root = fileURLToPath(new URL("../node_modules/", import.meta.url));
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test(
  "real SDK persists the first prompt during setup, waits before launch, reloads and isolates both fork APIs",
  { timeout: 15000 },
  async () => {
    const sdk = await import(
      pathToFileURL(join(root, "@earendil-works/pi-coding-agent/dist/index.js"))
        .href
    );
    const ai = await import(
      pathToFileURL(join(root, "@earendil-works/pi-ai/dist/index.js")).href
    );
    const { emitSessionShutdownEvent } = await import(
      pathToFileURL(
        join(
          root,
          "@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
        ),
      ).href
    );
    const dir = await mkdtemp(join(tmpdir(), "pi-orca-startup-sdk-"));
    const sessions = [];
    const gate = deferred();
    const opened = [];
    const waiters = [];
    let mutations = 0,
      terminalCount = 0,
      runCount = 0,
      requests = 0,
      submitted = 0;
    const runs = new Map();
    const terminals = new Set();
    let manager;
    const reader = async (args) => {
      const op = args.slice(0, 2).join(" ");
      if (op === "worktree show") {
        await gate.promise;
        return {
          worktree: {
            id: `repo::${dir}`,
            path: dir,
            identity: { executionHostId: "local" },
          },
        };
      }
      if (op === "terminal show") {
        const handle = args[args.indexOf("--terminal") + 1];
        assert.ok(terminals.has(handle));
        return {
          terminal: {
            handle,
            executionHostId: "local",
            connected: true,
            worktreeId: `repo::${dir}`,
            worktreePath: dir,
            incarnationId: `inc_${handle}`,
          },
        };
      }
      if (op === "orchestration run-show") {
        const id = args[args.indexOf("--id") + 1];
        return { run: { id, coordinator_handle: runs.get(id) } };
      }
      if (op === "orchestration run-current") {
        const terminal = args[args.indexOf("--from") + 1];
        const run = [...runs].find(([, t]) => t === terminal);
        return { run: { id: run[0], coordinator_handle: terminal } };
      }
      if (op === "orchestration check") return new Promise(() => {});
      throw new Error("Unexpected metadata operation");
    };
    const service = new MailboxSetup({
      env: { PI_ORCA_STATE_DIR: join(dir, "state") },
      read: reader,
      mutate: async (args) => {
        mutations++;
        if (args[0] === "terminal") {
          const handle = `term_${++terminalCount}`;
          terminals.add(handle);
          return {
            code: 0,
            envelope: { ok: true, result: { terminal: { handle } } },
          };
        }
        const id = `run_${++runCount}`;
        const terminal = args[args.indexOf("--from") + 1];
        runs.set(id, terminal);
        return {
          code: 0,
          envelope: {
            ok: true,
            result: { run: { id, coordinator_handle: terminal } },
          },
        };
      },
    });
    const original = service.open.bind(service);
    service.open = async (...args) => {
      const c = await original(...args);
      opened.push(c.target);
      waiters.shift()?.resolve(c.target);
      return c;
    };
    const builder = new WorkerLauncher({ env: {}, read: reader });
    const launcher = {
      prepare: builder.prepare.bind(builder),
      submit: async (plan) => {
        assert.equal(mutations, 2);
        submitted++;
        return {
          status: "ready",
          requestId: plan.requestId,
          runId: plan.target.run,
          taskId: "task_fixture",
          dispatchId: "ctx_fixture",
        };
      },
    };
    const settings = sdk.SettingsManager.inMemory({
      packages: [],
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider("startup-fixture", {
      api: "startup-fixture-api",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "synthetic",
      models: [
        {
          id: "fixture",
          name: "fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 256,
        },
      ],
      streamSimple(model) {
        requests++;
        assert.ok(
          existsSync(manager.getSessionFile()),
          "the prompt must persist without waiting for setup",
        );
        if (requests === 1) {
          assert.equal(mutations, 0);
          queueMicrotask(() => gate.resolve());
        }
        const tool = requests === 1;
        const message = {
          role: "assistant",
          content: tool
            ? [
                {
                  type: "toolCall",
                  id: "start_one",
                  name: "orca_worker_start",
                  arguments: {
                    agent: "codex",
                    title: "fixture",
                    spec: "Read-only fixture.",
                  },
                },
              ]
            : [{ type: "text", text: "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: tool ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        const stream = ai.createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        });
        return stream;
      },
    });
    const create = async (sessionManager) => {
      const loader = new sdk.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          createExtension(service.client, {}, launcher, service),
        ],
      });
      await loader.reload();
      const { session } = await sdk.createAgentSession({
        cwd: dir,
        agentDir: dir,
        resourceLoader: loader,
        settingsManager: settings,
        modelRuntime: runtime,
        model: runtime.getModel("startup-fixture", "fixture"),
        sessionManager,
        tools: ["orca_worker_start"],
        thinkingLevel: "off",
      });
      sessions.push(session);
      await session.bindExtensions({
        onError: (error) => {
          throw new Error(`Extension failed: ${error.message}`);
        },
      });
      return session;
    };
    try {
      manager = sdk.SessionManager.create(dir, join(dir, "sessions"));
      const parent = await create(manager);
      assert.equal(mutations, 0);
      await parent.prompt("Implement the authorized fixture task.");
      assert.equal(submitted, 1);
      assert.equal(mutations, 2);
      const first = opened[0];
      const resumed = deferred();
      waiters.push(resumed);
      await parent.reload();
      const same = await resumed.promise;
      assert.deepEqual(same, first);
      assert.equal(mutations, 2);
      assert.equal(requests, 2, "reload must not start an inference turn");
      const forkManager = sdk.SessionManager.forkFrom(
        manager.getSessionFile(),
        dir,
        join(dir, "forks"),
      );
      const forkReady = deferred();
      waiters.push(forkReady);
      await create(forkManager);
      const other = await forkReady.promise;
      assert.notDeepEqual(other, first);
      assert.equal(mutations, 4);
      assert.equal(requests, 2);
      const branchManager = sdk.SessionManager.open(
        manager.getSessionFile(),
        join(dir, "branch-forks"),
      );
      branchManager.createBranchedSession(branchManager.getLeafId());
      const branchReady = deferred();
      waiters.push(branchReady);
      await create(branchManager);
      const branchTarget = await branchReady.promise;
      assert.notDeepEqual(branchTarget, first);
      assert.notDeepEqual(branchTarget, other);
      assert.equal(mutations, 6);
      assert.equal(requests, 2);
    } finally {
      for (const session of sessions) {
        try {
          await emitSessionShutdownEvent(session.extensionRunner, {
            type: "session_shutdown",
            reason: "quit",
          });
        } finally {
          session.dispose();
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
