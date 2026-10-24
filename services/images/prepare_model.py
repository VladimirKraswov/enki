"""Download the audited GenAI-compatible IR, without executing model Python code."""
import os
import json
import shutil
from pathlib import Path
from compat import prepare_text_inputs
from huggingface_hub import snapshot_download
MODEL='OpenVINO/LCM_Dreamshaper_v7-int8-ov'
REVISION='340a03e5488f36f7f222e6efa29819850ad7e4be'
root=os.environ.get('IMAGE_MODEL_DIR','/opt/enki-images/model-int8')
snapshot_download(MODEL,revision=REVISION,local_dir=root,ignore_patterns=['safety_checker/*','vae_encoder/*','*.safetensors'],max_workers=2)
models = {
 'sdxl-lightning': ('rupeshs/SDXL-Lightning-2steps-openvino-int8','347b21e571d7b8a716af83f64d68c5c028c51c56'),
}
models_root=Path(os.environ.get('IMAGE_MODELS_DIR','/opt/enki-images/models'))
tokenizers=Path(snapshot_download('OpenVINO/stable-diffusion-xl-base-1.0-int8-ov',revision='d54e5b43fcb6b4b358f3a134269115d3fcb3eb25',local_dir=models_root/'sdxl-tokenizers',allow_patterns=['tokenizer/*','tokenizer_2/*'],max_workers=2))
for name,(repo,revision) in models.items():
 target=Path(snapshot_download(repo,revision=revision,local_dir=models_root/name,
     allow_patterns=['model_index.json','scheduler/*.json','unet/*.json','unet/*.xml','unet/*.bin',
         'text_encoder/*.json','text_encoder/*.xml','text_encoder/*.bin','text_encoder_2/*.json','text_encoder_2/*.xml','text_encoder_2/*.bin',
         'tokenizer/*','tokenizer_2/*','vae_decoder/*.json','vae_decoder/*.xml','vae_decoder/*.bin',
         'vae_encoder/*.json','vae_encoder/*.xml','vae_encoder/*.bin'],max_workers=2))
 # These exports omit GenAI's tokenizer IR. Reuse ONLY verified identical CLIP
 # vocabularies/merges from Intel's pinned SDXL export; do not execute repo code.
 for part in ('tokenizer','tokenizer_2'):
  for f in ('vocab.json','merges.txt'):
   if (tokenizers/part/f).read_bytes()!=(target/part/f).read_bytes():raise RuntimeError('Tokenizer vocabulary differs: '+name+'/'+part+'/'+f)
  for f in (tokenizers/part).glob('openvino_*'):shutil.copy2(f,target/part/f.name)
 p=target/'model_index.json';data=json.loads(p.read_text());data['_class_name']='StableDiffusionXLPipeline';p.write_text(json.dumps(data,indent=2))
 prepare_text_inputs(target)
 (target/'enki-model.json').write_text(json.dumps({'repo':repo,'revision':revision,'tokenizers_revision':'d54e5b43fcb6b4b358f3a134269115d3fcb3eb25','image_to_image':True}))
print('Downloaded pinned quality SDXL with VAE encoder and optional LCM draft IR; ready for CPU validation')
