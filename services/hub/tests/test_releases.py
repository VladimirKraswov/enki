import base64, hashlib, importlib.util, io, json, tempfile, unittest, zipfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('hub',Path(__file__).parents[1]/'server.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
b64=lambda b:base64.b64encode(b).decode()
def package(kind,version='1.0.0',files=None):
    files=files or ({'index.html':'UI'} if kind=='hot' else {k:'source' for k in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json']})
    raw=json.dumps(dict(schemaVersion=1,kind=kind,version=version,nativeFingerprint='a'*64,files={k:b64(v.encode()) for k,v in files.items()})).encode()
    # Transport validates structure; native client must cryptographically verify.
    return dict(payload=b64(raw),signature=b64(('untrusted comment: fixture\nfixture\ntrusted comment: timestamp:1\tversion:'+version+'\nfixture').encode()))
class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.h=m.Hub(Path(self.tmp.name));self.a=self.h.authenticate(self.h.provision('owner','other',True)['token']);self.reader=self.h.authenticate(self.h.provision('reader','other')['token'])
    def tearDown(self):self.tmp.cleanup()
    def call(self,method,path='',body=None,actor=None):return self.h.api(method,'/api/updates'+path,{},actor or self.a,body or {})
    def publish(self,version='1.0.0',revision=None):return self.call('POST',body=dict(channel='stable',expectedRevision=revision,hot=package('hot',version),source=package('source',version)))
    def test_atomic_publication_and_authenticated_reader(self):
        self.assertFalse(self.call('GET','/stable')['available']);head=self.publish();self.assertEqual(head,self.call('GET','/stable',actor=self.reader))
        for artifact in head['artifacts'].values():
            envelope=self.call('GET','/artifacts/'+artifact['digest'],actor=self.reader)
            self.assertEqual(hashlib.sha256(base64.b64decode(envelope['payload'])).hexdigest(),artifact['digest'])
        with self.assertRaises(m.Fault) as e:self.call('POST',body={},actor=self.reader)
        self.assertEqual(e.exception.status,403)
    def test_legacy_clients_receive_bridge_new_clients_receive_latest_and_gc_keeps_bridge(self):
        def publish(version,product,revision):
            source=package('source',version)
            payload=json.loads(base64.b64decode(source['payload']))
            payload['files']['src-tauri/tauri.conf.json']=b64(json.dumps({'productName':product}).encode())
            source['payload']=b64(json.dumps(payload).encode())
            return self.call('POST',body=dict(channel='stable',expectedRevision=revision,hot=package('hot',version),source=source))
        bridge=publish('0.2.82','Arvela',None)
        latest=publish('0.2.83','Enki',bridge['revision'])
        self.assertEqual(self.call('GET','/stable'),bridge)
        self.assertEqual(self.call('GET','/enki/stable'),latest)
        self.assertEqual(self.call('GET')['stable'],latest)
        self.assertEqual(self.h.releases.download('/downloads/latest')[0]['version'],'0.2.83')
        for a in bridge['artifacts'].values():
            p=self.h.releases.root/(a['digest']+'.json')
            import os
            os.utime(p,(1,1))
        for i in range(45):self.h.releases.atomic(self.h.releases.root/(hashlib.sha256(str(i).encode()).hexdigest()+'.json'),{})
        self.h.releases.collect()
        for a in bridge['artifacts'].values():self.assertIsNotNone(self.call('GET','/artifacts/'+a['digest']))
        with self.assertRaises(m.Fault):self.call('GET','/enki/unknown')
    def test_failure_after_the_head_rename_is_reported_uncertain_and_reconcilable(self):
        first=self.publish()
        durable=type(self.h.releases).atomic.__globals__['durable']
        real=self.h.releases.atomic
        def flush_denied(_directory):raise PermissionError('directory flush denied')
        def atomic(path,value):
            if path.name!='stable.json':return real(path,value)
            raw=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
            return durable.publish(path,raw,replace=lambda s,t:durable.posix_replace(s,t,sync=flush_denied))
        self.h.releases.atomic=atomic
        with self.assertRaises(m.Fault) as e:self.publish('1.0.1',first['revision'])
        self.assertEqual(e.exception.status,503)
        self.assertIn('возможно, уже опубликована',e.exception.message)
        self.assertNotIn('сохранён',e.exception.message)
        # Reconciliation reads what is served: the new head with BOTH envelopes intact.
        self.h.releases.atomic=real
        served=self.call('GET','/stable')
        self.assertEqual(served['version'],'1.0.1')
        for artifact in served['artifacts'].values():
            envelope=self.call('GET','/artifacts/'+artifact['digest'])
            self.assertEqual(hashlib.sha256(base64.b64decode(envelope['payload'])).hexdigest(),artifact['digest'])
        # The previous immutable envelopes are untouched.
        for artifact in first['artifacts'].values():
            self.assertIsNotNone(self.call('GET','/artifacts/'+artifact['digest']))
    def test_uncertain_artifact_write_keeps_the_head_and_is_safely_repeatable(self):
        first=self.publish()
        durable=type(self.h.releases).atomic.__globals__['durable']
        real=self.h.releases.atomic
        def flush_denied(_directory):raise PermissionError('directory flush denied')
        def atomic(path,value):
            if path.name in ('stable.json','legacy-stable.json'):return real(path,value)
            raw=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
            return durable.publish(path,raw,replace=lambda s,t:durable.posix_replace(s,t,sync=flush_denied))
        self.h.releases.atomic=atomic
        with self.assertRaises(m.Fault) as e:self.publish('1.0.1',first['revision'])
        self.assertEqual(e.exception.status,503)
        self.assertEqual(self.call('GET','/stable'),first)
        self.h.releases.atomic=real
        self.assertEqual(self.publish('1.0.1',first['revision'])['version'],'1.0.1')
    def test_cas_monotonic_version_and_incomplete_pair_preserve_head(self):
        head=self.publish()
        for body in [dict(channel='stable',expectedRevision=None,hot=package('hot','2.0.0'),source=package('source','2.0.0')),dict(channel='stable',expectedRevision=head['revision'],hot=package('hot','1.0.1'),source=package('source','1.0.2'))]:
            with self.assertRaises(m.Fault):self.call('POST',body=body)
            self.assertEqual(self.call('GET','/stable'),head)
        with self.assertRaises(m.Fault):self.publish(revision=head['revision'])
        self.assertEqual(self.publish('1.0.1',head['revision'])['version'],'1.0.1')
    def test_traversal_windows_paths_symlinks_and_case_collisions(self):
        for name in ['../escape','/absolute','a\\b','a:stream','NUL.txt','x/CON','a//b','x.','x/..','x/target/p','x/.env.secret']:
            with self.assertRaises(m.Fault):self.h.releases.validate(package('hot',files={'index.html':'ok',name:'bad'}),'hot')
        with self.assertRaises(m.Fault):self.h.releases.validate(package('hot',files={'index.html':'ok','A':'1','a':'2'}),'hot')
        (self.h.releases.root/'stable.json').symlink_to(Path(self.tmp.name)/'outside')
        with self.assertRaises(m.Fault):self.call('GET','/stable')
    def test_invalid_channel_signature_and_preview(self):
        for path in ['/../private','/artifacts/../../private','/unknown']:
            with self.assertRaises(m.Fault):self.call('GET',path)
        bad=package('hot');bad['signature']=b64(b'trusted comment: version:9.9.9')
        with self.assertRaises(m.Fault):self.h.releases.validate(bad,'hot')
        with self.assertRaises(m.Fault):self.publish('1.0.0-beta.1')
        head=self.call('POST',body=dict(channel='preview',expectedRevision=None,hot=package('hot','1.0.0-beta.1'),source=package('source','1.0.0-beta.1')))
        self.assertTrue(head['available'])
    def test_bootstrap_zip_matches_manifest_and_pins_release_across_publication(self):
        first=self.publish()
        manifest,kind,name=self.h.releases.download('/downloads/latest')
        self.assertTrue(kind.startswith('application/json'));self.assertIsNone(name)
        archive,kind,name=self.h.releases.download('/downloads/latest/source.zip')
        self.assertEqual(kind,'application/zip');self.assertEqual(name,'Enki-1.0.0-source.zip')
        self.assertEqual(hashlib.sha256(archive).hexdigest(),manifest['source']['sha256'])
        self.assertEqual(len(archive),manifest['source']['bytes'])
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertIsNone(z.testzip());self.assertEqual(z.read('package.json'),b'source')
        envelope,_,_=self.h.releases.download(manifest['signedSource']['url'])
        self.assertEqual(envelope,package('source'))
        self.publish('1.0.1',first['revision'])
        self.assertEqual(self.h.releases.download(manifest['source']['url'])[0],archive)
        latest=self.h.releases.download('/downloads/latest')[0]
        self.assertEqual(latest['version'],'1.0.1');self.assertNotEqual(latest['source']['url'],manifest['source']['url'])
    def test_bootstrap_missing_wrong_kind_tamper_and_private_paths_fail_closed(self):
        with self.assertRaises(m.Fault) as e:self.h.releases.download('/downloads/latest/source.zip')
        self.assertEqual(e.exception.status,404)
        head=self.publish();key=head['artifacts']['source']['digest']
        for path in ['/downloads/../../hub.sqlite','/downloads/source/../source.zip',
                     '/downloads/source/'+head['artifacts']['hot']['digest']+'.json',
                     '/downloads/source/'+'b'*64+'.zip']:
            with self.assertRaises(m.Fault):self.h.releases.download(path)
        # Valid structure but changed bytes under an immutable key must never be served.
        changed=package('source','9.0.0');self.h.releases.atomic(self.h.releases.root/(key+'.json'),changed)
        with self.assertRaises(m.Fault) as e:self.h.releases.download('/downloads/latest/source.zip')
        self.assertEqual(e.exception.status,500)
if __name__=='__main__':unittest.main()
