import gc
import os
from pathlib import Path
import threading
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import weakref

from runtime import ImageRuntime, PROFILES


class ResidentRuntime(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.loads = []
        self.fail = None
        self.constructed = None
        self.release = None
        owner = self

        class Pipeline:
            def __init__(self, source, device, **options):
                self.source = Path(source)
                self.device = device
                owner.loads.append(self)
                if owner.constructed:
                    owner.constructed.set()
                if owner.release and not owner.release.wait(2):
                    raise RuntimeError('test constructor not released')
                if owner.fail:
                    raise owner.fail

            def generate(self, *args, **kwargs):
                raise AssertionError('Preload must compile without dummy image generation')

        self.pipeline_class = Pipeline
        self.modules = {
            'openvino_genai': SimpleNamespace(Text2ImagePipeline=Pipeline, Image2ImagePipeline=Pipeline),
            'periodic': SimpleNamespace(prepare_periodic=lambda source, destination: destination),
            'klein': SimpleNamespace(create_pipeline=lambda source,threads,cache_dir: Pipeline(source,'CPU',INFERENCE_NUM_THREADS=threads,CACHE_DIR=str(cache_dir))),
        }
        for model in ('sdxl-lightning', 'flux-klein-4b'):
            encoder = self.root / model / 'vae_encoder'
            encoder.mkdir(parents=True)
            for name in ('config.json', 'openvino_model.xml', 'openvino_model.bin'):
                (encoder / name).write_text('test-owned fake encoder')
        self.env = patch.dict(os.environ, {
            'IMAGE_MODELS_DIR': self.directory.name, 'IMAGE_MODEL_DIR': str(self.root / 'draft'),
            'IMAGE_CACHE_DIR': str(self.root / 'cache'),
        })
        self.env.start(); self.addCleanup(self.env.stop)
        self.fake = patch.dict('sys.modules', self.modules)
        self.fake.start(); self.addCleanup(self.fake.stop)

    def with_klein(self):
        return patch.dict(PROFILES, {'flux-klein-4b': {
            'folder': 'flux-klein-4b', 'steps': 4, 'guidance': 1.0, 'title': 'Qualified Klein fixture',
        }})

    def test_preload_compiles_only_registered_primary_without_generating(self):
        with patch.dict(PROFILES, {key: value for key, value in PROFILES.items() if key != 'flux-klein-4b'}, clear=True):
            runtime = ImageRuntime()
            self.assertFalse(runtime.resident_status()['ready'])
            status = runtime.preload()
            self.assertTrue(status['ready'])
            self.assertEqual([entry['model'] for entry in status['primary']], ['sdxl-lightning'])
            self.assertEqual(len(self.loads), 1)
            self.assertEqual(self.loads[0].device, 'CPU')
            runtime.preload()
            self.assertEqual(len(self.loads), 1)

    def test_two_primary_models_remain_loaded_and_reuse_instances_after_switching(self):
        with self.with_klein():
            runtime = ImageRuntime()
            status = runtime.preload()
            self.assertTrue(status['ready']); self.assertEqual(len(self.loads), 2)
            sdxl = runtime._getpipeline('sdxl-lightning', False, False)
            klein = runtime._getpipeline('flux-klein-4b', False, True)
            self.assertIs(runtime._getpipeline('sdxl-lightning', False, False), sdxl)
            self.assertIs(runtime._getpipeline('flux-klein-4b', False, True), klein)
            self.assertIsNot(sdxl, klein); self.assertEqual(len(self.loads), 2)
            self.assertTrue(all(entry['loaded'] for entry in runtime.resident_status()['primary']))

    def test_optional_variants_are_bounded_and_never_evict_primary_models(self):
        with self.with_klein():
            runtime = ImageRuntime(); runtime.preload()
            sdxl = runtime._getpipeline('sdxl-lightning', False, False)
            klein = runtime._getpipeline('flux-klein-4b', False, True)
            for model, tileable, editing in [
                ('sdxl-lightning', True, False), ('sdxl-lightning', False, True),
                ('lcm-dreamshaper-v7', False, False), ('sdxl-lightning', True, False),
            ]:
                optional = runtime._getpipeline(model, tileable, editing)
                self.assertIs(runtime._getpipeline(model, tileable, editing), optional)
                self.assertEqual(len(runtime.resident_status()['optional']), 1)
                self.assertIs(runtime._getpipeline('sdxl-lightning', False, False), sdxl)
                self.assertIs(runtime._getpipeline('flux-klein-4b', False, True), klein)
            self.assertEqual(len(self.loads), 6)
            self.assertTrue(runtime.resident_status()['ready'])

    def test_evicted_optional_pipeline_is_released_before_next_constructor(self):
        runtime = ImageRuntime(); runtime.preload()
        optional = runtime._getpipeline('sdxl-lightning', True, False)
        retired = weakref.ref(optional)
        self.loads.remove(optional); del optional
        runtime._getpipeline('lcm-dreamshaper-v7', False, False)
        gc.collect()
        self.assertIsNone(retired())
        self.assertTrue(runtime.resident_status()['primary'][0]['loaded'])

    def test_failed_second_primary_does_not_evict_first_or_claim_readiness(self):
        with self.with_klein():
            runtime = ImageRuntime()
            sdxl = runtime._getpipeline('sdxl-lightning', False, False)
            self.fail = RuntimeError('qualified profile compilation failed')
            with self.assertRaisesRegex(RuntimeError, 'compilation failed'):
                runtime.preload()
            status = runtime.resident_status()
            self.assertFalse(status['ready'])
            self.assertEqual([entry['loaded'] for entry in status['primary']], [True, False])
            self.assertEqual(status['failed']['model'], 'flux-klein-4b')
            self.assertIsNone(status['loading'])
            self.assertIs(runtime._getpipeline('sdxl-lightning', False, False), sdxl)

    def test_resident_status_remains_available_while_preload_compiles(self):
        runtime = ImageRuntime()
        self.constructed, self.release = threading.Event(), threading.Event()
        worker = threading.Thread(target=runtime.preload, daemon=True)
        worker.start()
        try:
            self.assertTrue(self.constructed.wait(1))
            result, read = [], threading.Event()
            def inspect():
                result.append(runtime.resident_status()); read.set()
            threading.Thread(target=inspect, daemon=True).start()
            self.assertTrue(read.wait(.5), 'Compilation must not block health/status')
            self.assertEqual(result[0]['loading']['model'], 'sdxl-lightning')
            self.assertFalse(result[0]['ready'])
        finally:
            self.release.set(); worker.join(2)
        self.assertFalse(worker.is_alive()); self.assertTrue(runtime.resident_status()['ready'])


if __name__ == '__main__':
    unittest.main()
