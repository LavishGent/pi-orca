import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runJson } from "./orca.ts";

const schema = "coordinator.harnesses.v1";
export interface HarnessHint {
  id: string;
  cli: string;
  installed: boolean;
  billingPool: "subscription" | "pooled" | "metered";
  modelHint: string | null;
  nativeAgentHint: string | null;
  effortHint: { kind: "flag" | "model" | "variant" | "none"; levels: string[] };
  authStatus: "unchecked";
  capacityStatus: "unknown";
  catalogStatus: "unchecked";
}
export interface HarnessInventory {
  schema: "coordinator.harnesses.v1";
  scope: "registry-hints";
  harnesses: HarnessHint[];
}
interface InventoryProvider {
  inspect(signal?: AbortSignal): Promise<HarnessInventory>;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hint(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 1024 &&
      !/[\x00-\x1f\x7f]/.test(value))
  );
}
function inventory(value: unknown): HarnessInventory {
  if (
    !record(value) ||
    value.schema !== schema ||
    value.scope !== "registry-hints" ||
    !Array.isArray(value.harnesses) ||
    value.harnesses.length > 64
  )
    throw new Error("Unsupported inventory");
  const seen = new Set<string>();
  const harnesses: HarnessHint[] = [];
  for (const row of value.harnesses) {
    if (
      !record(row) ||
      typeof row.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(row.id) ||
      seen.has(row.id) ||
      typeof row.cli !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,80}$/.test(row.cli) ||
      typeof row.installed !== "boolean" ||
      !hint(row.modelHint) ||
      !hint(row.nativeAgentHint) ||
      row.authStatus !== "unchecked" ||
      row.capacityStatus !== "unknown" ||
      row.catalogStatus !== "unchecked" ||
      !record(row.effortHint) ||
      !Array.isArray(row.effortHint.levels) ||
      row.effortHint.levels.length > 16
    )
      throw new Error("Unsupported harness hint");
    const pool = row.billingPool,
      kind = row.effortHint.kind;
    if (pool !== "subscription" && pool !== "pooled" && pool !== "metered")
      throw new Error("Unsupported billing hint");
    if (
      kind !== "flag" &&
      kind !== "model" &&
      kind !== "variant" &&
      kind !== "none"
    )
      throw new Error("Unsupported effort hint");
    const levels: string[] = [];
    for (const level of row.effortHint.levels) {
      if (
        typeof level !== "string" ||
        !/^[a-z][a-z0-9_-]{0,31}$/.test(level) ||
        levels.includes(level)
      )
        throw new Error("Unsupported effort level");
      levels.push(level);
    }
    seen.add(row.id);
    harnesses.push({
      id: row.id,
      cli: row.cli,
      installed: row.installed,
      billingPool: pool,
      modelHint: row.modelHint,
      nativeAgentHint: row.nativeAgentHint,
      effortHint: { kind, levels },
      authStatus: "unchecked",
      capacityStatus: "unknown",
      catalogStatus: "unchecked",
    });
  }
  return { schema, scope: "registry-hints", harnesses };
}

export class CoordinatorClient implements InventoryProvider {
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: (
    binary: string,
    args: string[],
    signal?: AbortSignal,
  ) => Promise<unknown>;
  constructor({
    env = process.env,
    run,
  }: {
    env?: NodeJS.ProcessEnv;
    run?: (
      binary: string,
      args: string[],
      signal?: AbortSignal,
    ) => Promise<unknown>;
  } = {}) {
    this.env = env;
    this.run =
      run ??
      ((binary, args, signal) =>
        runJson(binary, args, {
          signal,
          env,
          timeoutMs: 10000,
          maxBytes: 131072,
        }));
  }
  async inspect(signal?: AbortSignal): Promise<HarnessInventory> {
    const script =
      this.env.PI_ORCA_COORDINATOR_SCRIPT ??
      join(
        homedir(),
        ".local",
        "share",
        "coordinator",
        "scripts",
        "harnesses.py",
      );
    const python = this.env.PI_ORCA_PYTHON ?? "/usr/bin/python3";
    if (
      !isAbsolute(script) ||
      script.includes("\0") ||
      python.includes("\0") ||
      !isAbsolute(python)
    )
      throw new Error(
        "Configure an absolute shared coordinator script path and a Python executable.",
      );
    try {
      // Isolated Python ignores PYTHONPATH, user site packages, and cwd startup code.
      return inventory(
        await this.run(
          python,
          ["-I", script, "inspect", "--schema", schema],
          signal,
        ),
      );
    } catch {
      throw new Error(
        "Shared coordinator inventory is unavailable or unsupported. Check the approved installation and schema; no fallback command was run.",
      );
    }
  }
}

export function registerInventoryTool(
  pi: ExtensionAPI,
  client: InventoryProvider = new CoordinatorClient(),
): void {
  pi.registerTool({
    name: "orca_harnesses",
    label: "Inspect shared harness registry",
    description:
      "Read-only inventory from the installed shared coordinator registry. Reports executable presence and configuration hints, NOT authenticated availability, verified model catalogs, account-bound quota, or current Orca native support. Never dispatch from this result alone. Does not read project configuration, credentials, or run capacity/setup commands. No selection or launch is performed.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, signal) {
      try {
        const data = await client.inspect(signal);
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          details: data,
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "Shared coordinator inventory is unavailable or incompatible. Check the approved absolute PI_ORCA_COORDINATOR_SCRIPT and PI_ORCA_PYTHON paths and schema coordinator.harnesses.v1. No fallback selection or launch command was run.",
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
