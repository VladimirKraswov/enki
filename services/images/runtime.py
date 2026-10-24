"""CPU-only image profiles. A single pipeline is resident; switches are serialized."""
import gc
import math
import os
from pathlib import Path
from procedural import resolve_surface, generate_surface

PROFILES = {
    'sdxl-lightning': {'folder': 'sdxl-lightning', 'steps': 2, 'guidance': 0.0, 'title': 'SDXL Lightning'},
    'lcm-dreamshaper-v7': {'folder': None, 'steps': None, 'guidance': 8.0, 'title': 'LCM Dreamshaper · черновик'},
}

def resolve_profile(model, prompt, material=False):
    if model == 'enki-image-auto':
        return 'sdxl-lightning'
    if model not in PROFILES:
        raise ValueError('Неизвестная модель изображений')
    return model

def render_size(width, height, model):
    if model == 'lcm-dreamshaper-v7':
        return width, height
    # SDXL was trained at ~1 megapixel. Rendering at 512 caused poor small faces.
    scale = min(math.sqrt(1048576 / (width * height)), 1536 / max(width, height))
    return max(256, round(width * scale / 64) * 64), max(256, round(height * scale / 64) * 64)

def edit_parameters(model, strength):
    # Lightning weights are distilled for this exact schedule. Raising the step
    # count to compensate for low strength is not a quality-preserving operation.
    if model != 'sdxl-lightning':
        raise ValueError('Редактирование доступно в enki-image-auto / sdxl-lightning; черновая LCM его не поддерживает')
    if not 0.5 <= strength <= 0.95:
        raise ValueError('Сила перерисовки SDXL: от 0.5 до 0.95; меньше 0.5 не оставляет ни одного шага этой модели')
    scheduled = PROFILES[model]['steps']
    return scheduled, int(scheduled * strength)

def reference_image(image, size):
    from PIL import Image, ImageOps
    # Preserve the whole reference even when the requested canvas has another
    # aspect ratio. Never silently crop a face or stretch the source geometry.
    return ImageOps.pad(image.convert('RGB'), size, method=Image.Resampling.LANCZOS,
                        color=(255, 255, 255), centering=(0.5, 0.5))

def output_image(image, size, tileable):
    from PIL import Image
    if image.size == size:
        return image
    if not tileable:
        return image.resize(size, Image.Resampling.LANCZOS)
    # Resampling also needs periodic neighbors; clamped resize would add a seam.
    w, h = image.size
    tiled = Image.new('RGB', (w * 3, h * 3))
    for y in range(3):
        for x in range(3): tiled.paste(image, (x * w, y * h))
    ow, oh = size
    return tiled.resize((ow * 3, oh * 3), Image.Resampling.LANCZOS).crop((ow, oh, ow * 2, oh * 2))

class ImageRuntime:
    def __init__(self):
        self.pipeline = None
        self.key = None

    def __call__(self, prompt, body, callback):
        reference = getattr(body, 'source_image', None)
        surface = resolve_surface(body.material.surface, prompt) if body.material and reference is None else None
        phase = getattr(callback, 'phase', lambda *a, **kw: None)
        if surface:
            phase('generating', 'Создаю процедурный PBR-материал · ' + surface, inference={
                'model': 'procedural-' + surface + '-v1', 'steps': 0,
                'width': body.width, 'height': body.height,
                'tile_method': 'procedural-periodic-v1', 'height_source': 'authored procedural relief'})
            return generate_surface(surface, body.width, body.height, body.seed)
        import openvino_genai as genai
        from PIL import Image
        from periodic import prepare_periodic
        model = resolve_profile(body.model, prompt, body.material is not None)
        profile = PROFILES[model]
        tileable = bool(body.material and body.material.tileable)
        strength = getattr(body, 'edit_strength', 0.7)
        schedule_steps = effective_steps = profile['steps'] or body.steps
        if reference is not None:
            schedule_steps, effective_steps = edit_parameters(model, strength)
        key = (model, tileable, reference is not None)
        if self.key != key:
            self.pipeline = None
            self.key = None
            gc.collect()
            phase('loading_model', 'Загружаю ' + profile['title'] + (' с периодической обработкой текстуры' if tileable else ''))
            root = Path(os.getenv('IMAGE_MODELS_DIR', '/opt/enki-images/models'))
            source = root / profile['folder'] if profile['folder'] else Path(os.environ['IMAGE_MODEL_DIR'])
            if reference is not None and not all((source / 'vae_encoder' / name).is_file() for name in ('config.json', 'openvino_model.xml', 'openvino_model.bin')):
                raise ValueError('Редактирование недоступно: не подготовлен VAE-кодировщик SDXL. Обновите модель сервиса изображений')
            if tileable:
                source = prepare_periodic(source, Path(os.getenv('IMAGE_CACHE_DIR', '/var/lib/enki-images/cache')) / ('periodic-' + model))
            pipeline_class = genai.Image2ImagePipeline if reference is not None else genai.Text2ImagePipeline
            pipeline = pipeline_class(source, 'CPU', INFERENCE_NUM_THREADS=int(os.getenv('IMAGE_THREADS', '12')),
                NUM_STREAMS=1, INFERENCE_PRECISION_HINT='f32', CACHE_DIR=str(Path(os.getenv('IMAGE_CACHE_DIR', '/var/lib/enki-images/cache')) / (model + ('-tile' if tileable else ''))))
            self.pipeline = pipeline
            self.key = key
        width, height = render_size(body.width, body.height, model)
        options = dict(width=width, height=height, num_inference_steps=schedule_steps,
                       guidance_scale=profile['guidance'], rng_seed=body.seed, callback=callback)
        inference = {
            'model': model, 'steps': effective_steps, 'guidance': profile['guidance'], 'width': width, 'height': height,
            'tile_method': 'periodic-convolutions-unet-and-vae-v1' if tileable else None,
            'mode': 'image-to-image' if reference is not None else 'text-to-image'}
        if reference is not None:
            import numpy as np
            import openvino as ov
            initial = reference.open_image()
            inference.update(strength=strength, schedule_steps=schedule_steps,
                             effective_strength=effective_steps / schedule_steps,
                             source_width=initial.width, source_height=initial.height,
                             source_fit='contain')
            options.update(image=ov.Tensor(np.asarray(reference_image(initial, (width, height)), dtype=np.uint8)[None].copy()), strength=strength)
        phase('generating', ('Перерисовываю исходник · ' if reference is not None else 'Создаю изображение · ') + profile['title'], inference=inference)
        image = Image.fromarray(self.pipeline.generate(prompt, **options).data[0])
        return output_image(image, (body.width, body.height), tileable)
