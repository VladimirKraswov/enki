import {retryHub} from './retry';
import { capabilityNative, invalidateCapabilities } from "../capabilities/integration";
import type { Catalog, SharedServer } from "../capabilities/registry";
import { signature, validateServer } from "../capabilities/registry";
import { store } from "../state/store";
import { version } from "../../package.json";
import type { HubRecord } from "./records";
import { hubOrigin } from './identity';
export interface HubConfig {endpoint:string;certificate:string;enabled:boolean;shareText:boolean;label:string;installed:Record<string,string>}
export interface HubItem {id:string;kind:"skill"|"prompt"|"tool"|"template"|"runbook";title:string;description:string;revision:string;enabled:boolean}
export interface HubPackage {path:string;sourcePath:string;manifest:{id:string;kind:HubItem["kind"];files:Record<string,string>;revision:string}}
export interface WorkshopDiagnostic {requestId:string;agent:'desktop';session:string;level:'error';code:string;operation:string;detail:'';observed:number}
export type HubSpoolRecord = HubRecord | {workshopLog:WorkshopDiagnostic};
export interface Spool {origin:string;pending:number;dropped:number;records:HubSpoolRecord[];hashes:string[]}
export const emptyConfig:HubConfig={endpoint:"",certificate:"",enabled:false,shareText:true,label:"",installed:{}};
export async function config(value?:HubConfig,key?:string,expected?:HubConfig){
 const saved=await capabilityNative<HubConfig>("hub_config",{config:value??null,key:key??null,expected:expected??null});
 if((key!==undefined||(value!==undefined&&(!expected||value.endpoint!==expected.endpoint||value.certificate!==expected.certificate||value.enabled!==expected.enabled)))&&typeof window!=="undefined")window.dispatchEvent(new Event("arvela-hub-config-changed"));
 return saved;
}
export async function request<T>(path:string,body?:unknown,expected?:string):Promise<T> {
 const origin = expected ?? await hubOrigin(await config());
 return retryHub(() => capabilityNative<T>("hub_request",{path,body:body??null,expected:origin}), {
  safe: body === undefined || path === 'memory/retrieve',
 });
}
export const spool=(action:string,records?:HubSpoolRecord[],hashes?:string[],expected?:string)=>capabilityNative<Spool>("hub_spool",{action,records:records??null,hashes:hashes??null,expected:expected??null});
export async function drain(){
 const batch=await spool("read");if(!batch.records.length)return batch;
 const history=batch.records.filter((r):r is HubRecord=>!('workshopLog' in r));
 if(history.length)await request("ingest",{appVersion:version,records:history},batch.origin);
 for(const item of batch.records)if('workshopLog' in item)await request('workshop/logs',item.workshopLog,batch.origin);
 // Partial success remains queued: both ingest and diagnostic IDs are idempotent.
 return spool("ack",undefined,batch.hashes,batch.origin);
}
export function idle(){return Object.values(store.state.chat.sessions).every(s=>s.status.type==="idle")&&!store.state.ui.sending;}
export const sourceId=(id:string)=>`hub-${id.slice(0,10)}-${signature(id).slice(0,12)}`;
async function requireProfile(expected?: string): Promise<{ settings: HubConfig; origin: string }> {
 const settings = await config(), origin = await hubOrigin(settings);
 if (!settings.enabled || (expected !== undefined && expected !== origin))
  throw Error('Подключение Hub изменилось. Обновите каталог и повторите действие.');
 return { settings, origin };
}
export async function install(item:HubItem,automatic=false,expected?:string):Promise<HubPackage>{
 if(!idle())throw Error("Завершите текущую работу агента перед обновлением инструментов.");
 const {origin}=await requireProfile(expected);
 const pkg=await capabilityNative<HubPackage>("hub_package",{id:item.id,revision:item.revision,expected:origin});
 if(item.kind==="skill"||item.kind==="tool"){
  const d=await capabilityNative<Catalog>("shared_catalog",{scope:"global",directory:null});
  const localId=sourceId(item.id);
  let registry=d.registry;
  if(item.kind==="skill"){
   const existing=registry.sources.find(s=>s.id===localId);
   if(existing&&!/[\\/]hub[\\/]packages[\\/]/.test(existing.path))throw Error("Имя источника занято вашим каталогом; он сохранён.");
   registry={...registry,sources:[...registry.sources.filter(s=>s.id!==localId),{id:localId,path:pkg.sourcePath,enabled:automatic?(existing?.enabled??true):true}]};
  }else{
   const spec=JSON.parse(pkg.manifest.files["tool.json"]??"{}") as {kind:string;url:string;name?:string;envKeys?:string[];bearer?:boolean};
   const server:SharedServer={id:localId,name:spec.name??item.title,kind:"http",url:spec.url,enabled:false,command:"",args:[],envKeys:spec.envKeys??[],bearer:!!spec.bearer};
   const problem=validateServer(server);if(problem)throw Error(problem);
   // Never replace local credentials or a configured/active MCP; explicit setup stays in common settings.
   if(!registry.servers.some(s=>s.id===localId))registry={...registry,servers:[...registry.servers,server]};
  }
  await requireProfile(origin);
  if(!idle())throw Error("Агент начал работу. Пакет скачан; примените его после завершения.");
  await capabilityNative("shared_save",{scope:"global",directory:null,expected:d.content,registry});invalidateCapabilities();
 }
 const {settings:c}=await requireProfile(origin);
 await config({...c,installed:{...c.installed,[item.id]:item.revision}},undefined,c);
 return pkg;
}

/** Hub revocation only touches its managed entries, preserving foreign registry state. */
export async function disable(item:HubItem,expected?:string){
 if(!idle())return;
 const {origin}=await requireProfile(expected);
 const d=await capabilityNative<Catalog>("shared_catalog",{scope:"global",directory:null}),id=sourceId(item.id);
 const sources=d.registry.sources.map(s=>s.id===id&&/[\\/]hub[\\/]packages[\\/]/.test(s.path)?{...s,enabled:false}:s);
 const servers=d.registry.servers.map(s=>s.id===id?{...s,enabled:false}:s);
 const registry={...d.registry,sources,servers};
 await requireProfile(origin);
 if(!idle())return;
 if(JSON.stringify(registry)!==JSON.stringify(d.registry))await capabilityNative("shared_save",{scope:"global",directory:null,expected:d.content,registry});
 invalidateCapabilities();
}
