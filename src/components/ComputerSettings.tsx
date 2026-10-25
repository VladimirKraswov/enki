import { SettingHelp } from "./SettingHelp";
import { platform } from "../native/platform";
import {useEffect,useState} from "react";
import {store,useAppState} from "../state/store";
import {computerReadinessError,isLocalComputer,type ComputerStatus} from "../state/computer";
import {invalidateCapabilities} from "../capabilities/integration";
import {COMPUTER_SERVER,reservedServerEnabled,setReservedServer} from "../capabilities/reserved";
const err=(e:unknown)=>e instanceof Error?e.message:String(e);
async function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>{return(await import("@tauri-apps/api/core")).invoke<T>(command,args);}
export function ComputerSettings(){
  const s=useAppState();
  const [status,setStatus]=useState<ComputerStatus|null>(null),[connection,setConnection]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const native="__TAURI_INTERNALS__" in window,local=isLocalComputer(s.prefs.endpoint,!!store.currentHost());
  const running=[...Object.values(s.activityStatuses),...Object.values(s.statuses)].some(x=>x.type!=="idle");
  const refresh=async()=>{
    if(!native)return;
    setStatus(await invoke<ComputerStatus>("computer_status"));
    if(local){try{setConnection(await reservedServerEnabled(COMPUTER_SERVER)?"configured":"not_configured");}catch{setConnection("unavailable");}}
  };
  useEffect(()=>{void refresh().catch(e=>setError(err(e)));},[s.prefs.endpoint,s.directory]);
  // Live state comes from the current chat worker's shared-MCP report.
  const live=store.mcpServerStatuses(s.activeSessionId).find(x=>x.id===COMPUTER_SERVER.id);
  const action=async(name:"permissions"|"stop")=>{
    setBusy(true);setError("");setNotice("");
    try{const text=await invoke<string>("computer_action",{action:name});setNotice(name==="stop"?"Управление выключено. Текущие сеансы Cua Driver отозваны; новые действия заблокированы до подключения.":text);await refresh();}
    catch(e){setError(err(e));await refresh().catch(()=>{});}finally{setBusy(false);}
  };
  const apply=async(enabled:boolean)=>{
    if(!status||!local||running||busy)return;
    const directory=s.directory,workspace=s.prefs.workspaceKey??s.prefs.endpoint;
    setBusy(true);setError("");setNotice("");let written=false;
    try{
      if(workspace!==(store.state.prefs.workspaceKey??store.state.prefs.endpoint))throw new Error("Подключение изменилось. Откройте настройки заново.");
      if(enabled)await invoke("computer_action",{action:"resume"});
      await invoke("computer_set_enabled",{enabled});
      // CAS update of Enki's reserved registry entry; a foreign entry with this id is never replaced.
      try{await setReservedServer(COMPUTER_SERVER,enabled);written=true;}
      catch(e){if(enabled)await invoke("computer_set_enabled",{enabled:false});throw e;}
      invalidateCapabilities();
      // The reserved registry entry is committed: idle chats reopen with it, busy ones once idle.
      const refreshed=await store.capabilitiesCommitted(null).catch(()=>null);
      if(!refreshed&&directory)await store.configureSharedTools(directory).catch(()=>{});
      if(enabled){
        const ready=await invoke<ComputerStatus>("computer_status");
        const problem=computerReadinessError(ready);if(problem)throw new Error(problem);
        setNotice(refreshed?`Инструменты управления добавлены в общий набор. Новые и свободные открытые чаты получат их сразу${refreshed.pending?`; занятые (${refreshed.pending}) — после завершения текущей работы`:""}.`
          :"Инструменты управления добавлены в общий набор. Новые чаты получат их сразу, открытые — после переоткрытия.");
      }else setNotice("Управление выключено: локальный выключатель блокирует действия и в уже открытых чатах. Остальные инструменты сохранены.");
      await refresh();
    }catch(e){if(enabled)await invoke("computer_set_enabled",{enabled:false}).catch(()=>{});setError(`${written?"Конфигурация сохранена с резервной копией, но подключение не завершилось. ":""}${err(e)}`);await refresh().catch(()=>{});}
    finally{setBusy(false);}
  };
  const p=status?.permissions, os=platform(), windows=os==="windows";
  return <section className="computer-settings" aria-label="Управление компьютером">
    <h4>Отдельный курсор агента <SettingHelp topic="computer.control" title="Отдельный курсор агента"/></h4>
    <p>Снимки и текст выбранного окна получает модель.</p>
    {!["macos","windows"].includes(os)?<p role="status">Управление окнами Cua Driver на этой платформе недоступно. Управляемый браузер доступен в отдельном разделе настроек.</p>
      :!native?<p>Откройте установленное приложение Desktop.</p>:<>
      <div className="kv"><span>Драйвер</span><b>{status?status.installed?status.version:"Не установлен":"Проверка…"}</b></div>
      <div className="kv"><span>Управление</span><b>{status?.enabled?computerReadinessError(status)?"Не готово":"Включено":"Выключено"}</b></div>
      <div className="kv"><span>Общий набор инструментов</span><b>{connection==="configured"?"Добавлено":connection==="not_configured"?"Не добавлено":connection==="unavailable"?"Не прочитан":"—"}</b></div>
      <div className="kv"><span>Текущий чат</span><b>{!live?"Нет отчёта агента":live.state==="connected"?`Подключено · ${live.tools.length} инструментов`:live.state==="checking"?"Подключается":"Ошибка подключения"}</b></div>
      {!windows&&<><div className="kv"><span>Доступность macOS</span><b>{p?.accessibility===true?"Разрешена":p?.accessibility===false?"Нужен доступ":"Не проверена"}</b></div>
      <div className="kv"><span>Запись экрана</span><b>{p?.screen_recording===true?"Разрешена":p?.screen_recording===false?"Нужен доступ":"Не проверена"}</b></div></>}
      {windows&&<><div className="kv"><span>Интерактивный сеанс Windows</span><b>{p?.interactive_session===true?"Доступен":"Не подтверждён"}</b></div><div className="kv"><span>UI Automation</span><b>{p?.uia===true&&p?.windows_visible===true?"Готово":"Не подтверждено"}</b></div></>}
      {p?.status==="refused"&&status&&<p role="status">{computerReadinessError(status)}</p>}
      <p className="handoff-note">Некоторые приложения требуют активного окна.</p>
      {!local&&<p role="status">Эта интеграция управляет компьютером, на котором открыт Desktop. Для настройки выберите «Этот компьютер».</p>}
      {running&&<p role="status">Подключение можно менять после завершения агента. Экстренная остановка доступна сейчас.</p>}
      <div className="btn-row computer-actions">
        <button className="btn" disabled={busy} onClick={()=>void refresh().catch(e=>setError(err(e)))}>Проверить</button>
        {status?.installed?<button className="btn" disabled={busy} onClick={()=>void action("permissions")}>{windows?"Диагностика драйвера…":"Разрешения macOS…"}</button>:<button className="btn" onClick={()=>void import("@tauri-apps/plugin-opener").then(x=>x.openUrl("https://cua.ai/docs/cua-driver"))}>Установка Cua Driver</button>}
        <button className="btn primary" disabled={busy||running||!local||!status?.installed} onClick={()=>void apply(true)}>Подключить</button>
        <button className="btn" disabled={busy||running||!local||!status?.enabled} onClick={()=>void apply(false)}>Выключить</button>
      </div>
      <div className="computer-stop"><button className="btn" disabled={busy||!status?.installed} onClick={()=>void action("stop")}>Остановить управление</button><small>{windows ? "Выключает новые действия Desktop; сеансы драйвера других приложений сохраняются." : "Выключает новые действия Desktop и отзывает все текущие сеансы Cua Driver на этом Mac. Следующее нажатие «Подключить» заново запускает отозванный драйвер."}</small></div>
    </>}
    {error&&<p className="composer-error" role="alert">{error}</p>}{notice&&<p className="settings-notice" role="status">{notice}</p>}
  </section>;
}
