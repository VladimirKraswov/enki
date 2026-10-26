import base64,copy,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
from test_device_updates import m, candidate, fake_sign
n=m._native_module

def fixtures():
    manifest=dict(schemaVersion=1,kind='native',version='2.0.6',nativeFingerprint='f'*64,commit='a'*40,runId=71,packages={})
    assets=[]
    for platform,tail in [('macos-arm64','aarch64.dmg'),('windows-x64','x64-setup.exe'),('linux-x64','amd64.deb')]:
        name='Enki_2.0.6_'+tail
        p=dict(name=name,sha256='b'*64,bytes=2048,url=n.DOWNLOAD+'v2.0.6/'+name);manifest['packages'][platform]=p
        assets.append(dict(name=name,digest='sha256:'+p['sha256'],size=p['bytes'],state='uploaded',browser_download_url=p['url']))
    assets.append(dict(name='enki-native.json',size=2048))
    head=dict(version='2.0.6',nativeFingerprint='f'*64,publication=dict(commit='a'*40))
    responses={n.API+'/releases/tags/v2.0.6':dict(draft=False,tag_name='v2.0.6',assets=assets),
               n.DOWNLOAD+'v2.0.6/enki-native.json':manifest,
               n.API+'/actions/runs/71':dict(head_sha='a'*40,head_branch='main',event='workflow_dispatch',path='.github/workflows/desktop.yml',status='completed',conclusion='success')}
    return head,manifest,responses

class NativeQualification(unittest.TestCase):
    def test_exact_head_workflow_and_all_asset_digests(self):
        h,manifest,responses=fixtures()
        self.assertEqual(n.qualify(h,responses.__getitem__),manifest)
        for key,value in [('head_sha','c'*40),('head_branch','codex/evil'),('event','pull_request'),('status','in_progress'),('conclusion','failure'),('path','other.yml')]:
            changed=copy.deepcopy(responses);changed[n.API+'/actions/runs/71'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):n.qualify(h,changed.__getitem__)
        for key,value in [('digest','sha256:'+'c'*64),('size',4096),('browser_download_url','https://evil.example/file'),('state','new')]:
            changed=copy.deepcopy(responses);changed[n.API+'/releases/tags/v2.0.6']['assets'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):n.qualify(h,changed.__getitem__)
    def test_missing_provenance_never_signs_or_fetches(self):
        h,_,_=fixtures();h.pop('publication')
        self.assertIsNone(n.qualify(h,lambda _:self.fail('unexpected network')))
    def test_manifest_path_size_and_version_rejection(self):
        h,manifest,_=fixtures()
        for key,value in [('name','../../x.dmg'),('url','http://github.com/x'),('bytes',n.MAX_PACKAGE+1),('sha256','a'*63)]:
            changed=copy.deepcopy(manifest);changed['packages']['macos-arm64'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):n.validate_manifest(changed,h['version'],h['nativeFingerprint'],h['publication']['commit'])
        with self.assertRaises(ValueError):n.validate_manifest(manifest,'2.0.7',h['nativeFingerprint'])
    def test_pending_cached_and_head_race_does_not_sign_wrong_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            hub=m.Hub(Path(tmp));body=candidate('2.0.6')
            with patch.object(m._device_module,'sign',side_effect=fake_sign):m._device_module.publish(hub.releases,{'id':'test'},body)
            calls=[]
            def get(url):calls.append(url);raise OSError('offline')
            service=n.NativeUpdates(hub.releases,lambda *_args,**_kw:self.fail('must not sign'),get)
            self.assertEqual(service.status('stable')['state'],'unavailable')
            self.assertEqual(service.status('stable')['state'],'unavailable');self.assertEqual(len(calls),1)
            service.lock.acquire()
            try:self.assertEqual(service.status('stable')['state'],'pending')
            finally:service.lock.release()

class NativeSigner(unittest.TestCase):
    @unittest.skipUnless(shutil.which('minisign'),'minisign not installed')
    def test_source_signature_verified_before_native_signing(self):
        sys.path.insert(0,str(Path(__file__).parents[1]))
        try:
            import release_signer
            with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'ENKI_SIGNER_TEST':'1'}):
                root=Path(tmp);key=str(root/'test.key');public=str(root/'test.pub')
                subprocess.run(['minisign','-G','-W','-s',key,'-p',public],capture_output=True,check=True,timeout=20)
                body=candidate('2.0.6');raw=base64.b64decode(body['source']);file=root/'source.json';file.write_bytes(raw)
                subprocess.run(['minisign','-S','-s',key,'-m',str(file),'-t','file:source.json\tversion:2.0.6','-q'],capture_output=True,check=True,timeout=20)
                envelope=dict(payload=body['source'],signature=base64.b64encode(Path(str(file)+'.minisig').read_bytes()).decode())
                _,manifest,_=fixtures();manifest['nativeFingerprint']=json.loads(raw)['nativeFingerprint']
                data=dict(type='native',source=envelope,payload=base64.b64encode(json.dumps(manifest).encode()).decode())
                result=release_signer.sign_candidate(data,key,public)['native']
                self.assertEqual(result['payload'],data['payload'])
                native=root/'native.json';native.write_bytes(base64.b64decode(result['payload']));Path(str(native)+'.minisig').write_bytes(base64.b64decode(result['signature']))
                subprocess.run(['minisign','-V','-p',public,'-m',str(native),'-q'],capture_output=True,check=True,timeout=20)
                changed=json.loads(raw);changed['notes']='tampered';data['source']['payload']=base64.b64encode(json.dumps(changed).encode()).decode()
                with self.assertRaises(subprocess.CalledProcessError):release_signer.sign_candidate(data,key,public)
        finally:sys.path.pop(0)
