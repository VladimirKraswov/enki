import importlib.util
import io
from pathlib import Path
import tempfile
import time
import unittest

spec=importlib.util.spec_from_file_location('cache',Path(__file__).resolve().parents[1]/'build_cache.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.c=m.BuildCache(self.tmp.name,quota=100,device_quota=70,reserve=0,ttl=30)
        self.key='a'*64;self.platform='darwin-arm64'
    def test_roundtrip_device_platform_isolation_and_immutable_keys(self):
        self.c.put('one',self.platform,self.key,io.BytesIO(b'payload'),7)
        f,size,sha=self.c.get('one',self.platform,self.key)
        with f:self.assertEqual(f.read(),b'payload')
        self.assertEqual(sha,m.hashlib.sha256(b'payload').hexdigest())
        for who,platform in [('two',self.platform),('one','win32-x64')]:
            with self.assertRaises(m.CacheError):self.c.get(who,platform,self.key)
        with self.assertRaises(m.CacheError):self.c.put('one',self.platform,self.key,io.BytesIO(b'changed'),7)
    def test_lease_expiration_and_revocation(self):
        grant=self.c.lease({'id':'one'},self.platform)
        self.assertEqual(self.c.authorize(grant['token'],self.platform,lambda _:True),'one')
        for token,platform,active in [(grant['token'],'win32-x64',lambda _:True),(grant['token'],self.platform,lambda _:False),('bad',self.platform,lambda _:True)]:
            with self.assertRaises(m.CacheError):self.c.authorize(token,platform,active)
        self.c.leases[m.hashlib.sha256(grant['token'].encode()).hexdigest()]=('one',self.platform,time.time()-1)
        with self.assertRaises(m.CacheError):self.c.authorize(grant['token'],self.platform,lambda _:True)
    def test_quota_lru_and_partial_upload(self):
        self.c.put('one',self.platform,self.key,io.BytesIO(b'a'*40),40)
        self.c.put('one',self.platform,'b'*64,io.BytesIO(b'b'*40),40)
        with self.assertRaises(m.CacheError):self.c.get('one',self.platform,self.key)
        with self.assertRaises(m.CacheError):self.c.put('one',self.platform,'c'*64,io.BytesIO(b'short'),10)
        self.assertEqual(list(Path(self.tmp.name).glob('*.partial')),[])
        with self.assertRaises(m.CacheError):self.c.get('one',self.platform,'c'*64)
    def test_full_quota_cannot_replace_an_existing_key_or_evict_on_partial_upload(self):
        self.c.put('one',self.platform,self.key,io.BytesIO(b'a'*70),70)
        with self.assertRaises(m.CacheError) as result:
            self.c.put('one',self.platform,self.key,io.BytesIO(b'b'*70),70)
        self.assertEqual(result.exception.status,409)
        with self.assertRaises(m.CacheError):
            self.c.put('one',self.platform,'b'*64,io.BytesIO(b'bad'),70)
        f,_,_=self.c.get('one',self.platform,self.key)
        with f:self.assertEqual(f.read(),b'a'*70)
        self.c.put('one',self.platform,self.key,io.BytesIO(b'a'*70),70)
    def test_paths_size_and_durable_reopen(self):
        for key in ['../index.sqlite','%2e%2e/foo','a'*64+'?token=x','a'*63,'/a'*64]:
            with self.assertRaises(m.CacheError):self.c.get('one',self.platform,key)
        with self.assertRaises(m.CacheError):self.c.put('one',self.platform,self.key,io.BytesIO(),m.MAX_OBJECT+1)
        self.c.put('one',self.platform,self.key,io.BytesIO(b'ok'),2)
        cache=m.BuildCache(self.tmp.name,reserve=0)
        f,_,_=cache.get('one',self.platform,self.key)
        with f:self.assertEqual(f.read(),b'ok')


# Exercise the actual shared TLS/HTTP router, not just the storage class.
import test_http
import http.client
import json

class CacheHTTP(unittest.TestCase):
    setUp=test_http.HTTP.setUp
    tearDown=test_http.HTTP.tearDown
    req=test_http.HTTP.req
    def test_scoped_lease_and_binary_transport(self):
        headers={'Authorization':'Bearer '+self.key}
        code,_,raw=self.req('/api/build-cache/lease','POST',{'platform':'darwin-arm64'},headers)
        self.assertEqual(code,200);token=json.loads(raw)['token'];auth={'Authorization':'Bearer '+token}
        self.assertEqual(self.req('/api/me',headers=auth)[0],401)
        endpoint='/api/build-cache/objects/darwin-arm64/'+'a'*64
        self.assertEqual(self.req(endpoint,headers=headers)[0],401)
        c=http.client.HTTPSConnection('localhost',self.server.server_port,context=self.ctx,timeout=5)
        c.request('PUT',endpoint,body=b'compiler object',headers=auth);r=c.getresponse();self.assertEqual(r.status,201);r.read();c.close()
        code,h,raw=self.req(endpoint,headers=auth);self.assertEqual((code,raw),(200,b'compiler object'));self.assertEqual(h['X-Content-SHA256'],m.hashlib.sha256(raw).hexdigest())
        with self.h.connection() as db:db.execute('UPDATE devices SET revoked=1')
        self.assertEqual(self.req(endpoint,headers=auth)[0],401)
    def test_lease_release_and_large_body_auth_precedes_read(self):
        _,_,raw=self.req('/api/build-cache/lease','POST',{'platform':'darwin-arm64'},{'Authorization':'Bearer '+self.key})
        token=json.loads(raw)['token'];auth={'Authorization':'Bearer '+token}
        self.assertEqual(self.req('/api/build-cache/release','POST',{},auth)[0],200)
        endpoint='/api/build-cache/objects/darwin-arm64/'+'a'*64
        self.assertEqual(self.req(endpoint,headers=auth)[0],401)
        c=http.client.HTTPSConnection('localhost',self.server.server_port,context=self.ctx,timeout=5)
        c.putrequest('PUT',endpoint);c.putheader('Content-Length',str(m.MAX_OBJECT));c.endheaders()
        r=c.getresponse();self.assertEqual(r.status,401);r.read();c.close()

if __name__=='__main__':unittest.main()
