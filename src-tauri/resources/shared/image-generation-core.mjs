import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';
import {imageContext,imageBytes,reserveImage,recordImage,latestImage,rememberImage,withImageState} from './image-generation-context.mjs';
let requestSequence = 0;
/** Order generations by invocation, not by whichever async config/context read finished first. */
const nextRequestOrder = () => Date.now() * 1000 + (++requestSequence % 1000);
const TERMINAL = ['completed', 'failed', 'cancelled'];
const ATTEMPT_LIMIT = 2;
export function validateConfig(c){
 if(!c||typeof c.enabled!=='boolean'||typeof c.endpoint!=='string'||!c.endpoint)throw Error('Некорректные настройки генератора');
 const u=new URL(c.endpoint);
 const ip=isIP(u.hostname)===4?u.hostname.split('.').map(Number):[];
 const local=u.hostname==='localhost'||ip.length===4&&(ip[0]===127||ip[0]===10||ip[0]===192&&ip[1]===168||ip[0]===172&&ip[1]>=16&&ip[1]<=31);
 if(u.username||u.password||u.search||u.hash||!(u.protocol==='https:'||u.protocol==='http:'&&local))throw Error('Используйте HTTPS либо HTTP локальной сети, без ключа в URL');
 return {enabled:c.enabled,endpoint:u.href.replace(/\/$/,'')};
}
export async function bounded(response,max=12*1024*1024){
 if(!response.ok){
  const body=await response.text().catch(()=>'');await response.body?.cancel().catch(()=>{});
  let detail='';
  try{const parsed=JSON.parse(body);detail=parsed?.error?.message??'';}catch{}
  const hint=[401,403].includes(response.status)?'проверьте API-ключ генератора':response.status===413?'исходник больше 8 МиБ':response.status===429?'очередь занята':response.status===503?'движок недоступен':response.status===404?'проверьте адрес API':[400,422].includes(response.status)?'параметры не приняты сервисом':'проверьте настройки и состояние сервиса';
  throw Error(`Генератор HTTP ${response.status}: ${detail||hint}`);
 }
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>max){await response.body?.cancel().catch(()=>{});throw Error('Слишком большой ответ генератора')}chunks.push(chunk)}
 return Buffer.concat(chunks);
}
export function createImages({configFile,cwd=process.cwd(),fetcher=fetch,token=()=>process.env.ENKI_IMAGE_API_KEY||'',stateTransaction}){
 const config=async()=>{const stat=await fs.lstat(configFile).catch(()=>{throw Error('Сначала сохраните настройки генератора в Enki → Изображения')});if(stat.isSymbolicLink()||stat.size>16384)throw Error('Конфигурация генератора недоступна');const c=validateConfig(JSON.parse(await fs.readFile(configFile,'utf8')));if(!c.enabled)throw Error('Включите генерацию изображений в настройках Enki');return c;};
 const wait=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted){reject(Error('Ожидание отменено'));return}const finish=()=>{signal?.removeEventListener('abort',abort);resolve()};const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('Ожидание отменено'))};signal?.addEventListener('abort',abort,{once:true})});
 const request=async(c,route,{method='GET',body,signal,timeout=30000,raw=false}={})=>{
  const ac=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(timeout)]);
  for(let attempt=0;;attempt++){
   let response;
   try{response=await fetcher(c.endpoint+route,{method,signal:ac,redirect:'error',headers:{...(token()?{Authorization:'Bearer '+token()}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
   catch(error){if(method!=='GET'||attempt>=2||ac.aborted)throw error;await wait(600*(attempt+1),ac);continue}
   if(method==='GET'&&[502,503,504].includes(response.status)&&attempt<2){await response.body?.cancel();await wait(600*(attempt+1),ac);continue}
   const bytes=await bounded(response);
   if(raw)return bytes;
   if(!bytes.length)return null;
   try{return JSON.parse(bytes);}catch{throw Error('Сервис вернул некорректный JSON')}
  }
 };
 const save=async(jid,name,bytes)=>{
  if(!/^[a-f0-9-]{36}$/.test(jid)||!/^image-\d{2}\.png$/.test(name))throw Error('Некорректный файл результата');
  if(bytes.length>8*1048576)throw Error('PNG больше 8 МБ; запросите меньший размер');
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)<1||bytes.readUInt32BE(20)<1||bytes.readUInt32BE(16)>2048||bytes.readUInt32BE(20)>2048)throw Error('Сервис вернул повреждённый или слишком большой PNG');
  const base=await fs.realpath(cwd);const dir=path.join(base,'.enki','generated-images',jid);
  let current=base;for(const segment of ['.enki','generated-images',jid]){current=path.join(current,segment);await fs.mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const stat=await fs.lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Папка результата не должна быть ссылкой')}
  const dest=path.join(dir,name);
  try{await fs.writeFile(dest,bytes,{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e;const st=await fs.lstat(dest);if(st.isSymbolicLink()||st.size!==bytes.length||!crypto.timingSafeEqual(crypto.createHash('sha256').update(await fs.readFile(dest)).digest(),crypto.createHash('sha256').update(bytes).digest()))throw Error('Существующий результат отличается; файл сохранён без перезаписи')}
  return pathToFileURL(dest).href;
 };
 /** Readiness: the engine reports ready when ComfyUI answers; degraded means it is down. */
 const ready=async(c,signal)=>{
  const deadline=Date.now()+15000;
  for(;;){
   const health=await request(c,'/health',{signal,timeout:12000});
   if(health?.status==='ready')return health;
   if(Date.now()>=deadline)throw Error('Движок генерации не отвечает. Задание не создано; повторите позже.');
   await wait(1000,signal);
  }
 };
 const matches=(metadata,payload)=>(metadata?.request?.prompt===payload.prompt
  &&JSON.stringify(metadata.request.items??[])===JSON.stringify(payload.items??[])
  &&metadata.request.width===payload.width&&metadata.request.height===payload.height
  &&metadata.request.seed===payload.seed&&(metadata.request.strength??null)===(payload.strength??null)
  &&metadata.request.source===!!payload.source_image);
 /** A lost acknowledgement is recovered by matching the newest queued/running job, never by a new POST. */
 const recover=async(c,payload,signal)=>{
  for(const state of ['running','queued']){
   const list=await request(c,'/jobs?state='+state+'&limit=20',{signal});
   for(const job of list?.items??[]){
    const metadata=await request(c,'/jobs/'+job.id+'/metadata',{signal});
    if(matches(metadata,payload))return job;
   }
  }
  throw Error('Запрос мог быть отправлен, но подтверждение потеряно, а подходящей задачи в очереди нет. Создайте задание с новым request_key только если готовы к дублю.');
 };
 return async(name,args={},signal)=>{
  const order=nextRequestOrder();
  const c=await config();
  const context=args.__enkiImageContext&&name!=='image_status'&&name!=='cancel_image'?await imageContext(configFile,cwd,args.__enkiImageContext):null;
  if(context&&stateTransaction)context.transaction=stateTransaction;
  const requireContext=()=>{if(!context)throw Error('Для рисования и редактирования отправьте запрос из обновлённого Enki. Нужен контекст текущей сессии.');return context;};
  if(args.include_vision&&context?.supportsVision!==true)throw Error('Текущая модель не поддерживает Vision. Повторите чтение с include_vision=false; не утверждайте, что видели изображение.');
  const source=async(ref)=>{
   const ctx=requireContext();
   if(typeof ref!=='string')throw Error('Выберите исходник через image_inputs: attachment:1 или latest');
   if(/^attachment:[1-4]$/.test(ref)){
    if(ctx.imagesFromPrevious&&ctx.unsupported?.length)throw Error('Новое вложение не подходит для редактирования. Старый исходник не будет использован вместо него; приложите PNG, JPEG или WebP.');
    const input=ctx.images[Number(ref.split(':')[1])-1];if(!input)throw Error('В текущем сообщении нет такого вложения. Вызовите image_inputs.');
    return {bytes:imageBytes(input.data,input.mime),mime:input.mime,ref,sha256:input.sha256,width:input.width,height:input.height};
   }
   const latest=await latestImage(ctx);
   if(ref!=='latest'||!latest)throw Error('Последней генерации в этой сессии ещё нет. Прикрепите изображение или сначала сгенерируйте его.');
   if(!/^[a-f0-9-]{36}$/.test(latest.job_id)||!/^image-\d{2}\.png$/.test(latest.name))throw Error('Некорректный сохранённый исходник');
   let raw;
   try{
    let current=await fs.realpath(cwd);
    for(const part of ['.enki','generated-images',latest.job_id,latest.name]){current=path.join(current,part);const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw Error('Сохранённый исходник не должен быть ссылкой');if(part===latest.name&&(!stat.isFile()||stat.size>8*1048576))throw Error('Сохранённый исходник повреждён');}
    raw=await fs.readFile(current);
   }catch(error){if(error.code!=='ENOENT')throw error;raw=await request(c,'/jobs/'+latest.job_id+'/images/'+latest.name,{signal,raw:true});if(!raw)throw Error('Файл прошлого результата уже удалён сервисом; приложите исходник заново.');}
   if(crypto.createHash('sha256').update(raw).digest('hex')!==latest.sha256)throw Error('Исходный результат изменился. Перерисовка не запускалась.');
   imageBytes(raw.toString('base64'),'image/png');
   return {bytes:raw,mime:'image/png',ref,sha256:latest.sha256,job_id:latest.job_id,width:raw.readUInt32BE(16),height:raw.readUInt32BE(20)};
  };
  if(name==='image_inputs'){
   const ctx=requireContext(),latest=await latestImage(ctx);
   const attempts=await withImageState(ctx,state=>state.requests[ctx.messageID]?.length??0);
   const inputs=ctx.images.map((input,index)=>({source:'attachment:'+(index+1),name:input.name,mime:input.mime,sha256:input.sha256,width:input.width,height:input.height}));
   return {inputs,inputs_from_previous_message:ctx.imagesFromPrevious===true,latest:latest?{source:'latest',job_id:latest.job_id}:null,unsupported:ctx.unsupported??[],can_review:ctx.supportsVision===true,attempts_remaining:Math.max(0,ATTEMPT_LIMIT-attempts),note:'Используйте edit_image с точным source. Для «поменяй результат» source=latest; для «заново перерисуй исходник» attachment:N. Для просмотра последней генерации вызовите get_images(latest.job_id, include_vision=true), только если can_review=true. Максимум две генерации на одно сообщение пользователя. Перерисовка всего кадра; точечная замена объектов не гарантируется.'};
  }
  if(name==='image_status'){
   if(!args.job_id)return await request(c,'/health',{signal,timeout:12000});
   if(!/^[a-f0-9-]{36}$/.test(args.job_id))throw Error('Некорректный идентификатор задания');
   const end=Date.now()+Math.max(0,Math.min(20,Number(args.wait_seconds??20)))*1000;
   let state;
   do {state=await request(c,'/jobs/'+args.job_id,{signal});if(!state||TERMINAL.includes(state.state)||Date.now()>=end)break;await wait(1000,signal);}while(Date.now()<=end);
   return state;
  }
  if(name==='cancel_image'){
   if(!/^[a-f0-9-]{36}$/.test(args.job_id))throw Error('Некорректный идентификатор задания');
   return await request(c,'/jobs/'+args.job_id,{method:'DELETE',signal});
  }
  if(name==='generate_image'||name==='generate_icon_pack'||name==='edit_image'){
   const ctx=requireContext();
   if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>2000||typeof args.request_key!=='string'||!args.request_key||args.request_key.length>160)throw Error('Нужны короткий prompt и стабильный request_key');
   const items=name==='generate_icon_pack'?args.items:[];
   if(!Array.isArray(items)||items.length>8||name==='generate_icon_pack'&&!items.length||items.some(s=>typeof s!=='string'||!s.trim()||s.length>160))throw Error('В наборе должно быть от 1 до 8 кратких описаний');
   const input=name==='edit_image'?await source(args.source):null;
   if(input&&items.length)throw Error('Редактирование принимает один исходник и один prompt, без набора');
   const health=await ready(c,signal);
   const model=health.model??{},multiple=model.multiple??16,maxSide=model.max_side??1536,maxPixels=model.max_pixels??1048576;
   // Sampling presets come from the service: fast is the 4-step Lightning pass,
   // best is the base model at CFG 4 and takes minutes. A stubborn instruction
   // (hair colour, small objects) needs best; anything else stays fast.
   const qualities=model.qualities??{};
   const quality=args.quality??model.default_quality??'fast';
   if(Object.keys(qualities).length&&!qualities[quality])throw Error('Неизвестное качество: '+quality+'. Доступно: '+Object.keys(qualities).join(', '));
   const variants=args.variants??1;
   if(!Number.isInteger(variants)||variants<1||variants>(model.max_variants??1))throw Error('variants: целое число от 1 до '+(model.max_variants??1));
   if(variants>1&&items.length)throw Error('Варианты и набор предметов вместе не поддерживаются');
   let width=args.width??1024,height=args.height??1024;
   if(input&&(args.width===undefined||args.height===undefined)&&Number.isFinite(input.width)&&Number.isFinite(input.height)&&input.width>0&&input.height>0){
    const ratio=Math.max(1/6,Math.min(6,input.width/input.height));
    const area=1024*1024;
    const snap=v=>Math.floor(v/multiple)*multiple;
    if(args.width===undefined)width=Math.min(maxSide,Math.max(256,snap(Math.sqrt(area*ratio))));
    if(args.height===undefined)height=Math.min(maxSide,Math.max(256,snap(width/ratio)));
    while(width*height>maxPixels){if(width>=height)width-=multiple;else height-=multiple;}
   }
   const seed=args.seed??42;
   if(![width,height,seed].every(Number.isInteger)||width<256||height<256||width>maxSide||height>maxSide||width%multiple||height%multiple||width*height>maxPixels||seed<0||seed>2147483647)throw Error(`Некорректные размеры или seed: стороны 256–${maxSide}, кратны ${multiple}, вместе не больше ${maxPixels} пикселей`);
   let strength;
   if(input&&args.strength!==undefined){
    if(typeof args.strength!=='number'||!Number.isFinite(args.strength)||args.strength<0||args.strength>1)throw Error('strength: число от 0 до 1');
    strength=args.strength;
   }
   const payload={prompt:args.prompt.trim(),...(items.length?{items}:{}),width,height,seed,quality,...(variants>1?{variants}:{}),...(strength!==undefined?{strength}:{}),...(input?{source_image:{data_base64:input.bytes.toString('base64')}}:{})};
   const reserved=await reserveImage(ctx,args.request_key,{...payload,...(input?{source_image:{sha256:input.sha256,ref:input.ref}}:{})},order);if(reserved.cached)return reserved.cached;
   if(reserved.pending){const previous=await recover(c,payload,signal);await recordImage(ctx,args.request_key,previous);return previous;}
   const result=await request(c,'/jobs',{method:'POST',body:payload,signal,timeout:60000});
   if(!result?.id)throw Error('Сервис не вернул идентификатор задания; проверьте очередь перед повтором.');
   await recordImage(ctx,args.request_key,result);return result;
  }
  if(name==='get_images'){
   if(!/^[a-f0-9-]{36}$/.test(args.job_id))throw Error('Некорректное задание');
   const state=await request(c,'/jobs/'+args.job_id,{signal});
   if(!state)throw Error('Задание не найдено');
   if(!TERMINAL.includes(state.state))return state;
   if(!Array.isArray(state.images)||state.images.length>8)throw Error('Некорректный список изображений');
   const images=[],vision=[];
   for(const image of state.images){
    if(!image||typeof image.name!=='string'||!/^image-\d{2}\.png$/.test(image.name))throw Error('Некорректное имя файла');
    const raw=await request(c,'/jobs/'+args.job_id+'/images/'+image.name,{signal,timeout:120000,raw:true});
    if(!raw?.length)throw Error('Сервис не вернул файл изображения');
    const url=await save(args.job_id,image.name,raw);
    if(context&&state.state==='completed'&&image.name==='image-01.png')await rememberImage(context,args.job_id,image.name,raw);
    images.push({name:image.name,url,prompt:image.prompt,seed:image.seed,width:image.width,height:image.height,bytes:image.bytes});
    if(args.include_vision)vision.push(raw.toString('base64'));
   }
   const metadata=state.state==='completed'&&images.length?await request(c,'/jobs/'+args.job_id+'/metadata',{signal}).catch(()=>null):null;
   return {enkiImages:1,status:state.state,images,vision,variant:images.length>1?'set':undefined,model:metadata?.inference?.model,inference:metadata?.inference,source:metadata?.request?.source?{mode:'image-edit',strength:metadata.request.strength??null}:undefined,error:state.error,note:'PNG сохранены в .enki/generated-images. Для следующей правки этого результата используйте edit_image(source=latest). Не более двух генераций на одну просьбу, включая исправления. Проверяйте результат только при поддержке Vision.'};
  }
  throw Error('Неизвестный инструмент');
 };
}
