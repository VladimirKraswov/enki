"""Enki CPU image worker. Resident SDXL/Klein pipelines; durable, bounded jobs."""
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import queue
import secrets
import sqlite3
import threading
import time
import uuid
import zipfile
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request as HTTPRequest
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, ValidationError, model_validator

from runtime import PROFILES, edit_parameters, resolve_profile
from procedural import resolve_surface
MODEL = "enki-image-auto"
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_JOB_BODY_BYTES = 12 * 1024 * 1024

class SourceImage(BaseModel):
    """Inline authenticated input, decoded once; never put base64 in SQLite/results."""
    model_config = ConfigDict(extra="forbid")
    data_base64: str = Field(min_length=1, max_length=4*((MAX_SOURCE_BYTES+2)//3), exclude=True, repr=False)
    mime_type: str | None = Field(default=None,max_length=64)
    _png: bytes = PrivateAttr(default=b'')
    _metadata: dict = PrivateAttr(default_factory=dict)

    @model_validator(mode="after")
    def validate_image(self):
        if self._png: return self
        from PIL import Image, ImageOps, UnidentifiedImageError
        try:
            raw=base64.b64decode(self.data_base64, validate=True)
        except (ValueError, TypeError): raise ValueError('Исходное изображение: нужен корректный base64 без data: URL')
        if not raw or len(raw)>MAX_SOURCE_BYTES: raise ValueError('Исходное изображение: не больше 8 МиБ')
        try:
            with Image.open(io.BytesIO(raw)) as original:
                mime={'PNG':'image/png','JPEG':'image/jpeg','WEBP':'image/webp'}.get(original.format)
                if not mime: raise ValueError('Исходное изображение: поддерживаются PNG, JPEG и WebP')
                if self.mime_type is not None and self.mime_type!=mime: raise ValueError('Тип исходного изображения не совпадает с содержимым')
                width,height=original.size
                if max(width,height)>4096 or width*height>16777216 or min(width,height)<1:
                    raise ValueError('Исходное изображение: стороны до 4096, не больше 16 мегапикселей')
                if getattr(original,'n_frames',1)!=1: raise ValueError('Для редактирования выберите один неподвижный кадр')
                original.load()
                oriented=ImageOps.exif_transpose(original)
                alpha='A' in oriented.getbands() or 'transparency' in oriented.info
                if alpha:
                    image=Image.alpha_composite(Image.new('RGBA',oriented.size,'white'),oriented.convert('RGBA')).convert('RGB')
                else: image=oriented.convert('RGB')
                image.info.clear()
                encoded=io.BytesIO();image.save(encoded,format='PNG')
                png=encoded.getvalue()
                if len(png)>MAX_SOURCE_BYTES: raise ValueError('Декодированное изображение слишком велико; уменьшите его до 8 МиБ PNG')
                self._png=png
                self._metadata={'sha256':hashlib.sha256(png).hexdigest(),'original_sha256':hashlib.sha256(raw).hexdigest(),
                    'width':image.width,'height':image.height,'mime_type':mime,'stored_mime_type':'image/png',
                    'alpha_composited_on':'white' if alpha else None}
                self.data_base64=''  # Keep only the normalized bounded input while queued.
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            raise ValueError('Исходное изображение повреждено или имеет неподдерживаемый формат')
        return self

    def open_image(self):
        from PIL import Image
        with Image.open(io.BytesIO(self._png)) as image: return image.convert('RGB')

    def metadata(self): return dict(self._metadata)

class Material(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strength: float = Field(default=4.0, ge=0, le=16)
    blur: float = Field(default=1.0, ge=0, le=8)
    roughness: float = Field(default=0.7, ge=0, le=1)
    metallic: float = Field(default=0, ge=0, le=1)
    convention: str = 'opengl'
    tileable: bool = False
    invert_height: bool = False
    surface: str = 'auto'
    @model_validator(mode="after")
    def validate_material(self):
        if self.convention not in ('opengl','directx'): raise ValueError('convention: opengl/directx')
        if self.surface not in ('auto','image','brick','granite'): raise ValueError('surface: auto/image/brick/granite')
        return self

class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=2000)
    model: str = MODEL
    width: int = Field(default=1024, ge=256, le=1536)
    height: int = Field(default=1024, ge=256, le=1536)
    steps: int = Field(default=4, ge=2, le=8)
    seed: int = Field(default=42, ge=0, le=2147483647)
    material: Material | None = None
    items: list[str] = Field(default_factory=list, max_length=8)
    source_image: SourceImage | None = None
    edit_strength: float = Field(default=0.7, ge=0.5, le=0.95)
    @model_validator(mode="after")
    def validate_request(self):
        if not self.prompt.strip(): raise ValueError("Нужен непустой prompt")
        editing=self.source_image is not None
        selected=resolve_profile(self.model, self.prompt, self.material is not None, editing)
        if editing:
            if 'width' not in self.model_fields_set: self.width=512
            if 'height' not in self.model_fields_set: self.height=512
        if self.width % 8 or self.height % 8 or self.width*self.height > 1048576:
            raise ValueError("Размеры кратны 8; не больше 1048576 пикселей")
        if selected=='flux-klein-4b' and (self.width%16 or self.height%16):
            raise ValueError('FLUX Klein: ширина и высота должны быть кратны 16. Например, 512×512; для SDXL достаточно кратности 8')
        if self.model == 'lcm-dreamshaper-v7' and self.width*self.height > 640000:
            raise ValueError('Черновая LCM: не больше 640000 пикселей')
        if self.material and self.items: raise ValueError("Материал создаётся из одной согласованной текстуры")
        if self.source_image:
            if self.material or self.items: raise ValueError('Редактирование использует один исходник; material и items недоступны')
            edit_parameters(selected,self.edit_strength)
        elif 'edit_strength' in self.model_fields_set:
            raise ValueError('edit_strength применим только вместе с source_image')
        if any(not s.strip() or len(s)>160 for s in self.items):
            raise ValueError("Элементы набора: от 1 до 160 символов")
        return self

def request_record(body):
    # Exclude new absent fields byte-for-byte for already accepted T2I keys.
    exclude={'source_image':True,'edit_strength':True}
    if body.material and body.material.surface=='auto': exclude['material']={'surface'}
    raw=body.model_dump_json(exclude=exclude)
    if body.source_image:
        payload=json.loads(raw);payload.update(source_image=body.source_image.metadata(),edit_strength=body.edit_strength)
        raw=json.dumps(payload,ensure_ascii=False,separators=(',',':'))
    return raw

class Jobs:
    def __init__(self, root, generate, max_pending=8):
        self.root=Path(root); self.root.mkdir(parents=True, exist_ok=True)
        self.generate=generate; self.pending=queue.Queue(max_pending); self.lock=threading.RLock()
        self.db=sqlite3.connect(self.root/'jobs.sqlite', check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, key TEXT UNIQUE, fingerprint TEXT, body TEXT, result TEXT)')
        # A restart never silently repeats a generation whose result may have been delivered.
        for jid, raw in self.db.execute('SELECT id,result FROM jobs').fetchall():
            state=json.loads(raw)
            if state['status'] in ('queued','running'):
                state.update(status='interrupted', detail='Сервис перезапущен. Уже готовые изображения сохранены; создайте новое задание для оставшихся.')
                self.db.execute('UPDATE jobs SET result=? WHERE id=?',(json.dumps(state),jid))
        self.db.commit()
        self.ready=False; self.load_error=False
        self.loading_phase='loading_model'; self.loading_detail='Подготавливаю модели генерации и редактирования'
    def get(self, jid):
        with self.lock:
            row=self.db.execute('SELECT result FROM jobs WHERE id=?',(jid,)).fetchone()
            if not row: raise HTTPException(404,'Задание не найдено или удалено по сроку хранения')
            return json.loads(row[0])
    def by_key(self, key):
        if not key or len(key)>160: raise HTTPException(400,'Нужен Idempotency-Key (до 160 символов)')
        with self.lock:
            row=self.db.execute('SELECT id FROM jobs WHERE key=?',(key,)).fetchone()
            if not row: raise HTTPException(404,'Задание с этим ключом не найдено')
            return self.get(row[0])
    def update(self,jid,**fields):
        with self.lock:
            state=self.get(jid); state.update(fields)
            self.db.execute('UPDATE jobs SET result=? WHERE id=?',(json.dumps(state),jid));self.db.commit()
            return state
    def submit(self,body,key):
        if not key or len(key)>160: raise HTTPException(400,'Нужен Idempotency-Key (до 160 символов)')
        if not self.ready: raise HTTPException(503,'Модель загружается' if not self.load_error else 'Модель не загрузилась; проверьте журнал сервиса')
        # Adding an optional recipe must not invalidate old accepted request keys.
        raw=request_record(body); fingerprint=hashlib.sha256(raw.encode()).hexdigest()
        with self.lock:
            row=self.db.execute('SELECT id,fingerprint FROM jobs WHERE key=?',(key,)).fetchone()
            if row:
                if row[1]!=fingerprint: raise HTTPException(409,'Ключ уже использован с другими параметрами')
                return self.get(row[0])
            self.prune()
            count=self.db.execute('SELECT count(*) FROM jobs').fetchone()[0]
            if count>=200: raise HTTPException(507,'Хранилище изображений заполнено; удалите старые задания')
            if self.pending.full(): raise HTTPException(429,'Очередь генерации заполнена. Повторите позже с тем же ключом')
            selected=resolve_profile(body.model,body.prompt,body.material is not None,body.source_image is not None)
            recipe=resolve_surface(body.material.surface,body.prompt) if body.material else None
            actual_steps=0 if recipe else PROFILES[selected]['steps'] or body.steps
            if body.source_image: actual_steps=edit_parameters(selected,body.edit_strength)[1]
            if recipe:selected='procedural-'+recipe+'-v1'
            jid=str(uuid.uuid4());state={'id':jid,'status':'queued','created':time.time(),'completed':0,'total':len(body.items) or 1,'step':0,'steps':actual_steps,'files':[],'width':body.width,'height':body.height,'model':selected}
            if body.source_image:
                instruction_editing=selected=='flux-klein-4b'
                state.update(mode='image-to-image',source_image=body.source_image.metadata(),
                    edit_strength=None if instruction_editing else body.edit_strength,
                    requested_edit_strength=body.edit_strength,instruction_editing=instruction_editing)
                folder=self.root/jid
                try:
                    folder.mkdir(mode=0o700)
                    # Input is retained privately, not added to downloadable output files.
                    with (folder/'source.png').open('xb') as output:
                        os.fchmod(output.fileno(),0o600);output.write(body.source_image._png)
                except OSError:
                    import shutil
                    shutil.rmtree(folder,ignore_errors=True)
                    raise HTTPException(507,'Не удалось сохранить исходник; задание не запущено')
            self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?)',(jid,key,fingerprint,raw,json.dumps(state)));self.db.commit()
            self.pending.put_nowait((jid,body));return state
    def prune(self):
        import shutil
        for jid,raw in self.db.execute('SELECT id,result FROM jobs').fetchall():
            state=json.loads(raw)
            if state['status'] not in ('queued','running') and time.time()-state['created']>7*86400:
                shutil.rmtree(self.root/jid,ignore_errors=True);self.db.execute('DELETE FROM jobs WHERE id=?',(jid,))
        self.db.commit()
    def cancel(self,jid):
        with self.lock:
            state=self.get(jid)
            if state['status'] in ('queued','running'): return self.update(jid,status='cancelled',detail='Отменено; готовые файлы сохранены')
            return state
    def run(self):
        while True:
            jid,body=self.pending.get()
            try:
                if self.get(jid)['status']=='cancelled': continue
                folder=self.root/jid;folder.mkdir(exist_ok=True)
                self.update(jid,status='running',started=time.time());started=time.monotonic()
                def progress(step,steps,*_):
                    cancelled=self.get(jid)['status']=='cancelled'
                    if time.monotonic()-started>1200: raise TimeoutError('job deadline')
                    if not cancelled: self.update(jid,step=step+1,steps=steps)
                    return cancelled
                def phase(name, detail, **extra):
                    if self.get(jid)['status'] == 'cancelled': raise InterruptedError('cancelled')
                    if 'inference' in extra:
                        extra.update(model=extra['inference']['model'], steps=extra['inference']['steps'])
                    self.update(jid, phase=name, detail=detail, **extra)
                progress.phase = phase
                files=[]
                for index,item in enumerate(body.items or ['']):
                    if self.get(jid)['status']=='cancelled': break
                    prompt=body.prompt if not item else f'{item}. {body.prompt}'
                    self.update(jid,step=0)
                    image=self.generate(prompt,body,progress)
                    if self.get(jid)['status']=='cancelled': break
                    if body.material:
                        from materials import make_material
                        image.save(folder/'image-01.png')
                        files=[{'name':'image-01.png','label':'basecolor','seed':body.seed,'mime':'image/png'}]
                        self.update(jid,completed=1,files=files)
                        params=body.material.model_dump();params.pop('surface')
                        maps=make_material(image,**params,height_map=image.info.get('enki_height'))
                        files=[]
                        for name,output in maps.items():
                            output.save(folder/name)
                            files.append({'name':name,'label':'basecolor' if name=='image-01.png' else name[:-4],'seed':body.seed,'mime':'image/png'})
                            self.update(jid,completed=1,files=files)
                    else:
                        name=f'image-{index+1:02d}.png'; image.save(folder/name)
                        files.append({'name':name,'label':item or body.prompt,'seed':body.seed,'mime':'image/png'})
                    self.update(jid,completed=index+1,files=files)
                inference=self.get(jid).get('inference')
                request=body.model_dump(exclude={'source_image':True,'edit_strength':not bool(body.source_image)})
                if body.source_image: request['source_image']=body.source_image.metadata()
                manifest={'model':inference['model'] if inference else body.model,'engine':'OpenVINO GenAI CPU','request':request,'inference':inference,'files':files,'transparency':False,'vision_review':'pending: inspect returned images with a vision-capable agent'}
                if body.source_image:
                    instruction_editing=self.get(jid)['model']=='flux-klein-4b'
                    manifest.update(mode='image-to-image',source_image=body.source_image.metadata(),
                        edit_strength=None if instruction_editing else body.edit_strength,
                        requested_edit_strength=body.edit_strength,instruction_editing=instruction_editing)
                if body.material: manifest.update(material=body.material.model_dump(),height_source=inference.get('height_source') if inference and inference.get('height_source') else 'Approximation from the base image luminance; not measured or recovered geometry',color_spaces={'image-01.png':'sRGB color','normal.png':'linear / non-color tangent normal','height.png':'linear 16-bit height','roughness.png':'linear roughness, NOT glossiness','metallic.png':'linear metallic'},preview='relight.png and relight-right.png use the selected normal convention under opposite side lights; tile-preview.png shows repetition when enabled')
                (folder/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
                with zipfile.ZipFile(folder/'images.zip','w',compression=zipfile.ZIP_DEFLATED) as archive:
                    for name in [f['name'] for f in files]+['manifest.json']: archive.write(folder/name,name)
                if self.get(jid)['status']!='cancelled': self.update(jid,status='completed',phase='completed',detail='Изображения и архив готовы',finished=time.time(),seconds=round(time.monotonic()-started,2))
            except Exception:
                if self.get(jid)['status']!='cancelled': self.update(jid,status='error',detail='Ошибка генерации. Готовые файлы сохранены. Проверьте журнал сервиса; задание автоматически не повторяется.')
                import logging;logging.exception('Image worker failed for job %s',jid)
            finally: self.pending.task_done()

def load_models(jobs):
    root=Path(os.getenv('IMAGE_MODELS_DIR','/opt/enki-images/models'))
    # Klein's factory validates its pinned enki-klein.json/version pointer;
    # its canonical directory intentionally has no direct model_index.json.
    if any(not (root / p['folder'] / 'model_index.json').exists() for model,p in PROFILES.items() if p['folder'] and model!='flux-klein-4b'):
        raise RuntimeError('Quality models are not installed')
    def phase(name,detail,**_):
        with jobs.lock: jobs.loading_phase=name; jobs.loading_detail=detail
    jobs.generate.preload(phase)

def create_app(jobs,token,load=None):
    if len(token)<32: raise ValueError('Set a private API token of at least 32 characters')
    def auth(authorization: str=Header(default='')):
        if not hmac.compare_digest(authorization,'Bearer '+token): raise HTTPException(401,'Нужен API-ключ генератора')
    @asynccontextmanager
    async def lifespan(app):
        def start():
            try:
                if load: load()
                jobs.ready=True; jobs.loading_phase=None; jobs.loading_detail=None; jobs.run()
            except Exception:
                jobs.load_error=True
                import logging;logging.exception('Image model load failed')
        threading.Thread(target=start,daemon=True).start()
        yield
    app=FastAPI(title='Enki CPU Images',lifespan=lifespan,dependencies=[Depends(auth)])
    @app.get('/health')
    def health():
        resident=jobs.generate.resident_status() if hasattr(jobs.generate,'resident_status') else None
        return {'status':'ready' if jobs.ready else 'error' if jobs.load_error else 'loading','model':MODEL,'models':list(PROFILES),'material_surfaces':['auto','image','brick','granite'],'engine':'OpenVINO GenAI CPU','queue':jobs.pending.qsize(),'max_items':8,'max_pixels':1048576,
            'editing':True,'edit_models':['enki-image-auto','flux-klein-4b','sdxl-lightning'],
            'edit_default_model':'flux-klein-4b','edit_default_size':512,'edit_dimension_multiple':16,
            'edit_strength':{'min':0.5,'max':0.95,'default':0.7,'supported_models':['sdxl-lightning'],'note':'FLUX Klein управляется текстовой инструкцией; edit_strength принят только для совместимости'},
            'resident':resident,'phase':'ready' if jobs.ready else 'error' if jobs.load_error else jobs.loading_phase,'detail':jobs.loading_detail,
            'max_source_bytes':MAX_SOURCE_BYTES,'max_source_side':4096,'max_source_pixels':16777216}
    @app.post('/jobs',status_code=202)
    async def submit(request:HTTPRequest,idempotency_key:str=Header(default='')):
        # Bound streamed/chunked bodies before JSON/Pydantic allocation, not just Content-Length.
        raw=bytearray()
        async for chunk in request.stream():
            if len(raw)+len(chunk)>MAX_JOB_BODY_BYTES: raise HTTPException(413,'Запрос изображения слишком велик; исходник до 8 МиБ')
            raw.extend(chunk)
        # Decode/normalize on a worker thread so health/progress remain responsive.
        try: body=await run_in_threadpool(Request.model_validate_json,bytes(raw))
        except ValidationError as error:
            # Pydantic's default input field would echo private images/base64 into errors/logs.
            detail=[{'type':e['type'],'loc':[p if isinstance(p,int) else str(p)[:80] for p in e['loc'][:8]],'msg':e['msg'][:512]} for e in error.errors(include_input=False,include_context=False,include_url=False)[:16]]
            raise HTTPException(422,detail)
        return await run_in_threadpool(jobs.submit,body,idempotency_key)
    @app.get('/jobs/by-key')
    def lookup(request_key:str=Query(min_length=1,max_length=160)): return jobs.by_key(request_key)
    @app.get('/jobs/{jid}')
    def status(jid:str): return jobs.get(jid)
    @app.delete('/jobs/{jid}')
    def cancel(jid:str): return jobs.cancel(jid)
    @app.get('/jobs/{jid}/files/{name}')
    def file(jid:str,name:str):
        state=jobs.get(jid)
        names=[f['name'] for f in state['files']]+['manifest.json','images.zip']
        if name not in names or '/' in jid or '\\' in jid or not (jobs.root/jid/name).is_file(): raise HTTPException(404,'Файл не готов')
        return FileResponse(jobs.root/jid/name,filename=name,media_type='image/png' if name.endswith('.png') else 'application/zip' if name.endswith('.zip') else 'application/json')
    @app.get('/jobs/{jid}/preview/{name}')
    def preview(jid:str,name:str):
        from PIL import Image
        from fastapi.responses import Response
        state=jobs.get(jid)
        if name not in [f['name'] for f in state['files']]: raise HTTPException(404,'Файл не готов')
        image=Image.open(jobs.root/jid/name)
        if image.mode.startswith('I'):
            import numpy as np
            image=Image.fromarray((np.asarray(image,dtype=np.float32)/257).clip(0,255).astype(np.uint8))
        image.thumbnail((256,256));output=io.BytesIO();image.save(output,format='PNG')
        return Response(output.getvalue(),media_type='image/png')
    @app.post('/v1/images/generations')
    def compatible(body:dict,idempotency_key:str=Header(default='')):
        # Compatibility path intentionally bounded; Enki uses asynchronous /jobs.
        allowed={'prompt','model','size','n','response_format','seed'}
        if set(body)-allowed or body.get('n',1)!=1 or body.get('response_format','b64_json')!='b64_json': raise HTTPException(400,'Поддерживаются n=1 и response_format=b64_json; для наборов используйте /jobs')
        try:
            width,height=map(int,body.get('size','512x512').split('x'))
            req=Request(prompt=body.get('prompt',''),model=body.get('model',MODEL),width=width,height=height,seed=body.get('seed',42))
        except (ValueError,TypeError): raise HTTPException(400,'Некорректный запрос изображения')
        state=jobs.submit(req,idempotency_key or secrets.token_hex(16)); end=time.monotonic()+600
        while state['status'] in ('queued','running') and time.monotonic()<end:
            time.sleep(.2);state=jobs.get(state['id'])
        if state['status']!='completed': raise HTTPException(503,{'job_id':state['id'],'status':state['status'],'detail':'Проверьте задание; не повторяйте POST автоматически'})
        return {'created':int(time.time()),'data':[{'b64_json':base64.b64encode((jobs.root/state['id']/state['files'][0]['name']).read_bytes()).decode()}]}
    return app

if __name__=='__main__':
    import uvicorn
    from PIL import Image
    from runtime import ImageRuntime
    runtime=ImageRuntime()
    jobs=Jobs(os.getenv('IMAGE_STATE_DIR','/var/lib/enki-images/jobs'),runtime)
    token=Path(os.environ['IMAGE_TOKEN_FILE']).read_text().strip()
    uvicorn.run(create_app(jobs,token,lambda:load_models(jobs)),host='127.0.0.1',port=18084,log_level='warning')
