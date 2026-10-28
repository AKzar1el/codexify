// Test helper: a separate OS process attempts the exact same append operation.
import fs from "node:fs/promises";
import { createRevenueService, loadRevenueConfig } from "./ledger.mjs";

try {
  const config = await loadRevenueConfig(process.argv[2]);
  const request = JSON.parse(await fs.readFile(process.argv[3], "utf8"));
  const result = await createRevenueService(config).append_run_record(request);
  process.stdout.write(result.status + "\n");
} catch (error) {
  process.stdout.write((error.code || "FAILED") + "\n");
  process.exitCode = 1;
}
