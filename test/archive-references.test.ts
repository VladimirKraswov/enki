import {expect,it} from 'vitest';
import {archivePart,archiveReference,attachmentParts,splitArchiveText} from '../src/attachments/archive';
import {StreamTranslator} from '../src-tauri/resources/agent/src/sdk/translate';
import {entriesToMessages} from '../src-tauri/resources/agent/src/sdk/history';
import {sessionContext} from '../src/state/taskContext';
import {emptySessionChat} from '../src/state/chatReducer';
const ref={version:1 as const,name:'Исходники.zip',path:'/home/test/.local/share/opencode-desktop/attachments/12345678-1234-1234-1234-123456789abc/archive.zip',url:'file:///home/test/.local/share/opencode-desktop/attachments/12345678-1234-1234-1234-123456789abc/archive.zip',size:1234,sha256:'a'.repeat(64),remote:false};
it('keeps ordinary text and rejects unsafe or malformed archive references',()=>{
 expect(splitArchiveText('  original\ntext  ').text).toBe('  original\ntext  ');
 expect(archiveReference({...ref,url:'https://example.com/secret'})).toBeUndefined();
 expect(archiveReference({...ref,url:'file:///etc/passwd'})).toBeUndefined();
 expect(splitArchiveText('keep <arvela-attachment-v1>invalid</arvela-attachment-v1>')).toEqual({text:'keep <arvela-attachment-v1>invalid</arvela-attachment-v1>',references:[]});
 const part=archivePart({...ref,name:'</arvela-attachment-v1>.zip'});
 expect(splitArchiveText(part.text).references[0].name).toBe('</arvela-attachment-v1>.zip');
});
it('projects original ZIP into the common source gallery without exposing binary data to the model',()=>{
 const part={...archivePart(ref),id:'prt-archive',sessionID:'ses',messageID:'msg'};
 expect(attachmentParts([part])).toEqual([expect.objectContaining({filename:ref.name,mime:'application/zip',url:ref.url})]);
 const chat=emptySessionChat();chat.messages.msg={id:'msg',sessionID:'ses',role:'user',time:{created:1}};
 chat.messageOrder=['msg'];chat.partsByMessage.msg=[part.id];chat.parts[part.id]=part;
 expect(sessionContext(chat).sources).toEqual([expect.objectContaining({name:ref.name,url:ref.url,mime:'application/zip'})]);
});
// Live and durable projections are now produced by the runtime's SDK
// translator/history (src-tauri/resources/agent/src/sdk); the gallery stays here.
it('runtime live echo, durable publication and history restore the same archive reference and hide transport text',()=>{
 const text='Read the source archive\n\n'+archivePart(ref).text;
 const entry={type:'message',id:'entry',timestamp:new Date().toISOString(),message:{role:'user',content:text,timestamp:1}};
 const history=entriesToMessages('ses',[entry] as any);
 expect(history[0].parts[0].text).toBe('Read the source archive');
 expect(attachmentParts(history[0].parts as any)).toEqual([expect.objectContaining({filename:ref.name,mime:'application/zip',url:ref.url})]);
 const translator=new StreamTranslator('ses');
 const partsOf=(events:any[])=>events.filter(e=>e.type==='message.part.updated').map(e=>e.properties.part);
 // Provisional echo: visible text only, never the marker or its JSON.
 const live=partsOf(translator.translate({type:'message_start',message:entry.message} as any));
 expect(live.find(p=>p.type==='text'&&!p.synthetic).text).toBe('Read the source archive');
 expect(JSON.stringify(live)).not.toContain('arvela-attachment-v1');
 // The persisted entry replaces the echo and carries the same reference as history.
 const appended=translator.appended(entry as any);
 expect(appended[0]).toMatchObject({type:'message.removed'});
 const durable=partsOf(appended);
 expect(durable.find(p=>p.type==='text'&&!p.synthetic).text).toBe('Read the source archive');
 expect(attachmentParts(durable)).toEqual(attachmentParts(history[0].parts as any));
 expect(JSON.stringify(durable)).not.toContain('<arvela-attachment-v1>');
});
