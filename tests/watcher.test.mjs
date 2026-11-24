import assert from "node:assert/strict";
import test from "node:test";
import { watchOnce } from "../src/watcher.ts";

const target = { run: "run_test", terminal: "term_test" };
const report = { id: "msg_test", type: "worker_done" };

function setup(batches) {
  const seen = [];
  let ownershipChecks = 0;
  let waits = 0;
  return {
    seen,
    client: {
      async verify() {
        ownershipChecks++;
      },
      async peek() {
        waits++;
        return batches.shift() ?? [];
      },
    },
    counts: () => ({ ownershipChecks, waits }),
  };
}

test("waits through empty batches and emits once without consuming mail", async () => {
  const s = setup([[], [report]]);
  await watchOnce(s.client, target, new AbortController().signal, (rows) =>
    s.seen.push(rows),
  );
  assert.deepEqual(s.seen, [[report]]);
  assert.deepEqual(s.counts(), { ownershipChecks: 2, waits: 2 });
});

test("does not rearm on unread results after notification", async () => {
  const s = setup([[report], [report]]);
  await watchOnce(s.client, target, new AbortController().signal, (rows) =>
    s.seen.push(rows),
  );
  assert.equal(s.counts().waits, 1);
  assert.equal(s.seen.length, 1);
});

test("ownership failure stops before reading", async () => {
  const s = setup([[report]]);
  s.client.verify = async () => {
    throw new Error("Ownership mismatch");
  };
  await assert.rejects(
    watchOnce(s.client, target, new AbortController().signal, () => {}),
    /Ownership mismatch/,
  );
  assert.equal(s.counts().waits, 0);
});

test("aborted results cannot notify the old session", async () => {
  const controller = new AbortController();
  const s = setup([]);
  s.client.peek = async () => {
    controller.abort();
    return [report];
  };
  await watchOnce(s.client, target, controller.signal, (rows) =>
    s.seen.push(rows),
  );
  assert.deepEqual(s.seen, []);
});

test("errors are surfaced, not retried forever", async () => {
  const s = setup([]);
  s.client.peek = async () => {
    throw new Error("Runtime unavailable");
  };
  await assert.rejects(
    watchOnce(s.client, target, new AbortController().signal, () => {}),
    /Runtime unavailable/,
  );
});
