import { MAX_ATTACHMENT_BYTES } from './drafts';
import { isNative } from '../native/platform';
import { invoke } from '@tauri-apps/api/core';
import { readFile, stat } from '@tauri-apps/plugin-fs';
export interface AttachmentSource { key: string; name: string; mime?: string; url?: string; messageID?: string }
const raster = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif']);
export function previewKind(mime = ''): 'image'|'pdf'|'text'|'audio'|'video'|'other' {
  mime=mime.split(';')[0].toLowerCase();
  return raster.has(mime)?'image':mime==='application/pdf'?'pdf':mime.startsWith('text/')||['application/json','application/xml'].includes(mime)?'text':mime.startsWith('audio/')?'audio':mime.startsWith('video/')?'video':'other';
}
export function imageThumbnail(file: AttachmentSource): string | undefined {
  const url=file.url;if(!url || url.length>Math.ceil(MAX_ATTACHMENT_BYTES*4/3)+256)return;
  const match=/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]*)$/.exec(url);
  return match && raster.has(match[1].toLowerCase())?url:undefined;
}
export async function attachmentBlob(file: AttachmentSource, remote: boolean): Promise<Blob> {
  const url=file.url;if(!url)throw Error('Файл не сохранился в истории.');
  if(url.startsWith('data:')){
    if(url.length>Math.ceil(MAX_ATTACHMENT_BYTES*4/3)+256)throw Error('Файл больше 50 МБ.');
    const match=/^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);if(!match)throw Error('Некорректное вложение.');
    let bytes: Uint8Array;
    try{bytes=match[2]?Uint8Array.from(atob(match[3]),c=>c.charCodeAt(0)):new TextEncoder().encode(decodeURIComponent(match[3]));}catch{throw Error('Не удалось прочитать вложение.');}
    if(bytes.byteLength>MAX_ATTACHMENT_BYTES)throw Error('Файл больше 50 МБ.');
    return new Blob([bytes.buffer as ArrayBuffer],{type:match[1]||file.mime||'application/octet-stream'});
  }
  if(url.startsWith('file:') && isNative() && !remote){
    const parsed=new URL(url);if(parsed.host && parsed.host!=='localhost')throw Error('Сетевой путь недоступен.');
    let path=decodeURIComponent(parsed.pathname);if(/^\/[A-Za-z]:\//.test(path))path=path.slice(1);
    const archive = /\/attachments\/([a-f0-9-]{36})\/archive\.zip$/i.exec(parsed.pathname);
    if (file.mime === 'application/zip' && archive) {
      path = await invoke<string>('archive_access', {id:archive[1],expectedUrl:url});
    }
    const info=await stat(path);
    if(!info.isFile||info.isSymlink||info.size>MAX_ATTACHMENT_BYTES)throw Error('Файл недоступен или больше 50 МБ.');
    const bytes=await readFile(path);if(bytes.byteLength>MAX_ATTACHMENT_BYTES)throw Error('Файл больше 50 МБ.');
    return new Blob([bytes.buffer as ArrayBuffer],{type:file.mime||'application/octet-stream'});
  }
  throw Error(remote?'Исходный файл находится на другом компьютере.':'Формат ссылки не поддерживается.');
}
