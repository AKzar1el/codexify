// Manual read-only smoke. Never modifies journals or exposes their text.
import { createRevenueService, loadRevenueConfig } from "./ledger.mjs";

const config = await loadRevenueConfig(process.env.REVENUE_SHOT_PROJECTS_FILE);
const service = createRevenueService({ ...config, enableWrites: false });
let failed = false;
for (const project of Object.keys(config.projects)) {
  try {
    const status = await service.get_run_ledger_status({ project });
    const owner = await service.inspect_project_writer({ project });
    console.log(JSON.stringify({ project, result: "READ_OK",
      journalBytes: status.journalBytes, journalSha256: status.journalSha256,
      stateSha256: status.stateSha256, writerStatus: owner.writerStatus,
      sidecarLockPresent: owner.sidecarLockPresent }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ project, result: "FAILED", error: error.code || "READ_ERROR" }));
  }
}
if (failed) process.exitCode = 1;
