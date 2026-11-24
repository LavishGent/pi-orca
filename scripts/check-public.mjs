import { fileURLToPath } from "node:url";
import { auditPublic } from "./public-files.mjs";
try {
  const files = auditPublic(fileURLToPath(new URL("../", import.meta.url)));
  console.log(
    `Public content audit passed (${files.length} allowlisted files).`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Public audit failed.",
  );
  process.exitCode = 1;
}
