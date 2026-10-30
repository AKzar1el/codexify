// Read-only allowlists for the six existing Revenue Shot roots.
// These are relative paths only; the private config supplies exact roots.
export const fleetCodingProfile = Object.freeze({
  geo: {
    readPrefixes: ["src/", "tests/", "README.md",
      "package.json", "tsconfig.json", "docs/"],
    writePrefixes: [], gitRoots: { root: "." }, checks: {}
  },
  gsc: {
    readPrefixes: ["src/", "tests/", "README.md",
      "package.json", "tsconfig.json", "docs/"],
    writePrefixes: [], gitRoots: { root: "." }, checks: {}
  },
  trendpulse: {
    readPrefixes: ["src/", "tests/", "README.md",
      "pyproject.toml", "docs/"],
    writePrefixes: [], gitRoots: { root: "." }, checks: {}
  },
  webvalidator: {
    readPrefixes: ["src/", "tests/", "chatgpt-plugin/src/",
      "chatgpt-plugin/tests/", "chatgpt-plugin/package.json",
      "README.md", "package.json"],
    writePrefixes: [], gitRoots: { root: "." }, checks: {}
  },
  nofax: {
    readPrefixes: ["src/", "tests/", "test/", "bin/",
      "README.md", "package.json", "docs/"],
    writePrefixes: [], gitRoots: { root: "." }, checks: {}
  },
  godprompt: {
    readPrefixes: ["god-prompt/src/",
      "god-prompt/tests/", "god-prompt/bench/", "god-prompt/README.md",
      "god-prompt/build.py", "god-prompt-mcp/src/",
      "god-prompt-mcp/tests/", "god-prompt-mcp/README.md",
      "god-prompt-mcp/package.json"],
    writePrefixes: [],
    gitRoots: { primary: "god-prompt", companion: "god-prompt-mcp" },
    checks: {}
  }
});
export function readonlyFleetConfig(config) {
  const expected = Object.keys(fleetCodingProfile).sort();
  const current = Object.keys(config.projects ?? {}).sort();
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("UNEXPECTED_FLEET_PROJECT_SET");
  }
  if (config.enableWrites !== false) {
    throw new Error("JOURNAL_WRITES_MUST_STAY_DISABLED");
  }
  return { ...config, coding: fleetCodingProfile,
    enableCodingRead: true, enableCodingWrites: false, enableProjectChecks: false };
}
