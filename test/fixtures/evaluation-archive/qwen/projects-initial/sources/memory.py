"""Isolated synthetic Hub memory, using the production retrieval implementation.
No owner data, credentials, local paths, solutions or reference oracle are loaded.
"""
import importlib.util,json,sys,time,uuid
from pathlib import Path
sp=importlib.util.spec_from_file_location('eval_hub',Path(__file__).parents[2]/'services/hub/server.py')
m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
h=m.Hub(Path(sys.argv[1]));data=json.loads(sys.stdin.read())
if data['action']=='seed':
 a=h.authenticate(h.provision('Synthetic evaluation','macos')['token']);p=str(uuid.uuid4())
 h.api('POST','/api/memory',{},a,{'action':'project','id':p,'title':'Synthetic evaluation'})
 for i, (title,text) in enumerate(data['facts']):
  e={'id':str(uuid.uuid4()),'project':p,'kind':'fact','title':title,'text':text,'expiresAt':int(time.time()*1000)+86400000,
     'source':{'anchor':format(i,'064x'),'digest':'a'*64,'revision':1,'accepted':True,'engine':'pi'}}
  saved=h.api('POST','/api/memory',{},a,{'action':'save','entry':e,'expected':None})
  h.api('POST','/api/memory',{},a,{'action':'approve','id':e['id'],'expected':saved['revision']})
 print(json.dumps({'project':p}))
else:
 print(json.dumps(h.memory.retrieve(data['request']),ensure_ascii=False,separators=(',',':')))
