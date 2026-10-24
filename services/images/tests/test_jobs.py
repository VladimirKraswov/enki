import importlib.util
from pathlib import Path
import tempfile
import unittest
import base64
import hashlib
import io
import json
from PIL import Image
from fastapi.testclient import TestClient
import sys
sys.path.insert(0,str(Path(__file__).parents[1]))
spec=importlib.util.spec_from_file_location('enki_images',Path(__file__).parents[1]/'server.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class JobTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.jobs=module.Jobs(self.tmp.name,lambda *_:Image.new('RGB',(256,256),'blue'));self.jobs.ready=True
 def source(self,color='red',format='PNG',mode='RGB',size=(64,32),**options):
  data=io.BytesIO();Image.new(mode,size,color).save(data,format=format,**options)
  return {'data_base64':base64.b64encode(data.getvalue()).decode(),'mime_type':{'PNG':'image/png','JPEG':'image/jpeg','WEBP':'image/webp'}[format]}
 def run_pending(self):
  import threading,time
  threading.Thread(target=self.jobs.run,daemon=True).start();deadline=time.monotonic()+3
  while self.jobs.pending.unfinished_tasks and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(self.jobs.pending.unfinished_tasks,0)
 def test_idempotency_preserves_one_job_and_rejects_changed_payload(self):
  req=module.Request(prompt='blue crystal');first=self.jobs.submit(req,'stable')
  self.assertEqual(self.jobs.submit(req,'stable')['id'],first['id']);self.assertEqual(self.jobs.pending.qsize(),1)
  with self.assertRaises(module.HTTPException) as cm:self.jobs.submit(module.Request(prompt='red crystal'),'stable')
  self.assertEqual(cm.exception.status_code,409)
 def test_queue_bound_and_cancel(self):
  for i in range(8):self.jobs.submit(module.Request(prompt='a'),'k'+str(i))
  with self.assertRaises(module.HTTPException) as cm:self.jobs.submit(module.Request(prompt='a'),'overflow')
  self.assertEqual(cm.exception.status_code,429)
  jid=self.jobs.pending.queue[0][0];self.assertEqual(self.jobs.cancel(jid)['status'],'cancelled')
 def test_accepted_job_reports_actual_distilled_steps_not_requested_draft_steps(self):
  state=self.jobs.submit(module.Request(prompt='anime portrait',steps=8),'quality-steps')
  self.assertEqual(state['model'],'sdxl-lightning');self.assertEqual(state['steps'],2)
 def test_restart_marks_interrupted_without_replaying(self):
  jid=self.jobs.submit(module.Request(prompt='a'),'key')['id'];other=module.Jobs(self.tmp.name,None)
  self.assertEqual(other.get(jid)['status'],'interrupted');self.assertTrue(other.pending.empty())
 def test_rejects_sizes_and_items_before_work(self):
  for params in [{'width':801},{'width':1536,'height':1536},{'model':'lcm-dreamshaper-v7','width':832,'height':832},{'model':'unknown'},{'items':['']},{'prompt':' '}]:
   with self.assertRaises(ValueError):module.Request(**({'prompt':'valid'}|params))
 def test_auth_and_traversal(self):
  app=module.create_app(self.jobs,'x'*32);client=TestClient(app)
  self.assertEqual(client.get('/health').status_code,401)
  self.assertEqual(client.get('/health',headers={'Authorization':'Bearer '+'x'*32}).status_code,200)
  self.assertEqual(client.get('/jobs/no/files/no',headers={'Authorization':'Bearer '+'x'*32}).status_code,404)
 def test_partial_outputs_survive_cancellation_during_inference(self):
  import threading,time,zipfile
  calls=[]
  jid=self.jobs.submit(module.Request(prompt='blue icons',items=['crystal','shield']),'partial')['id']
  def generate(*args):
   calls.append(1)
   if len(calls)==2:self.jobs.cancel(jid)
   args[2](0,4)
   return Image.new('RGB',(256,256),'blue')
  self.jobs.generate=generate
  threading.Thread(target=self.jobs.run,daemon=True).start()
  deadline=time.monotonic()+2
  while self.jobs.pending.unfinished_tasks and time.monotonic()<deadline:time.sleep(.01)
  state=self.jobs.get(jid);self.assertEqual(state['status'],'cancelled');self.assertEqual(len(state['files']),1)
  with zipfile.ZipFile(Path(self.tmp.name)/jid/'images.zip') as archive:self.assertEqual(archive.namelist(),['image-01.png','manifest.json'])
 def test_material_worker_exports_consistent_maps_and_manifest(self):
  import threading,time,zipfile,json
  jid=self.jobs.submit(module.Request(prompt='rough stone grain',material=module.Material(tileable=True,convention='directx')),'material')['id']
  threading.Thread(target=self.jobs.run,daemon=True).start();deadline=time.monotonic()+3
  while self.jobs.pending.unfinished_tasks and time.monotonic()<deadline:time.sleep(.01)
  state=self.jobs.get(jid);self.assertEqual(state['status'],'completed');self.assertEqual(len(state['files']),8)
  with zipfile.ZipFile(Path(self.tmp.name)/jid/'images.zip') as archive:
   self.assertIsNone(archive.testzip());manifest=json.loads(archive.read('manifest.json'));self.assertEqual(manifest['material']['convention'],'directx');self.assertIn('linear',manifest['color_spaces']['normal.png']);self.assertIn('relight-right.png',archive.namelist())
 def test_procedural_material_is_reported_honestly_and_exports_authored_relief(self):
  import threading,time,json
  from runtime import ImageRuntime
  self.jobs.generate=ImageRuntime()
  req=module.Request(prompt='regular red bricks',width=256,height=256,material=module.Material(surface='brick',tileable=True))
  accepted=self.jobs.submit(req,'recipe');self.assertEqual(accepted['model'],'procedural-brick-v1');self.assertEqual(accepted['steps'],0)
  threading.Thread(target=self.jobs.run,daemon=True).start();deadline=time.monotonic()+3
  while self.jobs.pending.unfinished_tasks and time.monotonic()<deadline:time.sleep(.01)
  state=self.jobs.get(accepted['id']);self.assertEqual(state['status'],'completed');self.assertEqual(len(state['files']),8)
  manifest=json.loads((Path(self.tmp.name)/accepted['id']/'manifest.json').read_text())
  self.assertEqual(manifest['height_source'],'authored procedural relief');self.assertEqual(manifest['inference']['model'],'procedural-brick-v1')
 def test_pre_recipe_idempotency_key_survives_added_auto_default(self):
  import hashlib,json
  legacy='{"prompt":"brick","model":"enki-image-auto","width":512,"height":512,"steps":4,"seed":42,"material":{"strength":4.0,"blur":1.0,"roughness":0.7,"metallic":0.0,"convention":"opengl","tileable":false,"invert_height":false},"items":[]}'
  self.jobs.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?)',('old','before-upgrade',hashlib.sha256(legacy.encode()).hexdigest(),legacy,json.dumps({'id':'old','status':'completed'})));self.jobs.db.commit()
  req=module.Request(prompt='brick',width=512,height=512,material=module.Material(metallic=0))
  self.assertEqual(self.jobs.submit(req,'before-upgrade')['id'],'old');self.assertTrue(self.jobs.pending.empty())
 def test_existing_non_material_request_key_survives_editing_upgrade(self):
  legacy='{"prompt":"portrait","model":"enki-image-auto","width":1024,"height":1024,"steps":4,"seed":42,"material":null,"items":[]}'
  self.jobs.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?)',('old','t2i-old',hashlib.sha256(legacy.encode()).hexdigest(),legacy,json.dumps({'id':'old','status':'completed'})));self.jobs.db.commit()
  self.assertEqual(self.jobs.submit(module.Request(prompt='portrait'),'t2i-old')['id'],'old')
 def test_source_is_real_input_private_immutable_and_recorded_without_base64(self):
  source=self.source();seen=[]
  def edit(prompt,body,callback):
   image=body.source_image.open_image();seen.append((image.size,image.getpixel((0,0)),body.edit_strength))
   image.paste('green',(0,0,16,16));return image
  self.jobs.generate=edit
  req=module.Request(prompt='make the corner green',width=256,height=256,source_image=source)
  accepted=self.jobs.submit(req,'edit-input');jid=accepted['id']
  # The qualified instruction-editing profile intentionally replaces auto SDXL redraw.
  self.assertEqual(accepted['mode'],'image-to-image');self.assertEqual(accepted['steps'],4)
  self.assertEqual(accepted['model'],'flux-klein-4b')
  self.assertEqual(accepted['source_image']['width'],64);self.assertIsNone(accepted['edit_strength'])
  self.assertEqual(accepted['requested_edit_strength'],.7);self.assertTrue(accepted['instruction_editing'])
  self.assertEqual(self.jobs.submit(req,'edit-input')['id'],jid);self.assertEqual(self.jobs.pending.qsize(),1)
  self.run_pending();self.assertEqual(seen,[((64,32),(255,0,0),.7)])
  folder=Path(self.tmp.name)/jid;manifest=json.loads((folder/'manifest.json').read_text())
  self.assertEqual(manifest['source_image']['sha256'],hashlib.sha256((folder/'source.png').read_bytes()).hexdigest())
  self.assertEqual(Image.open(folder/'source.png').getpixel((0,0)),(255,0,0))
  self.assertEqual(Image.open(folder/'image-01.png').getpixel((0,0)),(0,128,0))
  self.assertNotIn('data_base64',json.dumps(manifest));self.assertNotIn(source['data_base64'],json.dumps(manifest))
  raw=self.jobs.db.execute('SELECT body,result FROM jobs WHERE id=?',(jid,)).fetchone()
  self.assertTrue(all(source['data_base64'] not in field for field in raw))
  client=TestClient(module.create_app(self.jobs,'x'*32));auth={'Authorization':'Bearer '+'x'*32}
  self.assertEqual(client.get(f'/jobs/{jid}/files/source.png',headers=auth).status_code,404)
  self.assertEqual(client.get(f'/jobs/{jid}/files/image-01.png',headers=auth).status_code,200)
  self.assertEqual((folder/'source.png').stat().st_mode&0o777,0o600)
 def test_edit_idempotency_rejects_another_source_or_strength(self):
  req=module.Request(prompt='change sky',source_image=self.source())
  self.jobs.submit(req,'edit-key')
  for options in [{'source_image':self.source('blue')},{'source_image':self.source(),'edit_strength':.9}]:
   with self.assertRaises(module.HTTPException) as error:self.jobs.submit(module.Request(prompt='change sky',**options),'edit-key')
   self.assertEqual(error.exception.status_code,409)
  self.assertEqual(self.jobs.pending.qsize(),1)
 def test_edit_rejects_unsupported_modes_invalid_bytes_mime_and_dimensions(self):
  invalid=[{'source_image':{'data_base64':'broken'}},{'source_image':{'data_base64':base64.b64encode(b'not an image').decode()}},
   {'source_image':self.source()|{'mime_type':'image/jpeg'}},{'source_image':self.source(size=(4097,1))},
   {'source_image':self.source(),'items':['one']},{'source_image':self.source(),'material':module.Material()},
   {'source_image':self.source(),'model':'lcm-dreamshaper-v7','width':512,'height':512},
   {'source_image':self.source(),'edit_strength':.49},{'source_image':self.source(),'edit_strength':1},
   {'edit_strength':.7}]
  for params in invalid:
   with self.subTest(params=[key for key in params]):
    with self.assertRaises(ValueError):module.Request(prompt='change',**params)
  self.assertTrue(self.jobs.pending.empty())
 def test_source_normalizes_orientation_alpha_and_removes_metadata(self):
  exif=Image.Exif();exif[274]=6
  source=self.source(format='JPEG',size=(32,64),exif=exif)
  req=module.Request(prompt='edit',source_image=source)
  self.assertEqual(req.source_image.open_image().size,(64,32));self.assertFalse(req.source_image.open_image().getexif())
  rgba=self.source(color=(255,0,0,0),mode='RGBA')
  normalized=module.Request(prompt='edit',source_image=rgba).source_image
  self.assertEqual(normalized.open_image().getpixel((0,0)),(255,255,255))
  self.assertEqual(normalized.metadata()['alpha_composited_on'],'white')
 def test_animated_reference_is_rejected_before_queuing(self):
  data=io.BytesIO();Image.new('RGB',(16,16),'red').save(data,format='PNG',save_all=True,append_images=[Image.new('RGB',(16,16),'blue')],duration=100)
  with self.assertRaisesRegex(ValueError,'неподвижный кадр'):
   module.Request(prompt='edit',source_image={'data_base64':base64.b64encode(data.getvalue()).decode()})
  self.assertTrue(self.jobs.pending.empty())
 def test_http_edit_validation_is_bounded_authenticated_and_does_not_echo_input(self):
  client=TestClient(module.create_app(self.jobs,'x'*32));auth={'Authorization':'Bearer '+'x'*32,'Idempotency-Key':'http-edit'}
  source=self.source()
  self.assertEqual(client.post('/jobs',json={'prompt':'edit','source_image':source}).status_code,401)
  response=client.post('/jobs',json={'prompt':'edit','source_image':source},headers=auth)
  self.assertEqual(response.status_code,202);self.assertEqual(response.json()['mode'],'image-to-image')
  bad=client.post('/jobs',json={'prompt':'edit','source_image':source|{'mime_type':'image/jpeg'}},headers=auth)
  self.assertEqual(bad.status_code,422);self.assertNotIn(source['data_base64'],bad.text);self.assertNotIn('"input"',bad.text)
  unknown=client.post('/jobs',json={'prompt':'edit',source['data_base64']:True},headers=auth)
  self.assertEqual(unknown.status_code,422);self.assertNotIn(source['data_base64'],unknown.text)
  oversized=client.post('/jobs',content=b' '* (module.MAX_JOB_BODY_BYTES+1),headers=auth)
  self.assertEqual(oversized.status_code,413)
  self.assertEqual(self.jobs.pending.qsize(),1)
  health=client.get('/health',headers=auth).json();self.assertTrue(health['editing']);self.assertEqual(health['edit_strength']['default'],.7)
  self.assertEqual(health['edit_default_model'],'flux-klein-4b');self.assertEqual(health['edit_default_size'],512)
  self.assertEqual(health['edit_strength']['supported_models'],['sdxl-lightning'])
 def test_restart_retains_source_without_replaying_edit(self):
  jid=self.jobs.submit(module.Request(prompt='edit',source_image=self.source()),'restart-edit')['id']
  other=module.Jobs(self.tmp.name,None)
  self.assertEqual(other.get(jid)['status'],'interrupted');self.assertTrue(other.pending.empty())
  self.assertTrue((Path(self.tmp.name)/jid/'source.png').is_file())
 def test_lookup_by_key_recovers_ack_without_submitting_or_exposing_source(self):
  source=self.source();key='stable /?&+%ключ'
  jid=self.jobs.submit(module.Request(prompt='edit',source_image=source),key)['id']
  client=TestClient(module.create_app(self.jobs,'x'*32));auth={'Authorization':'Bearer '+'x'*32}
  self.assertEqual(client.get('/jobs/by-key',params={'request_key':key}).status_code,401)
  result=client.get('/jobs/by-key',params={'request_key':key},headers=auth)
  self.assertEqual(result.status_code,200);self.assertEqual(result.json()['id'],jid)
  self.assertEqual(result.json()['mode'],'image-to-image');self.assertNotIn(source['data_base64'],result.text)
  self.assertNotIn('key',result.json());self.assertEqual(self.jobs.pending.qsize(),1)
  self.jobs.cancel(jid)
  self.assertEqual(client.get('/jobs/by-key',params={'request_key':key},headers=auth).json()['status'],'cancelled')
  self.assertEqual(client.get('/jobs/by-key',params={'request_key':'unknown'},headers=auth).status_code,404)
  for bad in ('','x'*161):
   self.assertEqual(client.get('/jobs/by-key',params={'request_key':bad},headers=auth).status_code,422)
  self.assertEqual(self.jobs.pending.qsize(),1)
 def test_klein_edit_size_and_legacy_sdxl_redraw_are_explicit(self):
  source=self.source()
  automatic=module.Request(prompt='change hair',source_image=source)
  self.assertEqual((automatic.width,automatic.height),(512,512))
  self.assertEqual((module.Request(prompt='new image').width,module.Request(prompt='new image').height),(1024,1024))
  with self.assertRaisesRegex(ValueError,'кратны 16'):
   module.Request(prompt='edit',source_image=source,width=512,height=520)
  legacy=module.Request(prompt='redraw',model='sdxl-lightning',source_image=source,width=512,height=520)
  state=self.jobs.submit(legacy,'explicit-sdxl')
  self.assertEqual(state['model'],'sdxl-lightning');self.assertEqual(state['steps'],1)
  self.assertEqual(state['edit_strength'],.7);self.assertFalse(state['instruction_editing'])
  with self.assertRaisesRegex(ValueError,'source_image'):module.Request(prompt='new image',model='flux-klein-4b')
 def test_health_reports_startup_residency_and_does_not_claim_ready_before_loading(self):
  class Runtime:
   def resident_status(self):return {'ready':False,'primary':[{'model':'sdxl-lightning','loaded':True},{'model':'flux-klein-4b','loaded':False}]}
   def __call__(self,*_):raise AssertionError('Health must not generate')
  self.jobs.generate=Runtime();self.jobs.ready=False
  self.jobs.loading_detail='Загружаю FLUX Klein'
  client=TestClient(module.create_app(self.jobs,'x'*32));auth={'Authorization':'Bearer '+'x'*32}
  health=client.get('/health',headers=auth).json()
  self.assertEqual(health['status'],'loading');self.assertEqual(health['phase'],'loading_model')
  self.assertEqual(health['detail'],'Загружаю FLUX Klein');self.assertFalse(health['resident']['ready'])
  self.assertEqual(client.post('/jobs',json={'prompt':'a'},headers=auth|{'Idempotency-Key':'before-ready'}).status_code,503)
  self.assertTrue(self.jobs.pending.empty())
 def test_startup_preloads_both_models_without_generation_and_exposes_loading_progress(self):
  import threading,time,os
  from unittest.mock import patch
  entered,release=threading.Event(),threading.Event();loaded=[]
  class Runtime:
   def preload(self,phase):
    phase('loading_model','Загружаю SDXL');loaded.append('sdxl-lightning')
    phase('loading_model','Загружаю FLUX Klein');entered.set()
    if not release.wait(2):raise RuntimeError('test loader not released')
    loaded.append('flux-klein-4b')
   def resident_status(self):return {'ready':len(loaded)==2,'primary':[{'model':model,'loaded':model in loaded} for model in ('sdxl-lightning','flux-klein-4b')]}
   def __call__(self,*_):raise AssertionError('Warmup must never generate a dummy image')
  self.jobs.generate=Runtime();self.jobs.ready=False
  root=Path(self.tmp.name)/'models';(root/'sdxl-lightning').mkdir(parents=True)
  (root/'sdxl-lightning/model_index.json').write_text('{}')
  auth={'Authorization':'Bearer '+'x'*32}
  with patch.dict(os.environ,{'IMAGE_MODELS_DIR':str(root)}),TestClient(module.create_app(self.jobs,'x'*32,lambda:module.load_models(self.jobs))) as client:
   try:
    self.assertTrue(entered.wait(1));health=client.get('/health',headers=auth).json()
    self.assertEqual(health['status'],'loading');self.assertEqual(health['detail'],'Загружаю FLUX Klein')
    self.assertFalse(health['resident']['ready']);self.assertTrue(health['resident']['primary'][0]['loaded'])
    self.assertEqual(client.post('/jobs',json={'prompt':'a'},headers=auth|{'Idempotency-Key':'startup'}).status_code,503)
   finally:release.set()
   deadline=time.monotonic()+1
   while not self.jobs.ready and time.monotonic()<deadline:time.sleep(.01)
   health=client.get('/health',headers=auth).json()
   self.assertEqual(health['status'],'ready');self.assertTrue(health['resident']['ready'])
   self.assertEqual(health['phase'],'ready');self.assertTrue(self.jobs.pending.empty())
if __name__=='__main__':unittest.main()
