// Read-only sidecar audit for legacy V1 and modern V3 markers.
// Prints aggregate counts, never source, journal text or credentials.
import { createRevenueService, loadRevenueConfig } from "./ledger.mjs";

const filename = process.env.REVENUE_SHOT_PROJECTS_FILE;
if (!filename) throw new Error("MISSING_FIXED_CONFIG");
const config = await loadRevenueConfig(filename);
if (config.enableWrites !== false || config.enableCodingWrites !== false
    || config.enableProjectChecks !== false) {
  throw new Error("LIVE_READONLY_FLAG_REQUIRED");
}
const projectNames = Object.keys(config.projects).sort();
if (projectNames.join("|") !==
    "geo|godprompt|gsc|nofax|trendpulse|webvalidator") {
  throw new Error("UNEXPECTED_PROJECT_SET");
}
const service = createRevenueService(config);
for (const project of projectNames) {
  const summary = await service.get_run_ledger_status({ project });
  const total = summary.runStartV1Markers + summary.runStartV3Markers;
  if (total !== summary.runStartMarkers || total < 1) {
    throw new Error("RUN_START_AGGREGATE_INCONSISTENT_" + project);
  }
  const exact = await service.get_run_ledger_status({
    project, run_key: summary.lastStartRunKey
  });
  if (exact.exactRun.runStarts !== 1 || exact.requestedRunKey !== summary.lastStartRunKey) {
    throw new Error("EXACT_START_MISSING_OR_DUPLICATED_" + project);
  }
  process.stdout.write(project + ": v1=" + summary.runStartV1Markers +
    " v3=" + summary.runStartV3Markers +
    " malformed_escaped_starts=" + summary.escapedLiteralStartFragments +
    " latest_terminals=" + exact.exactRun.terminals +
    " state_ref=" + exact.stateReferencesRequestedRun + "\n");
}
