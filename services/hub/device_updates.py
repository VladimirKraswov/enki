"""Paired owner devices may publish source/UI releases through an isolated signer.

The Hub never executes uploaded code. Local quality checks are device attestations,
not a claim that the Hub ran the uploaded tests. Device revocation removes access.
"""
import base64
import hashlib
import json
import os
import re
import socket

LIMIT=64*1024*1024
CHECKS=['frontend','build','architecture','bundle','publisher','hub','asr','rust-fmt','rust-test','rust-clippy']

def native_fingerprint(files):
    rows=[]
    for name,value in sorted(files.items()):
        if not name.startswith('src-tauri/'):continue
        name=name[len('src-tauri/'):]
        if any(p in ('target','gen','.git','.DS_Store','node_modules') for p in name.split('/')):continue
        b=base64.b64decode(value,validate=True)
        try:
            text=b.decode('utf8')
            if name=='tauri.conf.json':
                c=json.loads(text);c.pop('version',None);b=json.dumps(c,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
            else:
                text=text.replace('\r\n','\n')
                if name in ('Cargo.toml','Cargo.lock'):
                    own=False;lines=[]
                    for line in text.removesuffix('\n').split('\n'):
                        if line.startswith('['):own=False
                        if line in ('name = "enki"','name = "arvela"'):own=True
                        if not (own and line.startswith('version = ')):lines.append(line)
                    text='\n'.join(lines)
                b=text.encode()
        except UnicodeDecodeError:pass
        rows.append(name+'\0'+hashlib.sha256(b).hexdigest()+'\n')
    return hashlib.sha256(''.join(rows).encode()).hexdigest()

def validate(releases,data):
    if not isinstance(data,dict) or set(data)!={'channel','expectedRevision','source','hot','validation'}:releases.error('Некорректный запрос публикации устройства.')
    channel=data['channel'];current=releases.head(channel)
    if current['revision']!=data['expectedRevision']:releases.error('Канал обновлений изменился. Обновите исходники и повторите проверку.',409)
    v=data['validation']
    if (not isinstance(v,dict) or set(v)!={'checks','platform','commit'} or v['checks']!=CHECKS or
        v['platform'] not in ('win32','darwin','linux') or not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})',str(v['commit']))):releases.error('Нужен результат полного локального набора проверок.')
    packets={k:releases.validate_unsigned(data[k],k)[1] for k in ('source','hot')}
    s,h=packets['source'],packets['hot']
    if s['version']!=h['version'] or s['nativeFingerprint']!=h['nativeFingerprint']:releases.error('Пакеты относятся к разным сборкам.')
    if channel=='stable' and '-' in s['version']:releases.error('Предварительный релиз не может быть стабильным.')
    # Compare versions with the canonical release parser without importing another copy.
    if current.get('available'):
        from importlib.util import spec_from_file_location,module_from_spec
        from pathlib import Path
        spec=spec_from_file_location('device_release_versions',Path(__file__).with_name('releases.py'));m=module_from_spec(spec);spec.loader.exec_module(m)
        if m.version_key(s['version'])<=m.version_key(current['version']):releases.error('Версия должна быть новее опубликованной.',409)
    files=s['files'];get=lambda n:base64.b64decode(files[n],validate=True).decode('utf8')
    try:
        p=json.loads(get('package.json'));lock=json.loads(get('package-lock.json'));cfg=json.loads(get('src-tauri/tauri.conf.json'))
        cargo=re.search(r'\[package\][\s\S]*?\nversion = "([^"]+)"',get('src-tauri/Cargo.toml'))
        locked=re.search(r'\[\[package\]\]\nname = "enki"\nversion = "([^"]+)"',get('src-tauri/Cargo.lock').replace('\r\n','\n'))
        versions=[p['version'],lock['version'],lock['packages']['']['version'],cfg['version'],cargo[1],locked[1]]
        if any(x!=s['version'] for x in versions) or cfg['identifier']!='dev.local.opencodedesktop' or cfg['productName']!='Enki':raise ValueError()
        if native_fingerprint(files)!=s['nativeFingerprint']:raise ValueError()
    except (KeyError,ValueError,TypeError,IndexError,UnicodeError):releases.error('Версии, идентичность или нативный отпечаток исходников не совпадают.')
    return packets

def sign(data,fault,expected=None):
    path=os.environ.get('ENKI_RELEASE_SIGNER_SOCKET','/run/enki-release-signer/socket')
    raw=json.dumps(data,separators=(',',':')).encode()
    if len(raw)>LIMIT:raise fault(413,'Пакет слишком велик.')
    try:
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
            s.settimeout(90);s.connect(path);s.sendall(len(raw).to_bytes(4,'big')+raw)
            def read(n):
                parts=[]
                while n:
                    b=s.recv(min(n,65536))
                    if not b:raise OSError('short response')
                    parts.append(b);n-=len(b)
                return b''.join(parts)
            size=int.from_bytes(read(4),'big')
            if not 0<size<=LIMIT:raise OSError('oversized signer response')
            result=json.loads(read(size))
        if set(result)!=(expected or {'source','hot'}):raise OSError('signer refused candidate')
        return result
    except (OSError,ValueError,TypeError):raise fault(503,'Служба подписи обновлений недоступна. Релиз не опубликован.') from None

def publish(releases,actor,data,authorize=None):
    # actor came from the normal Hub device authentication; never elevate its other API rights.
    if not actor.get('id'):releases.error('Нужен ключ подключённого устройства.',401)
    with releases.lock:validate(releases,data)
    envelopes=sign(data,releases.fault)
    for kind in ('source','hot'):
        if envelopes[kind].get('payload')!=data[kind]:releases.error('Служба подписи вернула другой пакет.',502)
        releases.validate(envelopes[kind],kind)
    with releases.lock:
        if authorize:authorize()
        head=releases.api('POST','/api/updates',{'admin':True},dict(channel=data['channel'],expectedRevision=data['expectedRevision'],_devicePublication=dict(device=actor['id'],commit=data['validation']['commit'],platform=data['validation']['platform'],checks='device-attested'),**envelopes))
    return dict(head=head,publication=dict(device=actor['id'],commit=data['validation']['commit'],checks='device-attested'))
