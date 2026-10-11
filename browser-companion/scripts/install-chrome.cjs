const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function installChrome(platform = process.platform, arch = process.arch) {
  const hostPlatform = {
    "darwin-arm64":"mac14-arm64",
    "darwin-x64":"mac14",
    "linux-arm64":"ubuntu24.04-arm64",
    "linux-x64":"ubuntu24.04-x64",
    "win32-x64":"win64",
  }[`${platform}-${arch}`];
  if (!hostPlatform) throw new Error(`Private Chrome is unsupported on ${platform}/${arch}`);
  const browserRoot = path.join(root, ".browsers", `${platform}-${arch}`);
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH:browserRoot,
  };
  delete env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE;
  if (platform !== process.platform || arch !== process.arch) {
    env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = hostPlatform;
  }
  const cli = path.join(path.dirname(require.resolve("patchright/package.json", { paths:[root] })), "cli.js");
  const installed = spawnSync(process.execPath, [cli, "install", "--no-shell", "chromium"], {
    cwd:root, env, stdio:"inherit", shell:false,
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw new Error(`Private Chrome download failed (${installed.status})`);
  const located = spawnSync(process.execPath, ["-e", 'process.stdout.write(require("patchright").chromium.executablePath())'], {
    cwd:root, env, encoding:"utf8", shell:false,
  });
  if (located.error) throw located.error;
  if (located.status !== 0) throw new Error("Could not locate downloaded Chrome");
  const executable = located.stdout;
  const relative = path.relative(browserRoot, executable);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(executable).isFile()) {
    throw new Error("Patchright did not resolve a private Chrome executable");
  }
  const browsers = JSON.parse(fs.readFileSync(
    path.join(path.dirname(require.resolve("patchright-core/package.json", { paths:[root] })), "browsers.json"), "utf8",
  )).browsers;
  const chrome = browsers.find(browser => browser.name === "chromium");
  if (chrome?.title !== "Chrome for Testing") throw new Error("Patchright's managed browser is not Chrome for Testing");
  fs.writeFileSync(path.join(browserRoot, "chrome-executable.json"), `${JSON.stringify({
    version:chrome.browserVersion,
    executable:relative.split(path.sep).join("/"),
  }, null, 2)}\n`);
  return browserRoot;
}

module.exports = { installChrome };
if (require.main === module) process.stdout.write(`${installChrome()}\n`);
