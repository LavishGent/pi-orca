import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { validPlan } from "./launch.ts";
import type { LaunchOutcome, LaunchPlan } from "./launch.ts";

export const launchEntryType = "orca-launch-journal";
export interface LaunchRecord {
  version: 1 | 2;
  plan: LaunchPlan;
  status: "pending" | LaunchOutcome["status"];
  outcome?: LaunchOutcome;
}

export function recordVersion(plan: LaunchPlan): 1 | 2 {
  return plan.mode === "edit" ? 2 : 1;
}

export function readLaunchJournal(
  entries: readonly SessionEntry[],
): Map<string, LaunchRecord> {
  const records = new Map<string, LaunchRecord>();
  // Starts affect Orca even if the user navigates to an earlier transcript branch.
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== launchEntryType)
      continue;
    const data: unknown = entry.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      (data.version !== 1 && data.version !== 2) ||
      !("plan" in data) ||
      !validPlan(data.plan) ||
      data.version !== recordVersion(data.plan) ||
      !("status" in data) ||
      !["pending", "ready", "unconfirmed", "blocked"].includes(
        String(data.status),
      )
    ) {
      throw new Error(
        "Unsupported launch journal entry. Reconcile it before starting workers.",
      );
    }
    const status = data.status;
    if (
      status !== "pending" &&
      status !== "ready" &&
      status !== "unconfirmed" &&
      status !== "blocked"
    ) {
      throw new Error("Invalid launch journal status.");
    }
    records.set(data.plan.requestId, {
      version: data.version,
      plan: data.plan,
      status,
    });
  }
  return records;
}
