import type { CapabilityCatalog } from "../src/protocol";
import { SingleWindowCoordinator, type BrowserDriver, type DriverExecution } from "../src/browser-window";
import { startControlServer } from "../src/control-server";
import { protocolBuild, validateProtocolBuild } from "../src/protocol";

const descriptorPath = process.argv[2];
const build = process.argv[3]
  ? validateProtocolBuild(process.argv[3])
  : protocolBuild("contract-build");
const mode = process.argv[4] ?? "immediate";
if (!descriptorPath) throw new Error("descriptor path is required");

class ContractDriver implements BrowserDriver {
  async health() {
    return {
      authenticated:true,
      accountFingerprint:"contract-account",
      status:"idle" as const,
      detail:null,
    };
  }
  async login() { return this.health(); }
  async capabilities(): Promise<CapabilityCatalog> {
    return {
      protocolVersion:1,
      build,
      accountFingerprint:"contract-account",
      catalogRevision:"contract-catalog",
      models:[{
        id:"gpt-6-sol",
        label:"GPT-6 Sol",
        efforts:[{ id:"high", label:"High", available:true, reason:null }],
      }],
    };
  }
  async reveal() {}
  async execute(execution: DriverExecution) {
    execution.emit({ type:"navigating" });
    execution.emit({ type:"composer_ready" });
    execution.emit({ type:"model_verified", model:execution.request.model, effort:execution.request.effort });
    execution.emit({ type:"connector_verified" });
    execution.emit({ type:"send_accepted" });
    execution.emit({ type:"status_delta", text:"Working", continuation:false });
    execution.emit({ type:"commentary_delta", markdown:"Visible commentary", continuation:false });
    execution.emit({ type:"answer_delta", markdown:"Contract answer", continuation:false });
    execution.emit({
      type:"generation_complete",
      finalMarkdown:"Contract answer",
      canonicalUrl:execution.request.expectedUrl,
    });
  }
}

class BlockingContractDriver extends ContractDriver {
  override async execute(execution: DriverExecution) {
    execution.emit({ type:"navigating" });
    execution.emit({ type:"send_accepted" });
    await new Promise<void>((_resolve, reject) => {
      execution.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once:true },
      );
    });
  }
}

const driver = mode === "blocking" ? new BlockingContractDriver() : new ContractDriver();
const coordinator = new SingleWindowCoordinator(driver, build);
const server = await startControlServer(coordinator, descriptorPath);
console.log(JSON.stringify({ ready:true, endpoint:server.endpoint }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(0);
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
