import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';
import {imageContext,imageBytes,imageRequestKey,withImageState,reserveImage,recordImage,latestImage,rememberImage} from './image-generation-context.mjs';
export function validateConfig(c){
 if(!c||typeof c.enabled!=='boolean'||!['enki','openai'].includes(c.provider)||typeof c.model!=='string'||!c.model.trim()||c.model.length>200)throw Error('Некорректные настройки генератора');
 const u=new URL(c.endpoint);const ip=isIP(u.hostname)===4?u.hostname.split('.').map(Number):[];const local=u.hostname==='localhost'||ip.length===4&&(ip[0]===127||ip[0]===10||ip[0]===192&&ip[1]===168||ip[0]===172&&ip[1]>=16&&ip[1]<=31);
 if(u.username||u.password||u.search||u.hash||!(u.protocol==='https:'||u.protocol==='http:'&&local))throw Error('Используйте HTTPS либо HTTP локальной сети, без ключа в URL');
 return {...c,endpoint:u.href.replace(/\/$/,'')};
}
export async function bounded(response,max=12*1024*1024){
 if(!response.ok){await response.body?.cancel();throw Error(`Генератор HTTP ${response.status}: ${[401,403].includes(response.status)?'проверьте API-ключ':response.status===429?'очередь занята':response.status===503?'модель загружается или сервис недоступен':[400,422].includes(response.status)?'параметры не поддерживаются; проверьте размеры, модель и material':'проверьте настройки и статус задания'}`)}
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>max){await response.body?.cancel().catch(()=>{});throw Error('Слишком большой ответ генератора')}chunks.push(chunk)}
 return Buffer.concat(chunks);
}
export function createImages({configFile,cwd=process.cwd(),fetcher=fetch,token=()=>process.env.ENKI_IMAGE_API_KEY||'',stateTransaction}){
 const config=async()=>{const stat=await fs.lstat(configFile).catch(()=>{throw Error('Сначала сохраните настройки генератора в Enki → Изображения')});if(stat.isSymbolicLink()||stat.size>16384)throw Error('Конфигурация генератора недоступна');const c=validateConfig(JSON.parse(await fs.readFile(configFile,'utf8')));if(!c.enabled)throw Error('Включите генерацию изображений в настройках Enki');return c;};
 const wait=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted){reject(Error('Ожидание отменено'));return}const finish=()=>{signal?.removeEventListener('abort',abort);resolve()};const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('Ожидание отменено'))};signal?.addEventListener('abort',abort,{once:true})});
 const request=async(c,route,method='GET',body,signal,key)=>{
  const multipart=body instanceof FormData;
  const ac=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(c.provider==='openai'&&method==='POST'?75000:30000)]);
  for(let attempt=0;;attempt++){
   let response;
   try{response=await fetcher(c.endpoint+route,{method,signal:ac,redirect:'error',headers:{...(token()?{Authorization:'Bearer '+token()}:{}),...(body&&!multipart?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:multipart?body:body?JSON.stringify(body):undefined});}
   catch(error){if(method!=='GET'||attempt>=2||ac.aborted)throw error;await wait(600*(attempt+1),ac);continue}
   if(method==='GET'&&[502,503,504].includes(response.status)&&attempt<2){await response.body?.cancel();await wait(600*(attempt+1),ac);continue}
   return bounded(response);
  }
 };
 const save=async(jid,name,bytes)=>{
  if(!/^[a-f0-9-]{36}$/.test(jid)||!/^(?:(?:image|preview)-\d{2}|(?:preview-)?(?:normal|height|roughness|metallic|relight|relight-right|tile-preview))\.png$|^images\.zip$|^manifest\.json$/.test(name))throw Error('Некорректный файл результата');
  if(name.endsWith('.png')&&bytes.length>4*1048576)throw Error('PNG больше 4 МБ; запросите меньший размер');
  if(name.endsWith('.png')&&(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)<1||bytes.readUInt32BE(20)<1||bytes.readUInt32BE(16)>2048||bytes.readUInt32BE(20)>2048))throw Error('Сервис вернул повреждённый или слишком большой PNG');
  const base=await fs.realpath(cwd);const dir=path.join(base,'.enki','generated-images',jid);
  let current=base;for(const segment of ['.enki','generated-images',jid]){current=path.join(current,segment);await fs.mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const stat=await fs.lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Папка результата не должна быть ссылкой')}
  const dest=path.join(dir,name);
  try{await fs.writeFile(dest,bytes,{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e;const st=await fs.lstat(dest);if(st.isSymbolicLink()||st.size!==bytes.length||!crypto.timingSafeEqual(crypto.createHash('sha256').update(await fs.readFile(dest)).digest(),crypto.createHash('sha256').update(bytes).digest()))throw Error('Существующий результат отличается; файл сохранён без перезаписи')}
  return pathToFileURL(dest).href;
 };
 return async(name,args={},signal)=>{
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
   }catch(error){if(error.code!=='ENOENT')throw error;raw=await request(c,'/jobs/'+latest.job_id+'/files/'+latest.name,'GET',undefined,signal);}
   if(crypto.createHash('sha256').update(raw).digest('hex')!==latest.sha256)throw Error('Исходный результат изменился. Перерисовка не запускалась.');
   imageBytes(raw.toString('base64'),'image/png');
   return {bytes:raw,mime:'image/png',ref,sha256:latest.sha256,job_id:latest.job_id,width:raw.readUInt32BE(16),height:raw.readUInt32BE(20)};
  };
  if(name==='image_inputs'){
   const ctx=requireContext(),latest=await latestImage(ctx);
   const attempts=await withImageState(ctx,state=>state.requests[ctx.messageID]?.length??0);
   const inputs=ctx.images.map((input,index)=>({source:'attachment:'+(index+1),name:input.name,mime:input.mime,sha256:input.sha256,width:input.width,height:input.height}));
   return {inputs,inputs_from_previous_message:ctx.imagesFromPrevious===true,latest:latest?{source:'latest',job_id:latest.job_id}:null,unsupported:ctx.unsupported??[],can_review:ctx.supportsVision===true,attempts_remaining:Math.max(0,2-attempts),note:'Используйте edit_image с точным source. Для «поменяй результат» source=latest; для «заново перерисуй исходник» attachment:N. Для просмотра последней генерации вызовите get_images(latest.job_id, include_vision=true), только если can_review=true. inputs_from_previous_message означает сохранённый исходник из предыдущего сообщения этой сессии. Новое вложение не подменяет последний результат автоматически. Максимум две генерации на одно сообщение пользователя. Перерисовка всего кадра; точечная замена объектов не гарантируется.'};
  }
  if(name==='image_status'){
   if(!args.job_id)return JSON.parse(await request(c,c.provider==='enki'?'/health':'/models','GET',undefined,signal));
   if(c.provider!=='enki'||!/^[a-f0-9-]{36}$/.test(args.job_id))throw Error('Некорректный идентификатор задания');
   const end=Date.now()+Math.max(0,Math.min(20,Number(args.wait_seconds??20)))*1000;
   let state;
   do {state=JSON.parse(await request(c,'/jobs/'+args.job_id,'GET',undefined,signal));if(!['queued','running'].includes(state.status)||Date.now()>=end)break;await wait(1000,signal);}while(Date.now()<=end);
   return state;
  }
  if(name==='cancel_image'){
   if(c.provider!=='enki'||!/^[a-f0-9-]{36}$/.test(args.job_id))throw Error('Этот провайдер не поддерживает отмену задания');
   return JSON.parse(await request(c,'/jobs/'+args.job_id,'DELETE',undefined,signal));
  }
  if(name==='generate_image'||name==='generate_icon_pack'||name==='generate_material'||name==='edit_image'){
   const ctx=requireContext();
   if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>2000||typeof args.request_key!=='string'||!args.request_key||args.request_key.length>160)throw Error('Нужны короткий prompt и стабильный request_key');
   const items=name==='generate_icon_pack'?args.items:[];
   if(!Array.isArray(items)||items.length>8||name==='generate_icon_pack'&&!items.length||items.some(s=>typeof s!=='string'||!s.trim()||s.length>160))throw Error('В наборе должно быть от 1 до 8 кратких описаний');
   const input=name==='edit_image'?await source(args.source):null;
   if(input&&c.provider!=='enki')throw Error('Редактирование по исходнику требует Enki CPU. Этот OpenAI-совместимый адаптер поддерживает только генерацию по тексту; исходник не будет проигнорирован.');
   let defaultWidth=c.provider==='enki'&&c.model==='lcm-dreamshaper-v7'?512:1024,defaultHeight=defaultWidth;
   if(input&&Number.isFinite(input.width)&&Number.isFinite(input.height)&&input.width>0&&input.height>0){
    const ratio=Math.max(1/6,Math.min(6,input.width/input.height));
    defaultWidth=Math.min(1536,Math.max(256,Math.floor(Math.sqrt(1048576*ratio)/8)*8));
    defaultHeight=Math.min(1536,Math.max(256,Math.floor((defaultWidth/ratio)/8)*8));
    while(defaultWidth*defaultHeight>1048576){if(defaultWidth>=defaultHeight)defaultWidth-=8;else defaultHeight-=8;}
   }
   const width=args.width??defaultWidth,height=args.height??defaultHeight,steps=args.steps??4,seed=args.seed??42;
   if(![width,height,steps,seed].every(Number.isInteger)||width<256||height<256||width>2048||height>2048||width%8||height%8||c.provider==='enki'&&(width>1536||height>1536||width*height>1048576||c.model==='lcm-dreamshaper-v7'&&width*height>640000)||steps<2||steps>8||seed<0||seed>2147483647)throw Error('Некорректные размеры, число шагов или seed');
   if(c.provider==='openai'){
    if(name==='generate_material')throw Error('Материалы с normal/height-картами требуют провайдера Enki CPU');
    if(items.length)throw Error('Пакеты иконок требуют провайдера Enki; для другого API вызывайте generate_image по одному');
    const payload={model:c.model,prompt:args.prompt,size:`${width}x${height}`,n:1,response_format:'b64_json'};
    const reserved=await reserveImage(ctx,args.request_key,payload);if(reserved.cached)return reserved.cached;
    if(reserved.pending)throw Error('Запрос уже отправлялся; подтверждение потерялось. Этот API не поддерживает безопасное восстановление статуса. Новый POST не выполняется.');
    const result=JSON.parse(await request(c,'/images/generations','POST',payload,signal,imageRequestKey(ctx,args.request_key)));
    const b64=result.data?.[0]?.b64_json;
    if(typeof b64!=='string'||b64.length>12*1048576)throw Error('API должен вернуть data[0].b64_json; загрузка произвольных URL отключена');
    const jid=crypto.randomUUID();const url=await save(jid,'image-01.png',Buffer.from(b64,'base64'));
    const visible={enkiImages:1,status:'completed',images:[{name:'image-01.png',url}],note:'Проверьте результат. Повторный POST не выполняется автоматически.'};
    await recordImage(ctx,args.request_key,visible);
    return {...visible,vision:args.include_vision?[b64]:[]};
   }
   const readyBy=Date.now()+20000;
   while(true){const health=JSON.parse(await request(c,'/health','GET',undefined,signal));if(health.status==='ready')break;if(health.status==='error')throw Error('Модель генератора не загрузилась. Проверьте журнал сервиса; генерация не запускалась.');if(Date.now()>=readyBy)throw Error('Модель ещё загружается; генерация не запускалась. Проверьте image_status и используйте тот же request_key.');await wait(1000,signal)}
   if(input&&(!Number.isFinite(args.strength??0.7)||(args.strength??0.7)<0.5||(args.strength??0.7)>0.95))throw Error('Сила перерисовки должна быть от 0.5 до 0.95: меньше сохраняет исходник, больше сильнее меняет композицию.');
   if(input&&c.model==='lcm-dreamshaper-v7')throw Error('Для перерисовки выберите enki-image-auto или sdxl-lightning в настройках.');
   const payload={model:c.model,prompt:name==='generate_material'?'seamless texture swatch, PBR albedo material scan, full frame closeup, perpendicular flat view, even diffuse lighting, '+args.prompt+', no scene, no perspective, no objects, no text':args.prompt,width,height,steps,seed,items,...(name==='generate_material'?{material:args.material??{}}:{}),...(input?{source_image:{data_base64:input.bytes.toString('base64'),mime_type:input.mime},edit_strength:args.strength??0.7}:{})};
   const reserved=await reserveImage(ctx,args.request_key,{...payload,...(input?{source_image:{sha256:input.sha256,ref:input.ref}}:{})});if(reserved.cached)return reserved.cached;
   if(reserved.pending){
    let previous;
    try{previous=JSON.parse(await request(c,'/jobs/by-key?request_key='+encodeURIComponent(imageRequestKey(ctx,args.request_key)),'GET',undefined,signal));}
    catch{throw Error('Запрос уже отправлялся, но статус пока не восстановлен. Новая генерация не запускается. Проверьте соединение и повторите этот же ключ.');}
    await recordImage(ctx,args.request_key,previous);return previous;
   }
   const result=JSON.parse(await request(c,'/jobs','POST',payload,signal,imageRequestKey(ctx,args.request_key)));
   await recordImage(ctx,args.request_key,result);return result;
  }
  if(name==='get_images'){
   if(c.provider!=='enki'||!/^[a-f0-9-]{36}$/.test(args.job_id))throw Error('Некорректное задание');
   const route='/jobs/'+args.job_id;const state=JSON.parse(await request(c,route,'GET',undefined,signal));
   if(!['completed','cancelled','error','interrupted'].includes(state.status))return state;
   if(!Array.isArray(state.files)||state.files.length>8)throw Error('Некорректный список файлов');
   const images=[],vision=[];
   for(const file of state.files){
    if(!/^(?:image-\d{2}|normal|height|roughness|metallic|relight|relight-right|tile-preview)\.png$/.test(file.name))throw Error('Некорректное имя');
    const raw=await request(c,route+'/files/'+file.name,'GET',undefined,signal);
    const url=await save(args.job_id,file.name,raw);
    if(context&&state.status==='completed'&&file.name==='image-01.png')await rememberImage(context,args.job_id,file.name,raw);
    const preview=await request(c,route+'/preview/'+file.name,'GET',undefined,signal);
    const previewUrl=await save(args.job_id,(file.name.startsWith('image-')?file.name.replace('image-','preview-'):'preview-'+file.name),preview);
    images.push({name:file.name,url,previewUrl});vision.push(preview.toString('base64'));
   }
   if(state.status==='completed')await save(args.job_id,'manifest.json',await request(c,route+'/files/manifest.json','GET',undefined,signal));
   const archive=state.status==='completed'?await save(args.job_id,'images.zip',await request(c,route+'/files/images.zip','GET',undefined,signal)):undefined;
   return {enkiImages:1,status:state.status,images,archive,vision,model:state.model??c.model,inference:state.inference,source:state.source_image,note:'PNG и ZIP сохранены в .enki/generated-images. Для следующей правки этого результата используйте edit_image(source=latest). Не более двух генераций на одну просьбу, включая исправления. Для материала: источник высоты и метод указаны в manifest.json; карты данных импортировать как linear/non-color. relight — проверочное освещение. Проверяйте результат только при поддержке Vision; точечные изменения и сохранение всех деталей не гарантируются.'};
  }
  throw Error('Неизвестный инструмент');
 };
}
