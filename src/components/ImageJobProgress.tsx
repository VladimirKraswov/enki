import {useEffect,useRef,useState} from 'react';
import {capabilityNative} from '../capabilities/integration';
import {jobActive,jobHasImages,jobPhaseLabel} from '../images/jobs';
import type {ImageResult} from '../images/results';
import GeneratedImages from './GeneratedImages';
import {useAppSelector} from '../state/store';
import type {ImageJobRef} from '../images/jobs';
interface JobView{id:string;state:string;mode?:string;width?:number;height?:number;progress?:{phase?:string;step?:number;steps?:number;percent?:number};images?:{name:string}[];error?:{code?:string;message?:string}}
const POLL_MS=1500;
/** Live progress of one image job, driven by the native proxy: the WebView never
 * sees the service key. Finished images are pulled in only when the turn has
 * none, so an interrupted answer still shows the result it paid for. */
export default function ImageJobProgress({jobId,directory,hasImages,knownState}:{jobId:string;directory?:string|null;hasImages:boolean;knownState?:string}){
 const [job,setJob]=useState<JobView|null>(null),[error,setError]=useState(''),[cancelling,setCancelling]=useState(false);
 const [result,setResult]=useState<ImageResult|null>(null),[fetching,setFetching]=useState(false);
 const [tick,setTick]=useState(0);
 const settled=useRef(false);
 useEffect(()=>{if(hasImages)return;let live=true;const read=async()=>{try{const value=await capabilityNative<JobView>('image_job',{jobId});if(live)setJob(value)}catch(e){if(live)setError(String(e))}};void read();return()=>{live=false}},[jobId,hasImages]);
 const state=job?.state??knownState??'queued';
 const active=jobActive(state);
 useEffect(()=>{
  if(!active||job?.state&&job.error)return;
  const timer=setInterval(()=>setTick(v=>v+1),POLL_MS);
  return()=>clearInterval(timer);
 },[active,job?.state]);
 useEffect(()=>{
  if(tick===0)return;let live=true;
  void capabilityNative<JobView>('image_job',{jobId}).then(value=>{if(live)setJob(value)}).catch(e=>{if(live)setError(String(e))});
  return()=>{live=false};
 },[tick,jobId]);
 // Completed but the turn shows no images: give the agent a moment, then save them ourselves.
 useEffect(()=>{
  if(state!=='completed'||hasImages||result||fetching||settled.current)return;
  const timer=setTimeout(()=>{settled.current=true;if(!directory)return;setFetching(true);void capabilityNative<{images:{name:string;url:string}[]}>('image_job_result',{jobId,directory})
   .then(value=>setResult({enkiImages:1,status:'completed',images:value.images}))
   .catch(e=>setError(String(e))).finally(()=>setFetching(false))},2500);
  return()=>clearTimeout(timer);
 },[state,hasImages,result,fetching,directory,jobId]);
 if(hasImages)return null;
 if(result)return <div className="image-job-card"><p className="image-job-head"><span className="image-job-dot done" aria-hidden/>Готово · PNG сохранены в рабочей папке</p><GeneratedImages result={result}/></div>;
 const cancel=async()=>{setCancelling(true);setError('');try{setJob(await capabilityNative<JobView>('image_job_cancel',{jobId}))}catch(e){setError(String(e))}finally{setCancelling(false)}};
 const percent=Math.max(0,Math.min(100,job?.progress?.percent??0));
 const failed=state==='failed';
 const ratio=job?.width&&job?.height?`${job.width} / ${job.height}`:'1 / 1';
 return <div className={`image-job-card${failed?' failed':''}`} aria-live="polite">
  {active&&<div className="image-skeleton" style={{aspectRatio:ratio}} aria-hidden>
   <span className="image-skeleton-shimmer"/>
   <span className="image-skeleton-label"><span className="tool-spinner" aria-hidden/>{jobPhaseLabel(job?.progress)} · {percent}%</span>
  </div>}
  <p className="image-job-head">
   {active?<span className="tool-spinner" aria-hidden/>:<span className={`image-job-dot ${state}`} aria-hidden/>}
   <span>{active?jobPhaseLabel(job?.progress):failed?'Генерация не удалась':state==='cancelled'?'Генерация отменена':'Готово'}</span>
   {active&&<span className="image-job-percent">{percent}%</span>}
  </p>
  {active&&<div className="image-job-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Прогресс генерации изображения"><span style={{width:`${percent}%`}}/></div>}
  {failed&&<p className="image-job-note">{job?.error?.message||'Сервис сообщил об ошибке. Подробности — в ходе работы.'}</p>}
  {error&&<p className="image-job-note" role="alert">{error}</p>}
  <div className="image-job-actions">
   {active&&<button className="btn small" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?'Отменяю…':'Отменить'}</button>}
   {fetching&&<span className="image-job-note">Забираю готовые PNG…</span>}
   {!active&&!failed&&state==='completed'&&!fetching&&!result&&<span className="image-job-note">Изображения уже в ответе ниже.</span>}
  </div>
 </div>;
}

/** Progress cards for every image job named by this turn's tool outputs. */
export function ImageJobs({jobs,imageUrls}:{jobs:readonly ImageJobRef[];imageUrls:readonly string[]}){
 const {directory}=useAppSelector(s=>({directory:s.directory}));
 return <div className="image-jobs">{jobs.map(job=><ImageJobProgress key={job.id} jobId={job.id} directory={directory} hasImages={jobHasImages(job.id,imageUrls)} knownState={job.state}/>)}</div>;
}
