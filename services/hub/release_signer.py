"""Local signing only: no network listener, shell, builds or uploaded-code execution."""
import argparse,base64,json,os,socket,struct,subprocess,tempfile
from pathlib import Path
import device_updates
from native_updates import validate_manifest
from releases import Releases

class Rejected(Exception):
    def __init__(self,status,message):super().__init__(message)

def sign_candidate(data,key,public):
    if data.get('type') == 'native': return sign_native(data,key,public)
    checker=object.__new__(Releases);checker.fault=Rejected
    checker.head=lambda channel: {'revision':data.get('expectedRevision'),'available':False} if channel in ('stable','preview') else checker.error('Invalid channel')
    packets=device_updates.validate(checker,data)
    source=packets['source']['files']
    try:
        declared=base64.b64decode(base64.b64decode(source['src-tauri/updater.pub'],validate=True).strip(),validate=True).decode().strip()
        if declared!=Path(public).read_text().strip():raise Rejected(400,'Pinned release key changed')
    except (ValueError,KeyError,UnicodeError):raise Rejected(400,'Missing pinned release key') from None
    result={}
    with tempfile.TemporaryDirectory(prefix='sign-',dir=Path(key).parent if os.environ.get('ENKI_SIGNER_TEST') else '/run/enki-release-signer') as tmp:
        for kind in ('source','hot'):
            raw=base64.b64decode(data[kind],validate=True);file=Path(tmp)/(kind+'.json');file.write_bytes(raw);file.chmod(0o600)
            # Tauri wraps a standard minisign signature in base64. The trusted
            # version comment is mandatory to native clients. Key never in argv.
            comment='file:'+kind+'.json\tversion:'+packets[kind]['version']
            subprocess.run(['minisign','-S','-s',key,'-m',str(file),'-t',comment,'-q'],input=b'\n',capture_output=True,check=True,timeout=30)
            subprocess.run(['minisign','-V','-p',public,'-m',str(file),'-q'],capture_output=True,check=True,timeout=15)
            result[kind]=dict(payload=data[kind],signature=base64.b64encode(Path(str(file)+'.minisig').read_bytes()).decode())
    return result

def sign_native(data,key,public):
    if set(data) != {'type','source','payload'} or len(data['payload']) > 32768:
        raise Rejected(400,'Invalid native manifest')
    checker=object.__new__(Releases);checker.fault=Rejected
    raw,source=checker.validate(data['source'],'source')
    manifest=validate_manifest(json.loads(base64.b64decode(data['payload'],validate=True)),source['version'],source['nativeFingerprint'])
    with tempfile.TemporaryDirectory(prefix='native-',dir=Path(key).parent if os.environ.get('ENKI_SIGNER_TEST') else '/run/enki-release-signer') as tmp:
        original=Path(tmp)/'source.json';original.write_bytes(raw)
        Path(str(original)+'.minisig').write_bytes(base64.b64decode(data['source']['signature'],validate=True))
        subprocess.run(['minisign','-V','-p',public,'-m',str(original),'-q'],capture_output=True,check=True,timeout=15)
        file=Path(tmp)/'native.json';file.write_bytes(base64.b64decode(data['payload'],validate=True));file.chmod(0o600)
        subprocess.run(['minisign','-S','-s',key,'-m',str(file),'-t','file:native.json\tversion:'+manifest['version'],'-q'],input=b'\n',capture_output=True,check=True,timeout=30)
        subprocess.run(['minisign','-V','-p',public,'-m',str(file),'-q'],capture_output=True,check=True,timeout=15)
        return {'native':dict(payload=data['payload'],signature=base64.b64encode(Path(str(file)+'.minisig').read_bytes()).decode())}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--key',required=True);ap.add_argument('--public',required=True);ap.add_argument('--hub-uid',type=int,required=True);ap.add_argument('--socket',default='/run/enki-release-signer/socket');a=ap.parse_args()
    p=Path(a.socket)
    if p.exists():p.unlink()
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as listener:
        listener.bind(str(p));p.chmod(0o660);listener.listen(2)
        while True:
            conn,_=listener.accept()
            with conn:
                try:
                    uid=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
                    if uid!=a.hub_uid:continue
                    conn.settimeout(90)
                    def read(n):
                        out=[]
                        while n:
                            b=conn.recv(min(n,65536))
                            if not b:raise OSError('short request')
                            n-=len(b);out.append(b)
                        return b''.join(out)
                    size=int.from_bytes(read(4),'big')
                    if not 0<size<=device_updates.LIMIT:continue
                    data=json.loads(read(size));result=sign_candidate(data,a.key,a.public)
                    raw=json.dumps(result,separators=(',',':')).encode();conn.sendall(len(raw).to_bytes(4,'big')+raw)
                except (OSError,ValueError,KeyError,TypeError,Rejected,subprocess.SubprocessError):
                    # Never log payloads, credentials, key paths or subprocess stderr.
                    raw=b'{"error":"candidate rejected"}'
                    try:conn.sendall(len(raw).to_bytes(4,'big')+raw)
                    except OSError:pass
if __name__=='__main__':main()
