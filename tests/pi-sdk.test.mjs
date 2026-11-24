import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createExtension } from "../src/index.ts";
import { OrcaClient } from "../src/orca.ts";
import { WorkerLauncher } from "../src/launch.ts";

const root =
  process.env.PI_SDK_ROOT ??
  fileURLToPath(new URL("../node_modules/", import.meta.url));
const liveTarget = {
  run: process.env.PI_ORCA_TEST_RUN,
  terminal: process.env.PI_ORCA_TEST_TERMINAL,
};

for (const mode of [
  "idle",
  "live",
  "rearm",
  "busy",
  "reload",
  "launch",
  "edit",
]) {
  const live = mode === "live";
  const rearm = mode === "rearm";
  const busy = mode === "busy";
  const reload = mode === "reload";
  const editing = mode === "edit";
  const launch = mode === "launch" || editing;
  const name = {
    idle: "the real Pi SDK starts a model turn when an idle listener reports",
    live: "live Orca unread reports wake an idle Pi SDK session",
    rearm: "the real Pi SDK reads and rearms through two model tool cycles",
    busy: "a busy Pi session finishes its current turn before handling the notification",
    reload:
      "reload cancels the old listener and requires explicit reattachment to recover pending reports",
    launch:
      "a model tool call journals a worker request to disk before mutation",
    edit: "the real SDK accepts an edit scope and journals version 2 before submission",
  }[mode];
  test(
    name,
    {
      skip: !root || (live && (!liveTarget.run || !liveTarget.terminal)),
      timeout: 15_000,
    },
    async () => {
      const sdk = await import(
        pathToFileURL(
          join(root, "@earendil-works/pi-coding-agent/dist/index.js"),
        ).href
      );
      const ai = await import(
        pathToFileURL(join(root, "@earendil-works/pi-ai/dist/index.js")).href
      );
      const dir = await mkdtemp(join(tmpdir(), "pi-orca-sdk-"));
      let session;
      let release;
      let requests = 0;
      let reads = 0;
      let peeks = 0;
      let releaseNext;
      let releaseBusy;
      let startedBusy;
      let firstPeekSignal;
      let startedPeek;
      const peekStarted = new Promise((resolve) => {
        startedPeek = resolve;
      });
      const busyStarted = new Promise((resolve) => {
        startedBusy = resolve;
      });
      const busyGate = new Promise((resolve) => {
        releaseBusy = resolve;
      });
      const next = new Promise((resolve) => {
        releaseNext = resolve;
      });
      const readBatches = [
        [{ id: "msg_test", type: "worker_done" }],
        [{ id: "msg_second", type: "worker_done" }],
      ];
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const settingsManager = sdk.SettingsManager.inMemory({
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
      runtime.registerProvider("orca-test", {
        api: "orca-test-api",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "synthetic-not-a-secret",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 256,
          },
        ],
        streamSimple(model) {
          requests++;
          const stream = ai.createAssistantMessageEventStream();
          const toolCall =
            (rearm && requests % 2 === 1) ||
            (busy && requests === 2) ||
            (reload && requests === 1) ||
            (launch && requests === 1);
          const message = {
            role: "assistant",
            content: toolCall
              ? [
                  {
                    type: "toolCall",
                    id: `inbox_${requests}`,
                    name: launch ? "orca_worker_start" : "orca_inbox",
                    arguments: launch
                      ? {
                          agent: "codex",
                          title: editing ? "Edit fixture" : "Read package",
                          spec: editing
                            ? "Create the authorized fixture.txt only."
                            : "Read package name.",
                          ...(editing
                            ? { mode: "edit", files: ["fixture.txt"] }
                            : {}),
                        }
                      : {},
                  },
                ]
              : [{ type: "text", text: "SDK_WAKE_OK" }],
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
            stopReason: toolCall ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          const finish = () => {
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end();
          };
          if (busy && requests === 1) {
            startedBusy();
            void busyGate.then(finish);
          } else queueMicrotask(finish);
          return stream;
        },
      });
      try {
        const loader = new sdk.DefaultResourceLoader({
          cwd: dir,
          agentDir: dir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          noContextFiles: true,
          extensionFactories: [
            createExtension(
              live
                ? new OrcaClient()
                : {
                    verify: async () => {},
                    peek: async (_target, signal) => {
                      peeks++;
                      if (peeks === 1) {
                        firstPeekSignal = signal;
                        startedPeek();
                        return pending;
                      }
                      return peeks === 2 ? next : new Promise(() => {});
                    },
                    read: async () => {
                      reads++;
                      return { messages: readBatches.shift() };
                    },
                  },
              {},
              launch
                ? {
                    async prepare(target, input) {
                      const builder = new WorkerLauncher({
                        env: {},
                        canonical: async (p) => p,
                        read: async (args) =>
                          args.includes("run-show")
                            ? {
                                run: {
                                  id: target.run,
                                  coordinator_handle: target.terminal,
                                },
                              }
                            : {
                                terminal: {
                                  handle: target.terminal,
                                  worktreeId: `repo::${dir}`,
                                  worktreePath: dir,
                                  executionHostId: "local",
                                  connected: true,
                                  incarnationId: "fixture-incarnation",
                                },
                              },
                      });
                      return builder.prepare(target, input, dir);
                    },
                    async validateEdits(plan) {
                      assert.equal(plan.mode, "edit");
                      assert.deepEqual(plan.files, ["fixture.txt"]);
                    },
                    async submit(plan) {
                      const log = await readFile(
                        session.sessionManager.getSessionFile(),
                        "utf8",
                      );
                      assert.ok(log.includes(plan.requestId));
                      assert.ok(
                        log.includes('"status":"pending"'),
                        "The pending request must reach disk before spawning",
                      );
                      return {
                        status: "ready",
                        requestId: plan.requestId,
                        runId: plan.target.run,
                        dispatchId: "ctx_fixture",
                        taskId: "task_fixture",
                      };
                    },
                    async inspect() {
                      throw new Error("Not part of this test");
                    },
                  }
                : undefined,
            ),
          ],
        });
        await loader.reload();
        ({ session } = await sdk.createAgentSession({
          cwd: dir,
          agentDir: dir,
          resourceLoader: loader,
          settingsManager,
          modelRuntime: runtime,
          model: runtime.getModel("orca-test", "fixture"),
          sessionManager: launch
            ? sdk.SessionManager.create(dir, join(dir, "sessions"))
            : sdk.SessionManager.inMemory(dir),
          tools: launch
            ? ["orca_worker_start"]
            : rearm || busy || reload
              ? ["orca_inbox"]
              : [],
          thinkingLevel: "off",
        }));
        await session.bindExtensions({});
        const settled = new Promise((resolve) => {
          session.subscribe((event) => {
            if (event.type === "agent_settled") resolve();
          });
        });
        const target = live
          ? liveTarget
          : { run: "run_test", terminal: "term_owned" };
        await session.prompt(
          `/orca-watch attach ${target.run} ${target.terminal}`,
        );
        assert.equal(requests, 0, "The command alone must not start inference");
        let initialTurn;
        if (busy) {
          initialTurn = session.prompt("Finish this initial task first.");
          await busyStarted;
        }
        if (reload) {
          await peekStarted;
          await session.reload();
          assert.equal(
            firstPeekSignal.aborted,
            true,
            "Reload must cancel the old background wait",
          );
          assert.equal(peeks, 1, "The replacement must start disconnected");
          assert.equal(reads, 0, "Reload must not consume reports");
          release([{ id: "msg_test", type: "worker_done" }]);
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(
            requests,
            0,
            "A late result must not wake the reloaded session",
          );
          assert.equal(reads, 0);
          await session.prompt(
            `/orca-watch attach ${target.run} ${target.terminal}`,
          );
          releaseNext([{ id: "msg_test", type: "worker_done" }]);
        } else if (launch) {
          await session.prompt("Start the authorized read-only fixture task.");
        } else if (!live) release([{ id: "msg_test", type: "worker_done" }]);
        if (busy) {
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(
            requests,
            1,
            "The notification must not interrupt the busy model",
          );
          releaseBusy();
          await initialTurn;
        }
        await settled;
        if (rearm) {
          assert.equal(reads, 1);
          const secondSettled = new Promise((resolve) => {
            session.subscribe((event) => {
              if (event.type === "agent_settled") resolve();
            });
          });
          releaseNext([{ id: "msg_second", type: "worker_done" }]);
          await secondSettled;
          assert.equal(reads, 2);
        }
        assert.equal(requests, rearm ? 4 : busy ? 3 : reload || launch ? 2 : 1);
        if (reload) {
          assert.equal(reads, 1);
          assert.equal(
            peeks,
            3,
            "Recovered consumption must rearm exactly one observer",
          );
          assert.equal(
            session.sessionManager
              .getEntries()
              .filter(
                (entry) =>
                  entry.type === "custom_message" &&
                  entry.customType === "orca-notification",
              ).length,
            1,
            "The old listener must not duplicate the recovered notification",
          );
        }
        const entries = session.sessionManager.getEntries();
        if (rearm || busy || reload || launch) {
          const results = entries.filter(
            (entry) =>
              entry.type === "message" && entry.message.role === "toolResult",
          );
          assert.equal(results.length, rearm ? 2 : 1);
          assert.ok(
            results.every(
              (entry) =>
                entry.message.toolName ===
                  (launch ? "orca_worker_start" : "orca_inbox") &&
                !entry.message.isError,
            ),
          );
        }
        if (launch) {
          assert.deepEqual(
            entries
              .filter(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "orca-launch-journal",
              )
              .map((entry) => entry.data.status),
            ["pending", "ready"],
          );
          assert.ok(
            entries
              .filter(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "orca-launch-journal",
              )
              .every((entry) => entry.data.version === (editing ? 2 : 1)),
          );
        } else
          assert.ok(
            entries.some(
              (entry) =>
                entry.type === "custom_message" &&
                entry.customType === "orca-notification",
            ),
          );
        assert.ok(
          entries.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              entry.message.content.some(
                (part) => part.type === "text" && part.text === "SDK_WAKE_OK",
              ),
          ),
        );
      } finally {
        session?.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
