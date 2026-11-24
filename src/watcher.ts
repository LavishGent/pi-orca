import { setTimeout as delay } from "node:timers/promises";
import type { MailboxClient, Target, Notice } from "./orca.ts";

// Stop after notifying. Repeated peeks of unhandled mail would return immediately.
export async function watchOnce(
  client: Pick<MailboxClient, "verify" | "peek">,
  target: Target,
  signal: AbortSignal,
  notify: (messages: Notice[]) => void,
): Promise<void> {
  while (!signal.aborted) {
    await client.verify(target, signal);
    if (signal.aborted) return;
    const started = Date.now();
    const messages = await client.peek(target, signal);
    if (signal.aborted) return;
    if (messages.length) {
      notify(messages);
      return;
    }
    // A runtime that returns early must not turn this listener into a busy loop.
    const remaining = 250 - (Date.now() - started);
    if (remaining > 0) await delay(remaining, undefined, { signal });
  }
}
