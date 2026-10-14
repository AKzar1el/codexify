import {readFileSync,lstatSync,writeFileSync,renameSync,unlinkSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {z} from "zod";

const appIdSchema=z.string().regex(/^asdk_app_[A-Za-z0-9_]{1,128}$/);
const entrySchema=z.strictObject({account:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().min(1).max(256),appId:appIdSchema,allowAllSummary:z.string().min(1).max(2048).optional()});
const cacheSchema=z.array(entrySchema).max(64);

/** Account-bound UI identities only. No session cookies or access tokens. */
export class ConnectorAppCache {
  private entries:z.infer<typeof cacheSchema>=[];
  constructor(private readonly path?:string) {
    if(!path)return;
    try {
      const metadata=lstatSync(path);
      if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>32_768)return;
      this.entries=cacheSchema.parse(JSON.parse(readFileSync(path,"utf8")));
    }catch { /* A missing or stale cache falls back to UI discovery. */ }
  }
  get(account:string,name:string):string|undefined {
    return this.entries.find(entry=>entry.account===account&&entry.name===name)?.appId;
  }
  getAllowAllSummary(account:string,name:string):string|undefined {
    return this.entries.find(entry=>entry.account===account&&entry.name===name)?.allowAllSummary;
  }
  rememberAllowAllSummary(account:string,name:string,summary:string):void {
    const entry=this.entries.find(entry=>entry.account===account&&entry.name===name);
    if(!entry||entry.allowAllSummary===summary||!entrySchema.safeParse({...entry,allowAllSummary:summary}).success)return;
    entry.allowAllSummary=summary;this.persist();
  }
  remember(account:string,name:string,identity:string):void {
    const appId=appIdSchema.safeParse(identity.replace(/^app:\/\//,"").replace(/^plugin:/,""));
    if(!appId.success)return;
    const entry=entrySchema.safeParse({account,name,appId:appId.data});
    if(!entry.success||this.get(account,name)===appId.data)return;
    this.entries=[...this.entries.filter(item=>item.account!==account||item.name!==name),entry.data].slice(-64);
    this.persist();
  }
  private persist():void {
    if(!this.path)return;
    const bytes=JSON.stringify(this.entries);if(Buffer.byteLength(bytes)>32_768)return;
    const temporary=`${this.path}.${randomUUID()}.tmp`;
    try {
      try {const info=lstatSync(this.path);if(!info.isFile()||info.isSymbolicLink())return;}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")return;}
      writeFileSync(temporary,bytes,{mode:0o600,flag:"wx"});
      renameSync(temporary,this.path);
    }catch { /* Cache persistence must not interrupt a verified chat submission. */ }
    finally {try{unlinkSync(temporary);}catch{}}
  }
}
