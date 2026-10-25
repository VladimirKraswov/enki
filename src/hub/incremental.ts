import type {Message} from '../api/types';
import type {HubRecord} from './records';
// Digests of records the collector reuses unchanged (`stable`): an unchanged
// transcript is not re-serialized and re-hashed every tick.
const stableDigests=new WeakMap<HubRecord,string>();
/** Keep compact receipts on live message objects, never another copy of transcript text.
 * Yield between small batches so collecting large histories cannot monopolize the WebView. */
export async function enqueueChangedRecords(
  records: Iterable<{message:Message;record:HubRecord;stable?:boolean}>, observed: WeakMap<Message,string>,
  enqueue: (records:HubRecord[])=>Promise<unknown>, current:()=>boolean,
  hash: (value:HubRecord)=>Promise<string> = async value => {
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
  },
  yieldToUi:()=>Promise<void> = ()=>new Promise(resolve=>setTimeout(resolve,0)),
) {
  let batch:{message:Message;record:HubRecord;digest:string}[]=[]; let checked=0;
  const flush=async()=>{
    if (!batch.length || !current()) return;
    await enqueue(batch.map(item=>item.record));
    // Record only confirmed native enqueue; a failed handoff is retried later.
    for(const item of batch)observed.set(item.message,item.digest);
    batch=[];
  };
  for(const {message,record,stable} of records){
    if(!current())return;
    let digest=stable?stableDigests.get(record):undefined;
    if(digest===undefined){digest=await hash(record);if(stable)stableDigests.set(record,digest);}
    if(!current())return;
    if(observed.get(message)!==digest)batch.push({message,record,digest});
    if(++checked%25===0){await flush();if(!current())return;await yieldToUi();}
  }
  await flush();
}
