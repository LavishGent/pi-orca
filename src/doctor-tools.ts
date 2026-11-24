import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diagnose, formatDoctor, parseAgent } from "./doctor.ts";

export function registerDoctorTools(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
  check: typeof diagnose = diagnose,
): void {
  pi.registerTool({
    name: "orca_doctor",
    label: "Check Orca prerequisites",
    description:
      "Read-only prerequisite diagnostics: passively locates executable candidates and requests only trusted Git root and local Orca worktree metadata. Does not execute Pi or worker CLIs, inspect credentials, install tools, open Orca, register resources, consume mail or start models. Candidate presence is not authentication, vendor/account identity, supported version, quota or inference proof. Upstream metadata CLIs may perform their normal startup/logging/cache I/O. A live worker test needs separate explicit consent and may make multiple billable requests.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["claude", "codex", "cursor", "opencode"],
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (
          !params ||
          typeof params !== "object" ||
          Array.isArray(params) ||
          Object.keys(params).some((k) => k !== "agent")
        )
          throw new Error();
        const agent = parseAgent((params as { agent?: unknown }).agent);
        const report = await check(ctx.cwd, agent, { env, signal });
        return {
          content: [{ type: "text", text: formatDoctor(report) }],
          details: report,
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "Diagnostics could not run. Use only an optional agent: claude, codex, cursor or opencode. No setup or worker launch was requested.",
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
  pi.registerCommand("orca-doctor", {
    description:
      "Check prerequisites without installing or starting workers: [claude|codex|cursor|opencode]",
    async handler(args, ctx) {
      try {
        const agent = parseAgent(args.trim() || undefined);
        const report = await check(ctx.cwd, agent, { env });
        ctx.ui.notify(
          formatDoctor(report),
          report.status === "blocked" ? "warning" : "info",
        );
      } catch {
        ctx.ui.notify(
          "Use /orca-doctor with at most one agent: claude, codex, cursor or opencode.",
          "warning",
        );
      }
    },
  });
}
