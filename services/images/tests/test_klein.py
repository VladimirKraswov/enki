import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import numpy as np
import openvino as ov
from openvino import opset13 as ops

from klein import (_bn_config, _digest, _id_model, _text_model, _verify_files,
                   create_pipeline, prepare, prepared_directory, POINTER)


def text_model():
    parameter = ops.parameter([1, 2, 2560], np.float32, name='test_tokens')
    states = []
    for layer in (9, 18, 27):
        node = ops.add(parameter, ops.constant(float(layer), np.float32))
        node.set_friendly_name('__module.model.layers.' + str(layer - 1) + '/aten::add/Add_1')
        states.append(ops.unsqueeze(node, ops.constant(np.array([1], dtype=np.int64))))
    stacked = ops.concat(states, 1)
    transposed = ops.transpose(stacked, ops.constant(np.array([0, 2, 1, 3], dtype=np.int64)))
    output = ops.reshape(transposed, ops.constant(np.array([1, 2, 7680], dtype=np.int64)), False)
    output.output(0).set_names({'prompt_embeds'})
    return ov.Model([output], [parameter])


def id_model():
    image = ops.parameter([-1, 4], np.float32, name='img_ids')
    text = ops.parameter([-1, 4], np.float32, name='txt_ids')
    image.output(0).set_names({'img_ids'})
    text.output(0).set_names({'txt_ids'})
    return ov.Model([ops.concat([image, text], 0)], [image, text])


def fixture(root):
    source = root / 'source'
    for part in ('text_encoder', 'transformer', 'vae_decoder'):
        (source / part).mkdir(parents=True)
    ov.serialize(text_model(), source / 'text_encoder/openvino_model.xml', source / 'text_encoder/openvino_model.bin')
    ov.serialize(id_model(), source / 'transformer/openvino_model.xml', source / 'transformer/openvino_model.bin')
    (source / 'model_index.json').write_text('{"_class_name":"Flux2KleinPipeline"}')
    (source / 'vae_decoder/config.json').write_text(json.dumps({'latent_channels': 32, 'patch_size': [2, 2], 'batch_norm_eps': 1e-4}))
    np.savez(source / 'vae_bn_stats.npz', running_mean=np.linspace(-0.1, 0.1, 128, dtype=np.float32),
             running_var=np.linspace(2, 3, 128, dtype=np.float32))
    manifest = {str(file.relative_to(source)): {'bytes': file.stat().st_size, 'sha256': _digest(file)}
                for file in source.rglob('*') if file.is_file()}
    return source, root / 'prepared', manifest


class KleinAdapter(unittest.TestCase):
    def test_text_outputs_reproduce_the_original_concatenated_embedding_exactly(self):
        original = text_model()
        adapted, bindings = _text_model(original.clone())
        inputs = np.arange(5120, dtype=np.float32).reshape(1, 2, 2560) / 16
        core = ov.Core()
        before = next(iter(core.compile_model(original, 'CPU')([inputs]).values()))
        compiled = core.compile_model(adapted, 'CPU')
        results = compiled([inputs])
        after = np.concatenate([results[compiled.output('hidden_states.' + str(layer))] for layer in (9, 18, 27)], axis=2)
        np.testing.assert_array_equal(after, before)
        self.assertEqual([item['output'] for item in bindings], ['hidden_states.9', 'hidden_states.18', 'hidden_states.27'])

    def test_id_adapter_changes_only_the_single_batch_shape(self):
        original = id_model()
        adapted = _id_model(original.clone())
        a, b = np.arange(8, dtype=np.float32).reshape(2, 4), np.arange(12, dtype=np.float32).reshape(3, 4)
        core = ov.Core()
        before = next(iter(core.compile_model(original, 'CPU')({'img_ids': a, 'txt_ids': b}).values()))
        compiled = core.compile_model(adapted, 'CPU')
        after = next(iter(compiled({'img_ids': a[None], 'txt_ids': b[None]}).values()))
        np.testing.assert_array_equal(after, before)
        with self.assertRaises(RuntimeError):
            compiled({'img_ids': np.stack([a, a]), 'txt_ids': np.stack([b, b])})

    def test_provisioning_is_idempotent_preserves_raw_source_and_publishes_complete_versions(self):
        with TemporaryDirectory() as directory:
            source, target, manifest = fixture(Path(directory))
            prepare(source, target, _manifest=manifest)
            marker = (target / POINTER).read_bytes()
            first = prepared_directory(target, _manifest=manifest)
            _verify_files(source, manifest)
            prepare(source, target, _manifest=manifest)
            self.assertEqual((target / POINTER).read_bytes(), marker)
            self.assertEqual(prepared_directory(target, _manifest=manifest), first)
            self.assertEqual(len(list(target.glob('v-*'))), 1)
            config = json.loads((first / 'vae_decoder/config.json').read_text())
            self.assertEqual(len(config['bn_running_mean_data']), 128)
            (first / 'model_index.json').write_text('corrupt')
            with self.assertRaisesRegex(ValueError, 'не совпадает'):
                prepared_directory(target, _manifest=manifest)
            prepare(source, target, _manifest=manifest)
            self.assertNotEqual(prepared_directory(target, _manifest=manifest), first)
            self.assertTrue(first.exists())
            _verify_files(source, manifest)

    def test_failed_preparation_keeps_the_previous_pointer_and_rejects_changed_raw_bytes(self):
        with TemporaryDirectory() as directory:
            source, target, manifest = fixture(Path(directory))
            prepare(source, target, _manifest=manifest)
            marker = (target / POINTER).read_bytes()
            with patch('klein.prepared_directory', side_effect=ValueError('force refresh')), patch('klein._id_model', side_effect=ValueError('unsupported graph')):
                with self.assertRaisesRegex(ValueError, 'unsupported graph'):
                    prepare(source, target, _manifest=manifest)
            self.assertEqual((target / POINTER).read_bytes(), marker)
            self.assertFalse(list(target.glob('.preparing-*')))
            (source / 'model_index.json').write_text('changed original')
            with self.assertRaisesRegex(ValueError, 'не совпадает'):
                prepare(source, target, _manifest=manifest)
            self.assertEqual((target / POINTER).read_bytes(), marker)

    def test_bn_rejects_nonfinite_wrong_shape_and_pickled_arrays(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'vae_decoder').mkdir()
            (root / 'vae_decoder/config.json').write_text('{"latent_channels":32,"patch_size":[2,2]}')
            for mean, variance in [(np.full(128, np.nan, np.float32), np.ones(128, np.float32)),
                                   (np.zeros(127, np.float32), np.ones(128, np.float32)),
                                   (np.zeros(128, np.float32), np.zeros(128, np.float32)),
                                   (np.array([{}], dtype=object), np.ones(128, np.float32))]:
                np.savez(root / 'vae_bn_stats.npz', running_mean=mean, running_var=variance)
                with self.assertRaises(ValueError):
                    _bn_config(root, root)

    def test_links_are_not_accepted_as_model_input_or_prepared_source(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source, target, manifest = fixture(root)
            actual = source / 'model_index.json'
            original = source / 'original.json'
            actual.rename(original)
            actual.symlink_to(original)
            with self.assertRaisesRegex(ValueError, 'ссылк'):
                prepare(source, target, _manifest=manifest)
            target.symlink_to(source, target_is_directory=True)
            with self.assertRaises(ValueError):
                prepared_directory(target, _manifest=manifest)

    def test_private_provisioning_umask_still_allows_service_to_read_published_models(self):
        with TemporaryDirectory() as directory:
            source, target, manifest = fixture(Path(directory))
            previous = os.umask(0o077)
            try:
                prepare(source, target, _manifest=manifest)
            finally:
                os.umask(previous)
            prepared = prepared_directory(target, _manifest=manifest)
            self.assertEqual(target.stat().st_mode & 0o777, 0o755)
            self.assertEqual((target / POINTER).stat().st_mode & 0o777, 0o644)
            for file in prepared.rglob('*'):
                if file.is_file():
                    self.assertEqual(file.stat().st_mode & 0o777, 0o644)

    def test_factory_resolves_and_verifies_one_version_before_constructing_the_cpu_pipeline(self):
        with TemporaryDirectory() as directory:
            source, target, manifest = fixture(Path(directory))
            prepare(source, target, _manifest=manifest)
            resolved = prepared_directory(target, _manifest=manifest)
            cache = Path(directory) / 'cache'
            with patch('klein.SOURCE_FILES', manifest), patch('openvino_genai.Image2ImagePipeline') as constructor:
                self.assertIs(create_pipeline(target, 12, cache), constructor.return_value)
                constructor.assert_called_once_with(resolved, 'CPU', INFERENCE_NUM_THREADS=12,
                                                    NUM_STREAMS=1, INFERENCE_PRECISION_HINT='f32', CACHE_DIR=str(cache))
            with patch('klein._genai_version', return_value='unqualified-future-version'):
                with self.assertRaisesRegex(ValueError, 'проверен'):
                    prepared_directory(target, _manifest=manifest)
