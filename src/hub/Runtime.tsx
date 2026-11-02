import { useEffect } from 'react';
import { store } from '../state/store';
import { isNative } from '../native/platform';
import { config, disable, drain, idle, install, request, spool, type HubItem } from './client';
import { assessmentIndex } from '../outcomes/sharing';
import { iterateHubRecords } from './collection';
import { enqueueChangedRecords } from './incremental';
import { hubOrigin } from './identity';
import { pendingTransportFailures, acknowledgeTransportFailures, watchTransportFailures, setTransportOrigin } from './transportDiagnostics';

export function HubRuntime() {
  useEffect(() => {
    if (!isNative()) return;
    let disposed = false, busy = false, lastCatalog = 0, failures = 0, next = 0;
    let collectionScope = '';
    let observed = new WeakMap<import('../api/types').Message, string>();
    async function tick() {
      if (disposed || busy || Date.now() < next) return;
      busy = true;
      try {
        const settings = await config();
        if (disposed || !settings.enabled) { setTransportOrigin(null); return; }
        const [assessments, origin] = await Promise.all([assessmentIndex(), hubOrigin(settings)]);
        if (disposed) return;
        setTransportOrigin(origin);
        const state = store.state;
        const scope = JSON.stringify([origin, state.prefs.workspaceKey ?? state.prefs.endpoint]);
        if (scope !== collectionScope) { observed = new WeakMap(); lastCatalog = 0; collectionScope = scope; }
        await enqueueChangedRecords(iterateHubRecords(state,assessments,settings.shareText), observed,
          batch=>spool('enqueue',batch,undefined,origin),()=>!disposed);
        if (disposed) return;
        const transportFailures=pendingTransportFailures(origin).slice(0,20);
        if(transportFailures.length){
          await spool('enqueue',transportFailures.map(workshopLog=>({workshopLog})),undefined,origin);
          acknowledgeTransportFailures(transportFailures.map(log=>log.requestId));
        }
        await drain();
        failures = 0;
        next = Date.now() + 10000;
        if (!disposed && idle() && !store.state.ui.settingsOpen && Date.now() - lastCatalog > 300000) {
          const items = (await request<{ items: HubItem[] }>('catalog', undefined, origin)).items;
          for (const item of items) {
            if (disposed) return;
            if (settings.installed[item.id] && !item.enabled) await disable(item, origin);
            else if (item.enabled && settings.installed[item.id] && settings.installed[item.id] !== item.revision && item.kind !== 'tool')
              await install(item, true, origin);
          }
          lastCatalog = Date.now();
        }
      } catch {
        failures++;
        next = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(5, failures));
      } finally { busy = false; }
    }
    const timer = setInterval(() => void tick(), 10000);
    const unwatch = watchTransportFailures(()=>{next=0;void tick();});
    void tick();
    return () => { disposed = true; clearInterval(timer); unwatch(); };
  }, []);
  return null;
}
