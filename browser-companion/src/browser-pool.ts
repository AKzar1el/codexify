import {createHash} from "node:crypto";
import {SingleWindowCoordinator} from "./browser-window";
import {BrowserCompanionError} from "./errors";
import {canonicalChatGptConversationUrl,executeActionRequestSchema,cancelActionRequestSchema,
  COMPANION_KIND,PROTOCOL_VERSION,type CompanionHealth,type ActionSnapshot,type ExecuteActionRequest} from "./protocol";

type Coordinator = SingleWindowCoordinator;
type Lane = {coordinator:Coordinator;reserved:boolean;reservationPurpose:"approval"|"handoff"|"action"|null;lastUsed:number};
type OwnedAction = {lane:Lane;digest:string;key:string;conversation:string};

/** Fixed pages share one private profile, while action state and DOM ownership
 * remain local to each page. Dispatch serializes only preflight/assignment;
 * navigation and accepted action execution run independently. */
export class PooledWindowCoordinator {
  private readonly lanes:Lane[];
  private readonly actions=new Map<string,OwnedAction>();
  private readonly keys=new Map<string,string>();
  private readonly cancelKeys=new Map<string,string>();
  private readonly observations=new Set<string>();
  private dispatchTail:Promise<void>=Promise.resolve();
  private maintenance=false;
  private closed=false;
  private nextHandoffEligibleAt=0;

  constructor(coordinators:readonly Coordinator[],readonly build:string,private readonly closeContext?:()=>Promise<void>,private readonly handoffGapMs=8_000) {
    if(coordinators.length<1||coordinators.length>4)throw new Error("Browser action pages must be between one and four");
    if(!Number.isInteger(handoffGapMs)||handoffGapMs<0||handoffGapMs>30_000)throw new Error("Invalid browser handoff inspection gap");
    this.lanes=coordinators.map(coordinator=>({coordinator,reserved:false,reservationPurpose:null,lastUsed:0}));
  }

  private free(lane:Lane):boolean {return !lane.reserved&&!lane.coordinator.busy;}
  /** Keep passive approval monitoring out of an already owned browser lane. */
  get busy():boolean {return this.closed||this.maintenance||this.lanes.some(l=>!this.free(l));}
  private capacity(health:CompanionHealth,available:number):CompanionHealth {
    const activeActionIds=this.lanes.map(l=>l.coordinator.ownedActionId).filter((id):id is string=>id!==null);
    return {...health,actionCapacity:this.lanes.length,availableActionSlots:available,activeActionIds,
      activeActionId:available>0?null:activeActionIds.length===1?activeActionIds[0]!:null};
  }
  private async observe(ready:boolean):Promise<CompanionHealth> {
    if(this.closed)return this.capacity({protocolVersion:PROTOCOL_VERSION,kind:COMPANION_KIND,build:this.build,
      status:"unavailable",authenticated:false,accountFingerprint:null,activeActionId:null},0);
    const free=this.maintenance?[]:this.lanes.filter(l=>this.free(l));
    const observations=await Promise.all(this.lanes.map(l=>ready&&free.includes(l)?l.coordinator.readyHealth():l.coordinator.health()));
    const usable=observations.filter((h,i)=>free.includes(this.lanes[i]!)&&h.status!=="unavailable"&&h.status!=="authentication_required");
    const proven=usable.filter(h=>h.authenticated&&h.status==="idle");
    const accounts=new Set(observations.filter(h=>h.authenticated).map(h=>h.accountFingerprint));
    if(accounts.size>1)return this.capacity({protocolVersion:PROTOCOL_VERSION,kind:COMPANION_KIND,build:this.build,
      status:"authentication_required",authenticated:false,accountFingerprint:null,activeActionId:null},0);
    const chosen=proven[0]??usable[0]??observations[0]!;
    // Warming is advertised as available capacity, never as authentication.
    // The explicit ready observation and each execute still prove the account.
    return this.capacity({...chosen,status:this.maintenance||free.length===0?"busy":chosen.status},usable.length);
  }
  health=()=>this.observe(false);
  readyHealth=()=>this.observe(true);
  /** Authenticated local diagnostic; never read a page or expose account details. */
  readinessSnapshot() {
    return {maintenance:this.maintenance,closed:this.closed,
      handoffCooldownRemainingMs:Math.max(0,this.nextHandoffEligibleAt-Date.now()),
      lanes:this.lanes.map(l=>({reserved:l.reserved,reservationPurpose:l.reservationPurpose,...l.coordinator.readinessSnapshot()}))};
  }
  async liveness() {
    const results=await Promise.all(this.lanes.map(l=>l.coordinator.liveness()));
    return {protocolVersion:PROTOCOL_VERSION,build:this.build,available:!this.closed&&results.some(r=>r.available)};
  }

  private async exclusive<T>(operation:(coordinator:Coordinator)=>Promise<T>):Promise<T> {
    const available=this.lanes.find(l=>this.free(l));
    if(this.closed||this.maintenance||!available||this.lanes.some(l=>l.reserved
      ||(l.coordinator.busy&&(!l.coordinator.retiredWindow||l.coordinator.ownedActionId!==null))))
      throw new BrowserCompanionError("Browser companion is busy; account maintenance requires idle action pages");
    this.maintenance=true;
    try {return await operation(available.coordinator);}finally{this.maintenance=false;}
  }
  private laneFor(url:string):Lane | undefined {
    let key:string;try {key=canonicalChatGptConversationUrl(url);}catch{return undefined;}
    const entry=[...this.actions.values()].reverse().find(a=>a.conversation===key);
    return entry?.lane;
  }
  private async onConversation<T>(url:string,operation:(coordinator:Coordinator)=>Promise<T>,purpose:"approval"|"handoff"):Promise<T> {
    // Repeated unfinished handoff probes can otherwise monopolize the one
    // shared browser tab. Deferral is an error, never a fake negative proof.
    if(purpose==="handoff"&&Date.now()<this.nextHandoffEligibleAt)
      throw new BrowserCompanionError("Browser companion is busy; handoff inspection deferred");
    const preferred=this.laneFor(url);
    const key=canonicalChatGptConversationUrl(url);
    if(this.observations.has(key))throw new BrowserCompanionError("This ChatGPT conversation is being inspected");
    if(this.lanes.some(l=>{const id=l.coordinator.ownedActionId;return id&&this.actions.get(id)?.conversation===key;}))
      throw new BrowserCompanionError("This ChatGPT conversation already owns an action");
    const lane=preferred&&this.free(preferred)?preferred:this.lanes.find(l=>this.free(l));
    if(this.closed||this.maintenance||!lane)throw new BrowserCompanionError("Browser companion action pages are busy");
    lane.reserved=true;lane.reservationPurpose=purpose;
    this.observations.add(key);
    try {return await operation(lane.coordinator);}finally{
      if(purpose==="handoff")this.nextHandoffEligibleAt=Date.now()+this.handoffGapMs;
      this.observations.delete(key);lane.reserved=false;lane.reservationPurpose=null;
    }
  }
  login:Coordinator["login"]=signal=>this.exclusive(c=>c.login(signal));
  capabilities:Coordinator["capabilities"]=signal=>this.exclusive(c=>c.capabilities(signal));
  newChatCapabilities:Coordinator["newChatCapabilities"]=(url,signal)=>this.exclusive(c=>c.newChatCapabilities(url,signal));
  accountPlan:Coordinator["accountPlan"]=(epoch,signal)=>this.exclusive(c=>c.accountPlan(epoch,signal));
  refreshConnector:Coordinator["refreshConnector"]=(name,signal)=>this.exclusive(c=>c.refreshConnector(name,signal));
  setPresentationStyle:Coordinator["setPresentationStyle"]=(css,signal)=>this.exclusive(c=>c.setPresentationStyle(css,signal));
  presentation:Coordinator["presentation"]=(signal,screenshot)=>this.exclusive(c=>c.presentation(signal,screenshot));
  reveal:Coordinator["reveal"]=(url,signal)=>this.exclusive(c=>c.reveal(url,signal));
  turnHandoffComplete:Coordinator["turnHandoffComplete"]=(url,account,id,signal)=>this.onConversation(url,c=>c.turnHandoffComplete(url,account,id,signal),"handoff");
  approvePendingConversation:Coordinator["approvePendingConversation"]=(request,signal,navigate,once)=>this.onConversation(request.url,c=>c.approvePendingConversation(request,signal,navigate,once),"approval");
  // Navigation budgets are shared by every page in the profile.
  navigationAvailability:Coordinator["navigationAvailability"]=url=>(this.laneFor(url)??this.lanes[0]!).coordinator.navigationAvailability(url);
  // A retained pairing window belongs to the page that created the chat.
  releasePairingWindow(actionId:string):boolean {return this.actions.get(actionId)?.lane.coordinator.releasePairingWindow(actionId)??false;}
  refreshPairingWindow(actionId:string):boolean {return this.actions.get(actionId)?.lane.coordinator.refreshPairingWindow(actionId)??false;}

  async execute(raw:ExecuteActionRequest,signal?:AbortSignal):Promise<ActionSnapshot> {
    const request=executeActionRequestSchema.parse(raw);
    const digest=createHash("sha256").update(JSON.stringify(request)).digest("hex");
    let release!:()=>void;
    const previous=this.dispatchTail;
    this.dispatchTail=new Promise<void>(resolve=>{release=resolve;});
    try {
      await previous;signal?.throwIfAborted();
      if(this.closed||this.maintenance)throw new BrowserCompanionError("Browser companion action pages are busy");
      const known=this.actions.get(request.actionId);
      const keyed=this.keys.get(request.idempotencyKey);
      if(keyed&&keyed!==request.actionId)throw new Error("Browser action idempotency key belongs to another action");
      if(known) {
        if(known.digest!==digest)throw new Error("Browser action ID belongs to a different request");
        if(!await known.lane.coordinator.action(request.actionId))throw new Error("Browser action history expired; original outcome must not be replayed");
        return await known.lane.coordinator.execute(request,signal);
      }
      // A fresh page preflight remains the Send authority. Conflicting known
      // page identities must nevertheless fail closed before choosing a page.
      const observations=await Promise.all(this.lanes.map(l=>l.coordinator.health()));
      if(observations.some(h=>h.authenticated&&h.accountFingerprint!==request.expectedAccountFingerprint))
        throw new BrowserCompanionError("Browser companion account changed before the action could start","authentication_required");
      const conversation=canonicalChatGptConversationUrl(request.expectedUrl);
      if(this.observations.has(conversation))throw new BrowserCompanionError("This ChatGPT conversation is being inspected");
      // A pairing continuation reuses the page retained by its new-chat action;
      // that page validates the reservation before admitting the continuation.
      const parent=request.pairingContinuationOf?this.actions.get(request.pairingContinuationOf):undefined;
      if(this.lanes.some(l=>{
        const active=l.coordinator.ownedActionId;
        return active&&active!==request.pairingContinuationOf&&this.actions.get(active)?.conversation===conversation;
      }))throw new BrowserCompanionError("This ChatGPT conversation already owns an action");
      const affinity=this.laneFor(request.expectedUrl);
      const lane=parent&&!parent.lane.reserved&&parent.lane.coordinator.ownedActionId===request.pairingContinuationOf?parent.lane
        :affinity&&this.free(affinity)?affinity:[...this.lanes].sort((a,b)=>a.lastUsed-b.lastUsed).find(l=>this.free(l));
      if(!lane)throw new BrowserCompanionError("All browser companion action pages are busy");
      if(this.actions.size>=this.lanes.length*1100) {
        for(const [id,owned] of this.actions) {
          if(owned.lane.coordinator.ownedActionId!==id&&!await owned.lane.coordinator.action(id)) {
            this.actions.delete(id);if(this.keys.get(owned.key)===id)this.keys.delete(owned.key);
          }
        }
        if(this.actions.size>=this.lanes.length*1100)throw new Error("Browser action history is full");
      }
      lane.reserved=true;lane.reservationPurpose="action";lane.lastUsed=Date.now();
      // Persist pool ownership before any asynchronous page preflight. Failed
      // preflight can be retried only if the single-page coordinator recorded it.
      const owned={lane,digest,key:request.idempotencyKey,conversation};
      this.actions.set(request.actionId,owned);this.keys.set(request.idempotencyKey,request.actionId);
      try {return await lane.coordinator.execute(request,signal);}
      catch(error) {
        if(!await lane.coordinator.action(request.actionId)) {
          this.actions.delete(request.actionId);this.keys.delete(request.idempotencyKey);
        }
        throw error;
      } finally {lane.reserved=false;lane.reservationPurpose=null;}
    } finally {release();}
  }
  private async owner(actionId:string):Promise<Coordinator | undefined> {
    const known=this.actions.get(actionId);if(known)return known.lane.coordinator;
    for(const lane of this.lanes)if(await lane.coordinator.action(actionId))return lane.coordinator;
    return undefined;
  }
  async action(actionId:string) {return (await this.owner(actionId))?.action(actionId);}
  async cancel(raw:Parameters<Coordinator["cancel"]>[0]) {
    const request=cancelActionRequestSchema.parse(raw),known=this.cancelKeys.get(request.idempotencyKey);
    if(known&&known!==request.actionId)throw new Error("Browser cancel idempotency key belongs to another action");
    const coordinator=await this.owner(request.actionId);if(!coordinator)throw new Error("Browser action was not found");
    const receipt=await coordinator.cancel(request);
    this.cancelKeys.set(request.idempotencyKey,request.actionId);
    while(this.cancelKeys.size>this.lanes.length*1024)this.cancelKeys.delete(this.cancelKeys.keys().next().value!);
    return receipt;
  }
  async *events(...args:Parameters<Coordinator["events"]>) {
    const coordinator=await this.owner(args[0]);if(!coordinator)throw new Error("Browser action was not found");
    yield* coordinator.events(...args);
  }
  async close():Promise<void> {
    if(this.closed)return;this.closed=true;
    await this.dispatchTail;
    // Child pages settle first; only the primary closes the shared profile.
    try {
      await Promise.all(this.lanes.slice(1).map(l=>l.coordinator.close()));
      await this.lanes[0]!.coordinator.close();
    } finally {await this.closeContext?.();}
  }
}
