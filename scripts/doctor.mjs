#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { sep } from "node:path";

const args = process.argv.slice(2);
const usage =
  "Usage: node scripts/doctor.mjs [--agent claude|codex|cursor|opencode] [--json]";
if (args.length === 1 && args[0] === "--help") {
  console.log(
    usage +
      "\nPassively finds executable candidates and requests only Git root/local Orca worktree metadata. No model requests, installers, authentication queries or Pi/worker CLI execution. Trusted metadata CLIs may perform normal startup I/O.",
  );
  process.exit(0);
}
let agent,
  json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--json" && !json) json = true;
  else if (
    args[i] === "--agent" &&
    agent === undefined &&
    ["claude", "codex", "cursor", "opencode"].includes(args[i + 1])
  )
    agent = args[++i];
  else {
    console.error(usage);
    process.exit(2);
  }
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 22 || (major === 22 && minor >= 19))) {
  console.error(
    "Pi-Orca diagnostics require Node 22.19 or newer. See https://nodejs.org/en/download.",
  );
  process.exit(1);
}
if (
  fileURLToPath(import.meta.url)
    .split(sep)
    .includes("node_modules")
) {
  console.error(
    "Standalone diagnostics require a Git/source installation outside node_modules. Use /orca-doctor inside Pi, or use the documented Git installation.",
  );
  process.exit(1);
}
try {
  const { diagnose, formatDoctor } = await import("../src/doctor.ts");
  const report = await diagnose(process.cwd(), agent);
  console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  process.exitCode = report.status === "blocked" ? 1 : 0;
} catch {
  console.error(
    "Diagnostics could not finish. No installation or worker launch was requested.",
  );
  process.exitCode = 1;
}
