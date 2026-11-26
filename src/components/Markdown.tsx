import {memo, useMemo, useState} from 'react';
import ReactMarkdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {safeExternalUrl} from '../util/markdown';
import {highlightCode} from '../chat/highlight';
import {CopyButton} from './CopyButton';
import {Icon} from './Icon';

export function CodeBlock({code,language=''}:{code:string;language?:string}) {
 const [editing,setEditing]=useState(false),[draft,setDraft]=useState('');
 const value=editing?draft:code;
 const html=useMemo(()=>highlightCode(code,language),[code,language]);
 return <section className="code-block" aria-label={`Блок кода${language?' '+language:''}`}>
  <div className="code-toolbar"><span className="code-language">{language||'Текст'}</span>
   {editing&&<span className="code-local">Локальная копия</span>}<span className="spacer"/>
   <button className="message-action" title={editing?'Вернуть исходный код':'Изменить копию кода'} aria-label={editing?'Вернуть исходный код':'Изменить копию кода'} onClick={()=>{if(!editing)setDraft(code);setEditing(!editing);}}><Icon name={editing?'close':'edit'} size={15}/></button>
   <CopyButton text={value} label="Копировать только код"/>
  </div>
  {editing?<><textarea className="code-editor" aria-label="Редактируемая копия кода" spellCheck={false} value={draft} onChange={e=>setDraft(e.target.value)} rows={Math.max(4,Math.min(18,draft.split('\n').length))}/><div className="code-edit-note">Правки только для копирования. Ответ и файлы остаются прежними.</div></>
    :<pre tabIndex={0}><code className="hljs" dangerouslySetInnerHTML={{__html:html}}/></pre>}
 </section>;
}
const components:Components={
 pre({node,children}) {
  const code=node?.children[0];
  if(code?.type==='element'&&code.tagName==='code') {
   const text=code.children.map(n=>n.type==='text'?n.value:'').join('').replace(/\n$/,'');
   const classes=Array.isArray(code.properties.className)?code.properties.className:[];
   const language=String(classes.find(x=>String(x).startsWith('language-'))??'').slice(9);
   return <CodeBlock code={text} language={language}/>;
  }
  return <pre>{children}</pre>;
 },
 a({href,children}) {
  const safe=safeExternalUrl(href??null);
  return safe?<a href={safe} onClick={e=>{e.preventDefault();void import('@tauri-apps/plugin-opener').then(x=>x.openUrl(safe)).catch(()=>window.open(safe,'_blank','noopener,noreferrer'));}}>{children}</a>:<span>{children}</span>;
 },
 // Markdown images remain bounded; late dimensions are handled by the viewport observer.
 img({src,alt}) {return <img src={src} alt={alt??''} loading="lazy" referrerPolicy="no-referrer"/>;},
 // Tables scroll themselves: a squeezed table is worse than a horizontal scroll.
 table({children}) {return <div className="md-table-scroll"><table>{children}</table></div>;},
};
export function needsTextPaging(source:string) {
 if(source.length>32768)return true;
 let offset=-1;for(let n=0;n<301;n++){offset=source.indexOf('\n',offset+1);if(offset<0)return false;}
 return true;
}
function LargeText({source}:{source:string}) {
 const [requested,setPage]=useState(0), size=32768;
 const pages=Math.max(1,Math.ceil(source.length/size)), page=Math.min(requested,pages-1);
 let start=page*size,end=Math.min(source.length,start+size);
 // Include complete UTF-16 pairs at chunk boundaries. Full copy always uses the original.
 if(start>0&&source.charCodeAt(start)>=0xdc00&&source.charCodeAt(start)<=0xdfff)start--;
 if(end<source.length&&source.charCodeAt(end-1)>=0xd800&&source.charCodeAt(end-1)<=0xdbff)end++;
 return <section className="code-block large-message" aria-label="Большой текст">
  <div className="code-toolbar" style={{flexWrap:'wrap'}}><span>Часть {page+1} из {pages}</span><span className="spacer"/>
   <button className="btn small ghost" disabled={!page} onClick={()=>setPage(page-1)}>Предыдущая часть</button>
   <button className="btn small ghost" disabled={page+1>=pages} onClick={()=>setPage(page+1)}>Следующая часть</button>
   <CopyButton text={source} label="Скопировать весь текст"/>
  </div>
  <pre style={{whiteSpace:'pre-wrap',maxHeight:400,overflow:'auto'}}>{source.slice(start,end)}</pre>
 </section>;
}
export const Markdown=memo(function Markdown({source}:{source:string}) {
 if(needsTextPaging(source))return <LargeText source={source}/>;
 return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{source}</ReactMarkdown></div>;
});
