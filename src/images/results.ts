export interface GeneratedImage {name:string;url:string;previewUrl?:string}
export interface ImageResult {enkiImages:1;status:string;images:GeneratedImage[];archive?:string}
const generated=/\/\.enki\/generated-images\/[a-f0-9-]{36}\/(?:(?:image|preview)-\d{2}|(?:preview-)?(?:normal|height|roughness|metallic|relight|relight-right|tile-preview))\.png$/;
export function generatedFileUrl(value:unknown,archive=false):value is string{
 if(typeof value!=='string'||value.length>8192)return false;
 try{const u=new URL(value);return u.protocol==='file:'&&!u.host&&!u.search&&!u.hash&&(archive?/\/\.enki\/generated-images\/[a-f0-9-]{36}\/images\.zip$/:generated).test(decodeURIComponent(u.pathname))}catch{return false}
}
export function imageResult(output:unknown):ImageResult|null{
 if(typeof output!=='string'||output.length>32768||!output.includes('"enkiImages"'))return null;
 // SDK history projects Vision blocks as these exact trailing markers. Keep
 // the original size/path limits and reject every other non-JSON suffix.
 const json=output.replace(/(?:\n\[изображение\]){1,8}$/u,'');
 try{const r=JSON.parse(json);if(r.enkiImages!==1||typeof r.status!=='string'||!Array.isArray(r.images)||r.images.length>8||!r.images.every((i:GeneratedImage)=>i&&typeof i.name==='string'&&/^(?:image-\d{2}|normal|height|roughness|metallic|relight|relight-right|tile-preview)\.png$/.test(i.name)&&generatedFileUrl(i.url)&&(i.previewUrl===undefined||generatedFileUrl(i.previewUrl)))||(r.archive!==undefined&&!generatedFileUrl(r.archive,true)))return null;return r}catch{return null}
}

// A streamed turn re-renders on every delta: parse each tool output once. The
// reducer replaces a changed part object, so identity is an exact cache key.
const parsed=new WeakMap<object,ImageResult|null>();
function partImageResult(part:{state?:{output?:string}}):ImageResult|null{
 const state=part.state;if(!state)return null;
 if(parsed.has(state))return parsed.get(state)!;
 const result=imageResult(state.output);parsed.set(state,result);return result;
}
/** Keep completed assets visible when work details are folded; repeated retrievals do not duplicate cards. */
export function turnImageResults(parts:readonly {state?:{output?:string}}[]):ImageResult[]{
 const seen=new Set<string>(),out:ImageResult[]=[];
 for(const p of parts){if(out.length>=16)break;const r=partImageResult(p);if(!r)continue;const images=r.images.filter(i=>{if(seen.has(i.url))return false;seen.add(i.url);return true});if(images.length)out.push({...r,images})}
 return out;
}
