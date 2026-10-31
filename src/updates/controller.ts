export interface Release {digest?:string;channel?:'stable'|'preview';available:boolean;version?:string;kind?:'hot'|'source';notes?:string;revision?:string;binary?:{state:'ready'|'pending'|'unavailable';message?:string}}
export interface NativeStatus {release?:Release|null;downloaded?:boolean;nativeVersion:string;nativeFingerprint:string;hot:{uiVersion:string;activeDigest:string|null;pending:boolean;lastError:string|null};build:{digest?:string|null;stage?:string;mode?:'source'|'binary';receivedBytes?:number;totalBytes?:number;error?:string;version?:string;elapsedSeconds?:number;logPath?:string;logBytes?:number;cache?:{state?:string;hits?:number;misses?:number;writes?:number}};installation?:{version:string;installed:boolean;error?:string|null;phase?:'not_committed'|'interrupted'|'committed';previous?:string|null}}
export interface UpdateState {release:Release|null;status:NativeStatus|null;busy:string;error:string;notice:string;downloaded:boolean;waiting:boolean;channel:'stable'|'preview'}
export type Transport=<T>(action:string,extra?:Record<string,unknown>)=>Promise<T>;
/** Native builder stages in order; each is cancellable and blocks conflicting controls. */
export const ACTIVE_BUILD_STAGES=['preparing','downloading','unpacking','dependencies','runtime','compiling'] as const;
export const BUILD_STAGE_TEXT:Record<string,string>={preparing:'Подготовка обновления',downloading:'Загрузка готового пакета с GitHub',unpacking:'Проверка и распаковка пакета',dependencies:'Установка зависимостей сборки',runtime:'Подготовка компонентов Enki',compiling:'Сборка приложения',ready:'Обновление готово к установке',error:'Подготовка остановлена'};
export class UpdateController {
  private state:UpdateState={release:null,status:null,busy:'',error:'',notice:'',downloaded:false,waiting:false,channel:'stable'};
  private listeners=new Set<()=>void>();
  constructor(private call:Transport,private apply:(kind:'hot'|'source')=>Promise<void>){ }
  snapshot=()=>this.state;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private patch(value:Partial<UpdateState>){this.state={...this.state,...value};for(const fn of this.listeners)fn();}
  async run(action:string,fn:()=>Promise<void>){if(this.state.busy)return;this.patch({busy:action,error:'',notice:''});try{await fn();}catch(e){this.patch({error:String(e),waiting:false});}finally{this.patch({busy:''});}}
  setChannel(channel:'stable'|'preview'){if(this.state.busy||this.state.waiting||this.compiling())return;this.patch({channel,release:null,downloaded:false,error:'',notice:''});}
  prepared(){return this.state.status?.build.stage==='ready'&&!!this.state.release?.digest&&this.state.status.build.digest===this.state.release.digest;}
  /** Any ACTIVE native build phase (hub_updates/build.rs), including runtime preparation. */
  compiling(){return (ACTIVE_BUILD_STAGES as readonly string[]).includes(this.state.status?.build.stage??'');}
  /** Native is the authority for the checked release and installer readiness.
   * Contract (hub_updates::hub_update): the `release` key is always reported —
   * a check caches its available:true answer in the same call before replying,
   * and clears the cache when the head has no newer release. So `release:null`
   * means native confirmed there is nothing pending: an available release the
   * cache no longer confirms is stale (installed or invalidated) and must not
   * keep the badge lit. An absent field (older native build) is not evidence. */
  async refresh(){const status=await this.call<NativeStatus>('status');const patch:Partial<UpdateState>={status};const r=status.release;const cur=this.state.release;
    if(r&&r.channel===this.state.channel){
      if(!cur||cur.available!==r.available||cur.version!==r.version||cur.kind!==r.kind||cur.revision!==r.revision||cur.digest!==r.digest||cur.binary?.state!==r.binary?.state){patch.release=r;patch.downloaded=!!status.downloaded;if(r.available)patch.notice='';}}
    else if(r===null&&cur?.available){patch.release=null;patch.downloaded=false;}
    this.patch(patch);return status;}
  async ready(){const s=await this.refresh();await this.call('ready',{digest:s.hot.activeDigest});}
  check=()=>this.run('check',async()=>{const release=await this.call<Release>('check',{channel:this.state.channel});this.patch({release,downloaded:false,notice:release.available?'':'Установлена актуальная версия.'});});
  download=()=>this.run('download',async()=>{await this.call('download',{channel:this.state.channel});this.patch({downloaded:true,notice:this.state.release?.kind==='hot'?'Подпись обновления проверена.':'Загружаем готовое приложение; сборка не требуется.'});await this.refresh();});
  build=()=>this.run('build',async()=>{
    // The installed builder is the authority; a stale view must never clear a
    // build started elsewhere. New builders preserve attempts automatically.
    const status=await this.refresh();
    if(this.compiling())return;
    const version=status.nativeVersion.split('.').map(Number);
    if(status.build.stage==='error'&&(version[0]<2||version[0]===2&&version[1]===0&&version[2]<6))await this.call('clear');
    await this.call('build',{channel:this.state.channel});await this.refresh();
  });
  cancel=()=>this.run('cancel',async()=>{await this.call('cancel');this.patch({waiting:false});});
  clear=()=>this.run('clear',async()=>{await this.call('clear');await this.refresh();});
  install=(running:boolean)=>{if(!this.state.release?.kind)return Promise.resolve();if(this.state.release.kind==='source'&&running){this.patch({waiting:true,notice:'Установка начнётся после завершения агентов.'});return Promise.resolve();}return this.run('install',async()=>{this.patch({waiting:false});await this.apply(this.state.release!.kind!);});};
  async tick(running:boolean){if(this.state.waiting&&!running&&!this.state.busy)await this.install(false);}
  stopWaiting(){this.patch({waiting:false,notice:''});}
}
let requested=false;
export function requestUpdateSettings(){requested=true;window.dispatchEvent(new Event('arvela-open-updates'));}
/** Render-safe peek: the initial section may be recomputed by React (Suspense
 * retries, discarded concurrent renders) without a new mount, so reading the
 * intent must not consume it. Only a committed mount consumes it in an effect. */
export function peekUpdateSettings(){return requested;}
export function consumeUpdateSettings(){const value=requested;requested=false;return value;}
