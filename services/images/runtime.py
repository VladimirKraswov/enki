"""CPU-only image profiles. Primary pipelines stay resident; work is serialized."""
import gc
import math
import os
import threading
from collections import OrderedDict
from pathlib import Path
from procedural import resolve_surface, generate_surface

PROFILES = {
    'sdxl-lightning': {'folder': 'sdxl-lightning', 'steps': 2, 'guidance': 0.0, 'title': 'SDXL Lightning'},
    'flux-klein-4b': {'folder': 'flux-klein-4b', 'steps': 4, 'guidance': 1.0, 'title': 'FLUX.2 Klein 4B · редактирование'},
    'lcm-dreamshaper-v7': {'folder': None, 'steps': None, 'guidance': 8.0, 'title': 'LCM Dreamshaper · черновик'},
}

def resolve_profile(model, prompt, material=False, editing=False):
    if model == 'enki-image-auto':
        return 'flux-klein-4b' if editing else 'sdxl-lightning'
    if model not in PROFILES:
        raise ValueError('Неизвестная модель изображений')
    if model == 'flux-klein-4b' and not editing:
        raise ValueError('FLUX Klein предназначен для правки исходного изображения. Добавьте source_image; для нового изображения выберите enki-image-auto')
    if editing and model == 'lcm-dreamshaper-v7':
        raise ValueError('Черновая LCM не поддерживает редактирование. Выберите enki-image-auto, flux-klein-4b или sdxl-lightning')
    return model

def render_size(width, height, model):
    if model in ('lcm-dreamshaper-v7', 'flux-klein-4b'):
        return width, height
    # SDXL was trained at ~1 megapixel. Rendering at 512 caused poor small faces.
    scale = min(math.sqrt(1048576 / (width * height)), 1536 / max(width, height))
    return max(256, round(width * scale / 64) * 64), max(256, round(height * scale / 64) * 64)

def edit_parameters(model, strength):
    if model == 'flux-klein-4b':
        if not 0.5 <= strength <= 0.95:
            raise ValueError('Совместимый edit_strength: от 0.5 до 0.95; FLUX Klein управляется текстовой инструкцией, а не этой величиной')
        steps = PROFILES[model]['steps']
        return steps, steps
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
    PRIMARY_KEYS = (('sdxl-lightning', False, False), ('flux-klein-4b', False, True))
    OPTIONAL_LIMIT = 1

    def __init__(self):
        self._primary = {}
        self._optional = OrderedDict()
        self._state_lock = threading.RLock()
        self._load_lock = threading.RLock()
        self._loading = None
        self._failed = None
        # Last selected aliases remain compatible with runtime diagnostics.
        self.pipeline = None
        self.key = None

    def _primary_keys(self):
        return tuple(key for key in self.PRIMARY_KEYS if key[0] in PROFILES)

    def resident_status(self):
        def describe(key):
            return {'model': key[0], 'tileable': key[1],
                    'mode': 'image-to-image' if key[2] else 'text-to-image'}
        with self._state_lock:
            primary = [dict(describe(key), loaded=key in self._primary) for key in self._primary_keys()]
            return {'ready': all(item['loaded'] for item in primary), 'primary': primary,
                    'optional': [describe(key) for key in self._optional],
                    'optional_limit': self.OPTIONAL_LIMIT,
                    'loading': describe(self._loading) if self._loading else None,
                    'failed': describe(self._failed) if self._failed else None}

    def preload(self, phase=None):
        """Construct/compile every registered primary without dummy generation."""
        for model, tileable, editing in self._primary_keys():
            self._getpipeline(model, tileable, editing, phase)
        return self.resident_status()

    def _getpipeline(self, model, tileable, editing, phase=None):
        # Job execution and startup are serialized; health only takes the short
        # state lock, so a long CPU compilation does not block readiness reads.
        phase = phase or (lambda *args, **kwargs: None)
        key = (model, tileable, editing)
        with self._load_lock:
            retired = []
            with self._state_lock:
                pipeline = self._primary.get(key)
                if pipeline is None and key in self._optional:
                    pipeline = self._optional[key]
                    self._optional.move_to_end(key)
                if pipeline is not None:
                    self.pipeline, self.key = pipeline, key
                    return pipeline
                pinned = key in self._primary_keys()
                if not pinned:
                    while len(self._optional) >= self.OPTIONAL_LIMIT:
                        evicted, old_pipeline = self._optional.popitem(last=False)
                        if self.key == evicted:
                            self.pipeline, self.key = None, None
                        retired.append(old_pipeline)
                        del old_pipeline
                self._loading, self._failed = key, None
            try:
                if retired:
                    retired.clear()
                    gc.collect()
                import openvino_genai as genai
                from periodic import prepare_periodic
                profile = PROFILES[model]
                phase('loading_model', 'Загружаю ' + profile['title'] + (' с периодической обработкой текстуры' if tileable else ''))
                root = Path(os.getenv('IMAGE_MODELS_DIR', '/opt/enki-images/models'))
                source = root / profile['folder'] if profile['folder'] else Path(os.environ['IMAGE_MODEL_DIR'])
                if editing and model == 'sdxl-lightning' and not all((source / 'vae_encoder' / name).is_file() for name in ('config.json', 'openvino_model.xml', 'openvino_model.bin')):
                    raise ValueError('Редактирование недоступно: не подготовлен VAE-кодировщик SDXL. Обновите модель сервиса изображений')
                if tileable:
                    source = prepare_periodic(source, Path(os.getenv('IMAGE_CACHE_DIR', '/var/lib/enki-images/cache')) / ('periodic-' + model))
                threads = int(os.getenv('IMAGE_THREADS', '12'))
                cache = Path(os.getenv('IMAGE_CACHE_DIR', '/var/lib/enki-images/cache')) / (model + ('-tile' if tileable else ''))
                if model == 'flux-klein-4b':
                    from klein import create_pipeline
                    pipeline = create_pipeline(source, threads=threads, cache_dir=cache)
                else:
                    pipeline_class = genai.Image2ImagePipeline if editing else genai.Text2ImagePipeline
                    pipeline = pipeline_class(source, 'CPU', INFERENCE_NUM_THREADS=threads,
                        NUM_STREAMS=1, INFERENCE_PRECISION_HINT='f32', CACHE_DIR=str(cache))
                with self._state_lock:
                    (self._primary if pinned else self._optional)[key] = pipeline
                    self.pipeline, self.key = pipeline, key
                return pipeline
            except Exception:
                with self._state_lock:
                    self._failed = key
                raise
            finally:
                with self._state_lock:
                    self._loading = None

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
        from PIL import Image
        model = resolve_profile(body.model, prompt, body.material is not None, reference is not None)
        profile = PROFILES[model]
        tileable = bool(body.material and body.material.tileable)
        strength = getattr(body, 'edit_strength', 0.7)
        schedule_steps = effective_steps = profile['steps'] or body.steps
        if reference is not None:
            schedule_steps, effective_steps = edit_parameters(model, strength)
        pipeline = self._getpipeline(model, tileable, reference is not None, phase)
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
            instruction_editing = model == 'flux-klein-4b'
            inference.update(strength=None if instruction_editing else strength, requested_strength=strength,
                             schedule_steps=schedule_steps, instruction_editing=instruction_editing,
                             effective_strength=None if instruction_editing else effective_steps / schedule_steps,
                             source_width=initial.width, source_height=initial.height,
                             source_fit='contain')
            options['image'] = ov.Tensor(np.asarray(reference_image(initial, (width, height)), dtype=np.uint8)[None].copy())
            if instruction_editing:
                inference['strength_note'] = 'FLUX Klein изменяет изображение по текстовой инструкции; edit_strength принят для совместимости и не управляет перерисовкой'
            else:
                options['strength'] = strength
        phase('generating', ('Перерисовываю исходник · ' if reference is not None else 'Создаю изображение · ') + profile['title'], inference=inference)
        image = Image.fromarray(pipeline.generate(prompt, **options).data[0])
        return output_image(image, (body.width, body.height), tileable)
