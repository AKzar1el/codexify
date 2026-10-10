import { expect, test } from "bun:test";

const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
const packager = await Bun.file(new URL("../scripts/package.cjs", import.meta.url)).text();
const smoke = await Bun.file(new URL("../scripts/smoke-package.cjs", import.meta.url)).text();
const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();

test("package scripts create the exact versioned Codexify companion archive contract", () => {
  expect(manifest.devDependencies["electron-builder"]).toBe("26.15.3");
  expect(manifest.scripts.package).toContain("scripts/package.cjs");
  expect(manifest.scripts["smoke:package"]).toContain("scripts/smoke-package.cjs");
  expect(manifest.build.appId).toBe("dev.codexify.browser-companion");
  expect(manifest.build.productName).toBe("Codexify Browser Companion");
  expect(packager).toContain("codexify-browser-v");
  expect(packager).toContain("protocol-schema-v1.json");
  expect(packager).toContain("protocolSchemaHash");
  expect(packager).toContain("manifest.json");
  expect(packager).toContain("--dir");
  expect(packager).toContain("verbatimSymlinks:true");
  expect(packager).toContain("THIRD_PARTY_NOTICES.md");
  expect(packager).toContain("codex-chatgpt-web-MIT.txt");
  expect(packager).toContain("LICENSE");
  expect(smoke).toContain("THIRD_PARTY_NOTICES.md");
  expect(smoke).toContain("codex-chatgpt-web-MIT.txt");
  expect(smoke).toContain("LICENSE");
});

test("package smoke launches only the packaged readiness path", () => {
  expect(main).toContain("CODEXIFY_BROWSER_SMOKE_FILE");
  expect(main).toContain("app.isPackaged");
  expect(smoke).toContain("CODEXIFY_BROWSER_SMOKE_FILE");
  expect(smoke).toContain("packaged");
  expect(smoke).toContain("manifest.json");
  expect(smoke).not.toContain("chatgpt.com");
});
