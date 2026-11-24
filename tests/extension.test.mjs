import assert from "node:assert/strict";
import test from "node:test";
import { createExtension } from "../src/index.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(client) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const sent = [];
  const notices = [];
  const ctx = {
    sessionManager: { getSessionId: () => "session-test" },
    ui: { notify: (...args) => notices.push(args) },
  };
  createExtension(
    client,
    {},
  )({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    sendMessage: (...args) => sent.push(args),
  });
  return {
    handlers,
    sent,
    notices,
    ctx,
    command: commands.get("orca-watch").handler,
    inbox: (...args) =>
      tools.get("orca_inbox").execute("test-call", {}, ...args),
  };
}
const attach = "attach run_test term_owned";
const message = { id: "msg_test", type: "worker_done" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("loading the extension starts no background processes", () => {
  let calls = 0;
  setup({ verify: () => calls++, peek: () => calls++ });
  assert.equal(calls, 0);
});

test("an explicit attachment queues one custom follow-up with no worker body", async () => {
  const s = setup({ verify: async () => {}, peek: async () => [message] });
  await s.command(attach, s.ctx);
  await tick();
  assert.equal(s.sent.length, 1);
  const [body, options] = s.sent[0];
  assert.equal(body.customType, "orca-notification");
  assert.ok(body.content.includes("orca_inbox"));
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});

test("shutdown aborts the listener and discards late results", async () => {
  const pending = deferred();
  let signal;
  const s = setup({
    verify: async () => {},
    peek: async (_target, value) => {
      signal = value;
      return pending.promise;
    },
  });
  await s.command(attach, s.ctx);
  await tick();
  s.handlers.get("session_shutdown")();
  assert.equal(signal.aborted, true);
  pending.resolve([message]);
  await tick();
  assert.equal(s.sent.length, 0);
});

test("reattachment fences the previous listener", async () => {
  const pending = deferred();
  let calls = 0;
  const s = setup({
    verify: async () => {},
    peek: async () => (++calls === 1 ? pending.promise : [message]),
  });
  await s.command(attach, s.ctx);
  await tick();
  await s.command(attach, s.ctx);
  await tick();
  pending.resolve([message]);
  await tick();
  assert.equal(s.sent.length, 1);
});

test("tree changes and replacement session identities fence notifications", async () => {
  for (const transition of ["tree", "session"]) {
    const pending = deferred();
    const s = setup({
      verify: async () => {},
      peek: async () => pending.promise,
    });
    await s.command(attach, s.ctx);
    await tick();
    if (transition === "tree") s.handlers.get("session_tree")();
    else s.ctx.sessionManager.getSessionId = () => "other-session";
    pending.resolve([message]);
    await tick();
    assert.equal(s.sent.length, 0);
  }
});

test("connection failures are visible and do not create retry storms", async () => {
  const s = setup({
    verify: async () => {
      throw new Error("Ownership mismatch");
    },
  });
  await s.command(attach, s.ctx);
  await tick();
  assert.equal(s.sent.length, 0);
  assert.ok(
    s.notices.some(
      ([text, level]) =>
        text.includes("Ownership mismatch") && level === "error",
    ),
  );
});

test("the spike refuses managed-session identities rather than overriding them", async () => {
  const notices = [];
  const handlers = new Map();
  createExtension(
    {},
    { ORCA_AGENT_SESSION_ID: "managed-session" },
  )({
    on() {},
    registerTool() {},
    registerCommand: (name, value) => handlers.set(name, value),
  });
  await handlers.get("orca-watch").handler(attach, {
    ui: { notify: (text) => notices.push(text) },
  });
  assert.ok(notices.some((text) => text.includes("externally launched Pi")));
});

test("stop is idempotent and malformed attachments never call Orca", async () => {
  let calls = 0;
  const s = setup({
    verify: async () => {
      calls++;
    },
  });
  await s.command("stop", s.ctx);
  await s.command("stop", s.ctx);
  await s.command("attach run_bad;echo term_owned", s.ctx);
  assert.equal(calls, 0);
});

test("one attachment supports two notification and foreground-read cycles", async () => {
  const next = deferred();
  let peeks = 0;
  let reads = 0;
  const second = { ...message, id: "msg_second" };
  const s = setup({
    verify: async () => {},
    peek: async () =>
      ++peeks === 1 ? [message] : peeks === 2 ? [second] : next.promise,
    read: async () => ({ messages: [++reads === 1 ? message : second] }),
  });
  await s.command(attach, s.ctx);
  await tick();
  assert.equal(s.sent.length, 1);
  assert.equal(reads, 0, "No consuming read runs in the background");
  const result = await s.inbox(undefined, undefined, s.ctx);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.messages, [message]);
  await tick();
  assert.equal(s.sent.length, 2);
  await s.inbox(undefined, undefined, s.ctx);
  await tick();
  assert.equal(peeks, 3);
  assert.equal(reads, 2);
  s.handlers.get("session_shutdown")();
  next.resolve([]);
});

test("inbox refuses unbound, watching, and concurrent consuming reads", async () => {
  const read = deferred();
  let calls = 0;
  const s = setup({
    verify: async () => {},
    peek: async () => [message],
    read: async () => {
      calls++;
      return read.promise;
    },
  });
  assert.equal((await s.inbox(undefined, undefined, s.ctx)).isError, true);
  await s.command(attach, s.ctx);
  await tick();
  const first = s.inbox(undefined, undefined, s.ctx);
  assert.equal((await s.inbox(undefined, undefined, s.ctx)).isError, true);
  read.resolve({ messages: [] });
  await first;
  assert.equal(calls, 1);
  s.handlers.get("session_shutdown")();
});

test("partial FIFO reads drain without duplicate notifications", async () => {
  const pending = deferred();
  let peeks = 0;
  let reads = 0;
  const s = setup({
    verify: async () => {},
    peek: async () => (++peeks === 1 ? [message] : pending.promise),
    read: async () => ({
      messages:
        ++reads === 1 ? [{ id: "msg_older", type: "status" }] : [message],
    }),
  });
  await s.command(attach, s.ctx);
  await tick();
  const first = await s.inbox(undefined, undefined, s.ctx);
  assert.ok(first.content[0].text.includes("orca_inbox again"));
  assert.equal(peeks, 1);
  assert.equal(s.sent.length, 1);
  await s.inbox(undefined, undefined, s.ctx);
  await tick();
  assert.equal(peeks, 2);
  assert.equal(s.sent.length, 1);
  s.handlers.get("session_shutdown")();
  pending.resolve([]);
});

test("an ambiguous consuming error stops without retrying or rearming", async () => {
  let peeks = 0;
  let reads = 0;
  const s = setup({
    verify: async () => {},
    peek: async () => {
      peeks++;
      return [message];
    },
    read: async () => {
      reads++;
      throw new Error("deadline");
    },
  });
  await s.command(attach, s.ctx);
  await tick();
  const result = await s.inbox(undefined, undefined, s.ctx);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("may have been handled"));
  assert.ok(result.content[0].text.includes("orchestration inbox"));
  await tick();
  assert.equal(peeks, 1);
  assert.equal(reads, 1);
  assert.equal((await s.inbox(undefined, undefined, s.ctx)).isError, true);
  assert.equal(reads, 1);
});

test("stop during a foreground read cancels it and does not rearm", async () => {
  const pending = deferred();
  let readSignal;
  let peeks = 0;
  const s = setup({
    verify: async () => {},
    peek: async () => {
      peeks++;
      return [message];
    },
    read: async (_target, signal) => {
      readSignal = signal;
      return pending.promise;
    },
  });
  await s.command(attach, s.ctx);
  await tick();
  const read = s.inbox(undefined, undefined, s.ctx);
  await tick();
  let stopped = false;
  const stopping = s.command("stop", s.ctx).then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(readSignal.aborted, true);
  assert.equal(stopped, false);
  pending.resolve({ messages: [message] });
  assert.equal((await read).isError, true);
  await stopping;
  await tick();
  assert.equal(peeks, 1);
});

test("foreground tools from a replacement session cannot consume old mail", async () => {
  let reads = 0;
  const s = setup({
    verify: async () => {},
    peek: async () => [message],
    read: async () => {
      reads++;
      return { messages: [] };
    },
  });
  await s.command(attach, s.ctx);
  await tick();
  const other = {
    ...s.ctx,
    sessionManager: { getSessionId: () => "other-session" },
  };
  assert.equal((await s.inbox(undefined, undefined, other)).isError, true);
  assert.equal(reads, 0);
  s.handlers.get("session_shutdown")();
});

test("a foreground read cannot race a still-watching listener", async () => {
  const pending = deferred();
  let reads = 0;
  const s = setup({
    verify: async () => {},
    peek: async () => pending.promise,
    read: async () => {
      reads++;
      return { messages: [] };
    },
  });
  await s.command(attach, s.ctx);
  await tick();
  assert.equal((await s.inbox(undefined, undefined, s.ctx)).isError, true);
  assert.equal(reads, 0);
  s.handlers.get("session_shutdown")();
  pending.resolve([]);
});
