import {useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy,PDFDocumentLoadingTask,RenderTask} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
export function PdfPreview({blob}:{blob:Blob}){
 const canvas=useRef<HTMLCanvasElement>(null);const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[error,setError]=useState(''),[busy,setBusy]=useState(true);
 // A new document never renders through the previous (destroyed) proxy or its page number.
 useEffect(()=>{let alive=true,task:PDFDocumentLoadingTask|undefined;setPdf(null);setPage(1);setError('');setBusy(true);void(async()=>{const bytes=new Uint8Array(await blob.arrayBuffer());if(!alive)return;if(new TextDecoder().decode(bytes.slice(0,1024)).indexOf('%PDF-')<0)throw Error('Invalid PDF');const lib=await import('pdfjs-dist');if(!alive)return;lib.GlobalWorkerOptions.workerSrc=workerUrl;task=lib.getDocument({data:bytes,useSystemFonts:true});const doc=await task.promise;if(alive)setPdf(doc);})().catch(()=>{if(alive){setError('Не удалось открыть PDF.');setBusy(false);}});
 // The asynchronous loader and worker are owned by this preview only.
 // Catch at the task boundary without publishing document contents.
 return()=>{alive=false;void task?.destroy();};},[blob]);
 useEffect(()=>{if(!pdf)return;let alive=true,render:RenderTask|undefined;setBusy(true);setError('');void(async()=>{try{const p=await pdf.getPage(page);if(!alive||!canvas.current)return;const original=p.getViewport({scale:1});const scale=Math.min(2,1200/original.width,1800/original.height);const viewport=p.getViewport({scale});canvas.current.width=Math.ceil(viewport.width);canvas.current.height=Math.ceil(viewport.height);render=p.render({canvas:canvas.current,viewport});await render.promise;if(alive)setBusy(false);}catch{if(alive){setError('Не удалось показать страницу PDF.');setBusy(false);}}})();return()=>{alive=false;render?.cancel();};},[pdf,page]);
 return <div className="attachment-pdf"><div className="attachment-pdf-toolbar"><button className="btn small" disabled={!pdf||page<=1} onClick={()=>setPage(v=>v-1)}>Назад</button><span>{page} / {pdf?.numPages??'—'}</span><button className="btn small" disabled={!pdf||page>=pdf.numPages} onClick={()=>setPage(v=>v+1)}>Далее</button></div>{error?<p role="alert">{error}</p>:<>{busy&&<p role="status">Загрузка страницы…</p>}<canvas ref={canvas} aria-label={`Страница PDF ${page}`}/></>}</div>;
}
