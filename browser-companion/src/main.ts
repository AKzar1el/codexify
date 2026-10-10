import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";
import { SingleWindowCoordinator } from "./browser-window";
import { ChatGptBrowserDriver } from "./chatgpt-driver";
import { startControlServer, type ControlServer } from "./control-server";
import { ElectronSingleWindowSurface } from "./electron-surface";

const BUILD = process.env.CODEXIFY_BROWSER_BUILD ?? "1.0.0-protocol-v1";
const root = resolve(process.env.CODEXIFY_BROWSER_HOME ?? join(homedir(), ".codexify", "browser"));
const profilePath = join(root, "profile");
const descriptorPath = resolve(process.env.CODEXIFY_BROWSER_DESCRIPTOR ?? join(root, "descriptor.json"));

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

void main().catch(error => {
  console.error(`Browser companion failed: ${error instanceof Error ? error.message : String(error)}`);
  void stop().finally(() => app.exit(1));
});
