import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";
import { SingleWindowCoordinator } from "./browser-window";
import { ChatGptBrowserDriver } from "./chatgpt-driver";
import { startControlServer, type ControlServer } from "./control-server";
import { ElectronSingleWindowSurface } from "./electron-surface";
import { PROTOCOL_VERSION, protocolBuild, validateProtocolBuild } from "./protocol";

const BUILD = process.env.CODEXIFY_BROWSER_BUILD
  ? validateProtocolBuild(process.env.CODEXIFY_BROWSER_BUILD)
  : protocolBuild("1.0.0");
const root = resolve(process.env.CODEXIFY_BROWSER_HOME ?? join(homedir(), ".codexify", "browser"));
const profilePath = join(root, "profile");
const descriptorPath = resolve(process.env.CODEXIFY_BROWSER_DESCRIPTOR ?? join(root, "descriptor.json"));
const smokeFile = process.env.CODEXIFY_BROWSER_SMOKE_FILE;

let server: ControlServer | undefined;
let stopping: Promise<void> | undefined;

async function stop(): Promise<void> {
  stopping ??= (async () => {
    await server?.close().catch(error => {
      console.error(`Browser companion shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    server = undefined;
  })();
  await stopping;
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await mkdir(root, { recursive:true, mode:0o700 });
  const surface = await ElectronSingleWindowSurface.create({ profilePath, title:"Codexify ChatGPT" });
  const driver = new ChatGptBrowserDriver(surface, BUILD);
  const coordinator = new SingleWindowCoordinator(driver, BUILD);
  server = await startControlServer(coordinator, descriptorPath);
  app.on("second-instance", () => { void coordinator.reveal(null); });
  app.on("before-quit", event => {
    if (stopping) return;
    event.preventDefault();
    void stop().finally(() => app.exit(0));
  });
  process.once("SIGINT", () => { void stop().finally(() => app.exit(0)); });
  process.once("SIGTERM", () => { void stop().finally(() => app.exit(0)); });
}

async function smoke(): Promise<void> {
  if (!smokeFile) throw new Error("Browser companion smoke marker path is missing");
  await app.whenReady();
  await writeFile(resolve(smokeFile), `${JSON.stringify({
    ok:true,
    packaged:app.isPackaged,
    protocolVersion:PROTOCOL_VERSION,
    build:BUILD,
    platform:process.platform,
    arch:process.arch,
  })}\n`, { mode:0o600 });
  app.exit(0);
}

void (smokeFile ? smoke() : main()).catch(error => {
  console.error(`Browser companion failed: ${error instanceof Error ? error.message : String(error)}`);
  void stop().finally(() => app.exit(1));
});
