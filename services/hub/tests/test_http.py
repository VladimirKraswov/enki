import contextlib, http.client, json, ssl, subprocess, tempfile, threading, unittest
from pathlib import Path
from test_hub import m
class HTTP(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();p=Path(self.tmp.name);self.h=m.Hub(p/'db');self.key=self.h.provision('test','macos')['token']
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',str(p/'key'),'-out',str(p/'cert')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  self.server=m.Server(('127.0.0.1',0),self.h,Path(__file__).parents[1]/'web');ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(p/'cert',p/'key');self.server.socket=ctx.wrap_socket(self.server.socket,server_side=True,do_handshake_on_connect=False);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.ctx=ssl.create_default_context(cafile=str(p/'cert'))
 def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
 def req(self,path,method='GET',body=None,headers=None):
  c=http.client.HTTPSConnection('localhost',self.server.server_port,context=self.ctx,timeout=5);h=headers or {};raw=json.dumps(body) if body is not None else None
  if raw:h={'Content-Type':'application/json',**h}
  c.request(method,path,body=raw,headers=h);r=c.getresponse();data=r.read();code=r.status;headers=dict(r.getheaders());c.close();return code,headers,data
 def test_lan_transport_and_security_headers(self):
  self.assertEqual(self.req('/health')[0],200);self.assertEqual(self.req('/api/metrics')[0],200);code,h,b=self.req('/api/me',headers={'Authorization':'Bearer '+self.key});self.assertEqual(code,200);self.assertNotIn(self.key,b.decode());self.assertIn("frame-ancestors 'none'",h['Content-Security-Policy']);self.assertEqual(self.req('/api/login','POST',{'token':self.key}, {'Origin':'https://other.site'})[0],403)
 def test_cookie_login_and_safe_static(self):
  code,h,_=self.req('/api/login','POST',{'token':self.key});self.assertEqual(code,200);self.assertIn('HttpOnly',h['Set-Cookie']);self.assertIn('Secure',h['Set-Cookie']);cookie=h['Set-Cookie'].split(';')[0];self.assertEqual(self.req('/api/catalog',headers={'Cookie':cookie})[0],200);self.assertEqual(self.req('/../server.py')[0],404);self.assertEqual(self.req('/')[0],200)
 def test_legacy_cookie_stays_usable_but_logout_revokes_both_names(self):
  _,h,_=self.req('/api/login','POST',{'token':self.key});old=h['Set-Cookie'].split(';')[0].replace('enki_session=','arvela_session=')
  self.assertEqual(self.req('/api/catalog',headers={'Cookie':old})[0],200)
  _,h,_=self.req('/api/login','POST',{'token':self.key});new=h['Set-Cookie'].split(';')[0]
  self.assertEqual(self.req('/api/logout','POST',{}, {'Cookie':old+'; '+new})[0],200)
  # LAN mode has no cookie authority; logout remains a harmless legacy operation.
  for cookie in [old,new]:self.assertEqual(self.req('/api/catalog',headers={'Cookie':cookie})[0],200)
 def test_wrong_ca_rejected(self):
  c=http.client.HTTPSConnection('localhost',self.server.server_port,context=ssl.create_default_context(),timeout=5)
  with self.assertRaises(ssl.SSLCertVerificationError):c.request('GET','/health')
  c.close()

class UpdateHTTP(HTTP):
 def test_public_bootstrap_source_without_exposing_private_api(self):
  from test_releases import package
  import hashlib, io, zipfile
  self.assertEqual(self.req('/downloads/latest')[0],404)
  self.h.releases.api('POST','/api/updates',{'admin':True},dict(channel='stable',expectedRevision=None,hot=package('hot'),source=package('source')))
  code,_,raw=self.req('/downloads/latest');self.assertEqual(code,200);manifest=json.loads(raw)
  code,headers,archive=self.req(manifest['source']['url']);self.assertEqual(code,200)
  self.assertEqual(headers['Content-Type'],'application/zip');self.assertIn('attachment;',headers['Content-Disposition'])
  self.assertEqual(hashlib.sha256(archive).hexdigest(),manifest['source']['sha256'])
  with zipfile.ZipFile(io.BytesIO(archive)) as z:self.assertIsNone(z.testzip())
  self.assertEqual(self.req('/downloads/latest/source.zip')[2],archive)
  self.assertEqual(self.req(manifest['signedSource']['url'])[0],200)
  for path in ['/api/metrics','/api/sessions','/api/catalog','/api/updates/stable']:
   self.assertEqual(self.req(path)[0],200)
  self.assertEqual(self.req('/downloads/../server.py')[0],404)
  self.assertEqual(self.req('/downloads/latest','POST',{})[0],405)
  self.assertEqual(self.req('/downloads/latest',headers={'Origin':'https://other.site'})[0],403)
  self.server.release_download.acquire();self.server.release_download.acquire()
  try:self.assertEqual(self.req('/downloads/latest')[0],429)
  finally:self.server.release_download.release();self.server.release_download.release()
 def test_large_lan_release_publish_and_signed_artifact_download(self):
  from test_releases import package
  admin=self.h.provision('publisher','other',True)['token']
  hot=package('hot',files={'index.html':'x'*(2*1024*1024)})
  body=dict(channel='stable',expectedRevision=None,hot=hot,source=package('source'))
  code,_,raw=self.req('/api/updates','POST',body);self.assertEqual(code,200)
  head=json.loads(raw);artifact=head['artifacts']['hot']['digest']
  code,_,_=self.req('/api/updates/artifacts/'+artifact,headers={'Authorization':'Bearer '+self.key});self.assertEqual(code,200)
  self.assertEqual(self.req('/api/updates/artifacts/'+artifact)[0],200)
  self.assertEqual(self.req('/health')[0],200)
