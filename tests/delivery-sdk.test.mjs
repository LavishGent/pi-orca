import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createExtension } from "../src/index.ts";
import { MailboxSetup } from "../src/mailbox-setup.ts";
import { makeOwner } from "../src/mailbox-state.ts";
const root = fileURLToPath(new URL("../node_modules/", import.meta.url));
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test(
  "real SDK retains a consumed report until its tool result is persisted",
  { timeout: 10000 },
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
    const dir = await mkdtemp(join(tmpdir(), "pi-orca-delivery-sdk-"));
    const stateDir = join(dir, "state");
    const manager = sdk.SessionManager.create(dir, join(dir, "sessions"));
    let session,
      connection,
      requests = 0,
      reads = 0,
      peeks = 0,
      observed = false;
    const done = deferred();
    const target = { run: "run_receipt", terminal: "term_receipt" };
    const row = {
      id: "msg_receipt",
      type: "worker_done",
      run_id: target.run,
      to_handle: `run:${target.run}`,
      body: "SDK_PRIVATE_REPORT",
    };
    const reader = async (args) => {
      const op = args.slice(0, 2).join(" ");
      if (op === "worktree show")
        return {
          worktree: {
            id: `repo::${dir}`,
            path: dir,
            identity: { executionHostId: "local" },
          },
        };
      if (op === "terminal show")
        return {
          terminal: {
            handle: target.terminal,
            executionHostId: "local",
            connected: true,
            worktreeId: `repo::${dir}`,
            worktreePath: dir,
            incarnationId: "inc_receipt",
          },
        };
      if (op === "orchestration run-show" || op === "orchestration run-current")
        return { run: { id: target.run, coordinator_handle: target.terminal } };
      if (op === "orchestration check") {
        if (args.includes("--peek")) {
          if (++peeks === 1)
            return {
              runId: target.run,
              messages: [row],
              deliveryAcknowledged: false,
            };
          return new Promise(() => {});
        }
        reads++;
        return {
          runId: target.run,
          messages: [row],
          deliveryAcknowledged: true,
        };
      }
      throw new Error("Unexpected request");
    };
    const service = new MailboxSetup({
      env: { PI_ORCA_STATE_DIR: stateDir },
      read: reader,
      mutate: async (args) => ({
        code: 0,
        envelope: {
          ok: true,
          result:
            args[0] === "terminal"
              ? { terminal: { handle: target.terminal } }
              : {
                  run: { id: target.run, coordinator_handle: target.terminal },
                },
        },
      }),
    });
    const open = service.open.bind(service);
    service.open = async (...args) => {
      connection = await open(...args);
      return connection;
    };
    const append = manager.appendMessage.bind(manager);
    manager.appendMessage = (message) => {
      if (message.role === "toolResult" && message.toolName === "orca_inbox") {
        assert.equal(
          connection.state.phase,
          "delivering",
          "acknowledged batch must remain durable before SDK append",
        );
        assert.equal(connection.delivery.result.messages[0].body, row.body);
        observed = true;
      }
      return append(message);
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
    runtime.registerProvider("receipt-fixture", {
      api: "receipt-fixture-api",
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
        const tool = requests === 2;
        if (requests >= 3) {
          assert.equal(connection.state.phase, "ready");
          assert.equal(connection.delivery, undefined);
        }
        const message = {
          role: "assistant",
          content: tool
            ? [
                {
                  type: "toolCall",
                  id: "receipt_call",
                  name: "orca_inbox",
                  arguments: {},
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
    try {
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
          createExtension(service.client, {}, undefined, service),
        ],
      });
      await loader.reload();
      ({ session } = await sdk.createAgentSession({
        cwd: dir,
        agentDir: dir,
        resourceLoader: loader,
        settingsManager: settings,
        modelRuntime: runtime,
        model: runtime.getModel("receipt-fixture", "fixture"),
        sessionManager: manager,
        tools: ["orca_inbox"],
        thinkingLevel: "off",
      }));
      await session.bindExtensions({
        onError: (e) => done.resolve({ error: e }),
      });
      session.subscribe((e) => {
        if (e.type === "agent_settled" && requests >= 3) done.resolve({});
      });
      await session.prompt("Wait for the authorized worker report.");
      const result = await done.promise;
      assert.ok(!result.error, JSON.stringify(result));
      assert.equal(reads, 1);
      assert.equal(observed, true);
      assert.equal(connection.state.phase, "ready");
      const owner = await makeOwner(
        manager.getSessionId(),
        manager.getSessionFile(),
        dir,
      );
      assert.ok(
        !(
          await readFile(join(stateDir, owner.key + ".jsonl"), "utf8")
        ).includes(row.body),
      );
      assert.ok(
        manager
          .getEntries()
          .some(
            (e) =>
              e.type === "message" &&
              e.message.role === "toolResult" &&
              e.message.toolName === "orca_inbox",
          ),
      );
    } finally {
      if (session) {
        await emitSessionShutdownEvent(session.extensionRunner, {
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
