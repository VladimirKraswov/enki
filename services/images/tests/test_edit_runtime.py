import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from runtime import ImageRuntime, edit_parameters, reference_image


class ReferenceRuntime(unittest.TestCase):
    def test_distilled_edit_schedule_has_a_real_step_and_never_silently_uses_draft(self):
        for strength in (0.5, 0.7, 0.95):
            self.assertEqual(edit_parameters('sdxl-lightning', strength), (2, 1))
        for strength in (0, 0.49, 0.96, 1, float('nan')):
            with self.assertRaisesRegex(ValueError, '0.5'):
                edit_parameters('sdxl-lightning', strength)
        with self.assertRaisesRegex(ValueError, 'LCM'):
            edit_parameters('lcm-dreamshaper-v7', 0.7)

    def test_reference_canvas_contains_whole_source_without_stretching(self):
        source = Image.new('RGB', (100, 200), 'red')
        output = reference_image(source, (256, 256))
        self.assertEqual(output.size, (256, 256))
        self.assertEqual(output.getpixel((0, 128)), (255, 255, 255))
        self.assertEqual(output.getpixel((64, 0)), (255, 0, 0))
        self.assertEqual(output.getpixel((191, 255)), (255, 0, 0))
        self.assertEqual(source.size, (100, 200))

    def test_actual_reference_tensor_and_strength_reach_image_pipeline_and_metadata(self):
        calls, phases = [], []
        class Pipeline:
            def __init__(self, *args, **kwargs):
                calls.append(('load', args, kwargs))
            def generate(self, prompt, **kwargs):
                calls.append(('generate', prompt, kwargs))
                return SimpleNamespace(data=kwargs['image'])
        def forbidden(*args, **kwargs):
            raise AssertionError('Image edit must never fall back to text-to-image')
        modules = {'openvino_genai': SimpleNamespace(Image2ImagePipeline=Pipeline, Text2ImagePipeline=forbidden),
                   'openvino': SimpleNamespace(Tensor=lambda array: array),
                   'periodic': SimpleNamespace(prepare_periodic=forbidden)}
        callback = lambda *args: False
        callback.phase = lambda name, detail, **extra: phases.append((name, extra))
        source = Image.new('RGB', (64, 64), (23, 67, 189))
        body = SimpleNamespace(source_image=SimpleNamespace(open_image=lambda: source.copy()),
                               edit_strength=0.7, model='enki-image-auto', material=None,
                               width=512, height=512, steps=8, seed=79)
        with TemporaryDirectory() as directory:
            encoder = Path(directory) / 'sdxl-lightning' / 'vae_encoder'
            encoder.mkdir(parents=True)
            for name in ('config.json', 'openvino_model.xml', 'openvino_model.bin'):
                (encoder / name).write_text('test-owned encoder fixture')
            with patch.dict(os.environ, {'IMAGE_MODELS_DIR': directory}), patch.dict('sys.modules', modules):
                runtime = ImageRuntime()
                result = runtime('Blue ceramic object', body, callback)
                runtime('Blue ceramic object', body, callback)
        generated = [entry for entry in calls if entry[0] == 'generate']
        self.assertEqual(sum(entry[0] == 'load' for entry in calls), 1)
        self.assertEqual(result.size, (512, 512))
        options = generated[0][2]
        self.assertEqual(options['image'].shape, (1, 1024, 1024, 3))
        self.assertEqual(options['image'].dtype, np.uint8)
        np.testing.assert_array_equal(options['image'][0, 0, 0], [23, 67, 189])
        self.assertEqual(options['strength'], 0.7)
        self.assertEqual(options['num_inference_steps'], 2)
        self.assertEqual(options['guidance_scale'], 0)
        inference = next(extra['inference'] for name, extra in phases if name == 'generating')
        self.assertEqual((inference['mode'], inference['steps'], inference['schedule_steps']), ('image-to-image', 1, 2))
        self.assertEqual((inference['source_width'], inference['source_height']), (64, 64))

    def test_missing_encoder_explains_unavailable_edit_without_faking_a_result(self):
        modules = {'openvino_genai': SimpleNamespace(),
                   'periodic': SimpleNamespace(prepare_periodic=lambda *args: None)}
        body = SimpleNamespace(source_image=object(), edit_strength=0.7, model='enki-image-auto', material=None)
        with TemporaryDirectory() as directory, patch.dict(os.environ, {'IMAGE_MODELS_DIR': directory}), patch.dict('sys.modules', modules):
            with self.assertRaisesRegex(ValueError, 'VAE'):
                ImageRuntime()('a', body, lambda *args: False)
