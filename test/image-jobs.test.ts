import {expect,it} from 'vitest';
import {imageJobRefs,jobHasImages,jobPhaseLabel} from '../src/images/jobs';
import type {MessagePart} from '../src/api/types';
const ID='01234567-1234-1234-1234-123456789abc';
const tool=(name:string,output:unknown):MessagePart=>({id:crypto.randomUUID(),sessionID:'s',messageID:'m',type:'tool',tool:name,state:{status:'completed',output:JSON.stringify(output)}} as MessagePart);
const state=(over:any={})=>({id:ID,state:'running',mode:'text-to-image',progress:{phase:'sampling',step:2,steps:4,percent:50},...over});
it('reads durable job ids from image tool outputs and keeps the latest state',()=>{
 expect(imageJobRefs([tool('generate_image',state({state:'queued'}))])).toEqual([{id:ID,state:'queued',mode:'text-to-image'}]);
 expect(imageJobRefs([tool('generate_image',state({state:'queued'})),tool('image_status',state()),tool('get_images',{enkiImages:1,status:'completed',images:[]})])).toEqual([{id:ID,state:'running',mode:'text-to-image'}]);
 expect(imageJobRefs([tool('image_status',{status:'ready',model:{id:'qwen-image-edit-2511'}})])).toEqual([]);
 expect(imageJobRefs([tool('bash',state())])).toEqual([]);
 expect(imageJobRefs([{...tool('generate_image',state()),state:{status:'completed',output:'not json'}} as MessagePart])).toEqual([]);
 expect(imageJobRefs([tool('generate_image',state({id:'../etc'}))])).toEqual([]);
});
it('knows when the turn already shows the job images and how to name a phase',()=>{
 const urls=[`file:///w/.enki/generated-images/${ID}/image-01.png`];
 expect(jobHasImages(ID,urls)).toBe(true);
 expect(jobHasImages('11234567-1234-1234-1234-123456789abc',urls)).toBe(false);
 expect(jobPhaseLabel({phase:'sampling',step:2,steps:4})).toBe('Рисую 2 из 4');
 expect(jobPhaseLabel({phase:'upload'})).toBe('Загружаю исходник');
 expect(jobPhaseLabel({phase:'queued'})).toBe('В очереди');
 expect(jobPhaseLabel(null)).toBe('Запускаю');
});
