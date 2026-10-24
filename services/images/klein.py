"""Pinned FLUX.2 Klein IR compatibility for OpenVINO GenAI on the CPU server.

The source export targets Optimum Intel. GenAI needs the same BN statistics in
JSON, separate text hidden-state outputs and batched position-ID inputs. These
adapters expose existing tensors; they do not train or change any weight values.
"""
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import time
import uuid

MODEL_ID = 'flux-klein-4b'
REPOSITORY = 'xgirls/FLUX.2-klein-4B-ov-int4'
REVISION = 'f53967e707ab0a1ab795c5d0704b8c4f0e2f22c3'
QUALIFIED_GENAI = '2026.4.1.0-3408-ab01d1771e4'
SOURCE_FILES = {'model_index.json': {'bytes': 514,
                      'sha256': 'f4da10ee28551540dbae03f47f83c7228b5641fe2a8ce73f6dea8163ba765825'},
 'openvino_config.json': {'bytes': 3107,
                          'sha256': '2fcc46d33c9aa0835cc7e45b7a718008f8c82cb2754a11a92696fe5a67b4ce87'},
 'scheduler/scheduler_config.json': {'bytes': 499,
                                     'sha256': 'df91e7c4d68db2395495ca5fb94296ef97585335733328e99f910970b2202cde'},
 'text_encoder/config.json': {'bytes': 1604,
                              'sha256': '6b32eb79f01a48671adc435cb9af795c8338526d4b7f70e0eb7b855068fe55d1'},
 'text_encoder/openvino_model.bin': {'bytes': 2078393653,
                                     'sha256': '2ce6b2c962483ccce3c782ba94e0543de380c91e1f6b9787b775a32f76d24fa6'},
 'text_encoder/openvino_model.xml': {'bytes': 2563477,
                                     'sha256': '780331423395cb79d27b8dc9d1bc462343ce641569e06fa549e3415628589dd5'},
 'tokenizer/added_tokens.json': {'bytes': 735,
                                 'sha256': '79f6ec6fcc423d3a82bfac8b9033b1daac7b7bce06a5f5f441637b480cc605de'},
 'tokenizer/chat_template.jinja': {'bytes': 4256,
                                   'sha256': '51fa65c79bb57f058dc7ef8734884bd325fe9d45bb03a61bfef59785d3bc2da9'},
 'tokenizer/merges.txt': {'bytes': 1671853,
                          'sha256': '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5'},
 'tokenizer/openvino_detokenizer.bin': {'bytes': 2189717,
                                        'sha256': 'd73093f72c80ebcaffb76a192727170ecd3c6a06c4df52df0e76b3f70ad9d7f7'},
 'tokenizer/openvino_detokenizer.xml': {'bytes': 11789,
                                        'sha256': 'ae0aa02b97adb710df9d429303ba30aa3801571214a061526282ad415f43552b'},
 'tokenizer/openvino_tokenizer.bin': {'bytes': 5588836,
                                      'sha256': '563c00e8a3a260601f9200179a23bb9aa6a184fc1dbe0ed0ec5320e26a888849'},
 'tokenizer/openvino_tokenizer.xml': {'bytes': 29333,
                                      'sha256': '47a60defc0766c707a68b1831059dd2962ffb706f42497c8b023e85b252933a8'},
 'tokenizer/special_tokens_map.json': {'bytes': 644,
                                       'sha256': '57255613bbe23c9497211ca68561ff429a51e871dbaf5a59998fa4c8f7fe168a'},
 'tokenizer/tokenizer.json': {'bytes': 11422654,
                              'sha256': 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4'},
 'tokenizer/tokenizer_config.json': {'bytes': 5643,
                                     'sha256': 'b2a0d89cf5c89d5d844c56d82e9c3731f862d720a6ce221c31955b628960cde7'},
 'tokenizer/vocab.json': {'bytes': 2776833,
                          'sha256': 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'},
 'transformer/config.json': {'bytes': 655,
                             'sha256': '49340106aab93662e515614d96d0f65e5b1af256055cbabd3197f0bfbe9905ee'},
 'transformer/openvino_model.bin': {'bytes': 2388775216,
                                    'sha256': 'f9afbf90475be192434503d828bef8bfe1084db3b6862357c1f9062caf4a2e4f'},
 'transformer/openvino_model.xml': {'bytes': 2221293,
                                    'sha256': '478e21c2f9e2481b4f3fef33e2f65d8beccf1c89a7306051ed208a030c05c209'},
 'vae_bn_stats.npz': {'bytes': 2120,
                      'sha256': '40909bc5baedb859e80b567e343b2eff8e842906199327f5d8f0a1d57ce8ede4'},
 'vae_decoder/config.json': {'bytes': 1005,
                             'sha256': 'c5b6373d2c4a9279f97fffe84f0f62db8b473b6d90fe64f849d2d8a5f7bb7b55'},
 'vae_decoder/openvino_model.bin': {'bytes': 49773985,
                                    'sha256': '8a105159e5672d05e14830db886dcfe5eec890b4f902e773c160e624633c265b'},
 'vae_decoder/openvino_model.xml': {'bytes': 338292,
                                    'sha256': '555ed8a251bacb4ced24ab01758447d1089f4e74665c48765ac3643b2f6a7319'},
 'vae_encoder/config.json': {'bytes': 1005,
                             'sha256': 'c5b6373d2c4a9279f97fffe84f0f62db8b473b6d90fe64f849d2d8a5f7bb7b55'},
 'vae_encoder/openvino_model.bin': {'bytes': 34541724,
                                    'sha256': 'ad938ba33f60e2d0871a01c8e06979ef744d1ddfe8124f2a11744e768b557036'},
 'vae_encoder/openvino_model.xml': {'bytes': 265028,
                                    'sha256': '8ac027ab66af70bb421be1c552d55289cecc8e7d4111759b4a4e0b6391cfdc0f'}}
POINTER = 'enki-klein.json'
MAX_MARKER = 65536


def _digest(file):
    value = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1048576), b''):
            value.update(chunk)
    return value.hexdigest()


def _regular(root, relative):
    current = Path(root)
    if current.is_symlink() or not current.is_dir():
        raise ValueError('Папка модели Klein недоступна или является ссылкой')
    for part in Path(relative).parts:
        if part in ('', '.', '..') or Path(relative).is_absolute():
            raise ValueError('Некорректный путь модели Klein')
        current = current / part
        if current.is_symlink():
            raise ValueError('Файлы модели Klein не должны быть ссылками')
    if not current.is_file():
        raise ValueError('Не найден обязательный файл модели Klein: ' + relative)
    return current


def _json(file):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_MARKER:
        raise ValueError('Метаданные модели Klein недоступны')
    return json.loads(file.read_text())


def _verify_files(root, files):
    if not isinstance(files, dict) or not files:
        raise ValueError('Нет проверенного списка файлов Klein')
    for relative, expected in files.items():
        file = _regular(root, relative)
        if file.stat().st_size != expected['bytes'] or _digest(file) != expected['sha256']:
            raise ValueError('Файл модели Klein не совпадает с проверенной версией: ' + relative)


def _identity(version):
    if version != QUALIFIED_GENAI:
        raise ValueError('Этот адаптер Klein проверен для OpenVINO GenAI ' + QUALIFIED_GENAI)
    return {'model_id': MODEL_ID, 'repo': REPOSITORY, 'revision': REVISION,
            'genai_version': version, 'adapter_sha256': _digest(__file__)}


def _genai_version():
    return importlib.import_module('openvino_genai').__version__


def _bn_config(source, target):
    import numpy as np
    with np.load(source / 'vae_bn_stats.npz', allow_pickle=False) as arrays:
        mean, variance = arrays['running_mean'], arrays['running_var']
        if (mean.shape != (128,) or variance.shape != (128,)
                or mean.dtype != np.float32 or variance.dtype != np.float32
                or not np.all(np.isfinite(mean)) or not np.all(np.isfinite(variance))
                or not np.all(variance > 0)):
            raise ValueError('Некорректные статистики нормализации Klein')
        config = _json(source / 'vae_decoder/config.json')
        if config.get('latent_channels') != 32 or config.get('patch_size') != [2, 2]:
            raise ValueError('Неподдерживаемый VAE Klein')
        config.update(bn_running_mean_data=mean.tolist(), bn_running_var_data=variance.tolist())
    (target / 'vae_decoder/config.json').write_text(json.dumps(config, indent=2))


def _text_model(model):
    import openvino as ov
    outputs, bindings = [], []
    if len(model.outputs) != 1 or model.output(0).get_partial_shape()[-1].get_length() != 7680:
        raise ValueError('Неожиданный объединённый выход текстового энкодера Klein')
    for layer in (9, 18, 27):
        name = '__module.model.layers.' + str(layer - 1) + '/aten::add/Add_1'
        nodes = [node for node in model.get_ordered_ops() if node.get_friendly_name() == name]
        if len(nodes) != 1:
            raise ValueError('Не найден проверенный hidden state Klein: ' + name)
        output = nodes[0].output(0)
        shape = output.get_partial_shape()
        if shape.rank.get_length() != 3 or shape[2].get_length() != 2560 or output.get_element_type() != ov.Type.f32:
            raise ValueError('Неподдерживаемая форма hidden state Klein')
        output.set_names({'hidden_states.' + str(layer)})
        outputs.append(output)
        bindings.append({'output': 'hidden_states.' + str(layer), 'original_node': name})
    return ov.Model(outputs, model.get_parameters(), 'EnkiFluxKleinTextEncoder'), bindings


def _id_model(model):
    import numpy as np
    import openvino as ov
    from openvino import opset13 as ops
    parameters, changed = list(model.get_parameters()), []
    for index, original in enumerate(parameters):
        name = original.get_friendly_name()
        if name not in ('img_ids', 'txt_ids'):
            continue
        shape = original.get_partial_shape()
        if shape.rank.get_length() != 2 or shape[1].get_length() != 4 or original.get_element_type() != ov.Type.f32:
            raise ValueError('Неожиданный вход координат Klein: ' + name)
        parameter = ops.parameter([1, -1, 4], dtype=ov.Type.f32, name=name)
        parameter.output(0).set_names(original.output(0).get_names())
        squeezed = ops.squeeze(parameter, ops.constant(np.array([0], dtype=np.int64)))
        original.output(0).replace(squeezed.output(0))
        parameters[index] = parameter
        changed.append(name)
    if changed != ['img_ids', 'txt_ids']:
        raise ValueError('Нужны оба проверенных входа координат Klein')
    return ov.Model(model.get_results(), parameters, 'EnkiFluxKleinTransformerBatchOne')


def _sync_tree(root):
    # Public model assets must stay readable by the dedicated image service,
    # even when the root provisioning process has a private umask.
    for file in root.rglob('*'):
        if file.is_file():
            file.chmod(0o644)
            descriptor = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    directories = sorted([root, *(p for p in root.rglob('*') if p.is_dir())], key=lambda p: len(p.parts), reverse=True)
    for directory in directories:
        directory.chmod(0o755)
        descriptor = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def prepared_directory(destination, verify=True, *, _manifest=None):
    """Resolve one immutable version before any model files are opened."""
    destination = Path(destination)
    marker = _json(_regular(destination, POINTER))
    if marker.get('identity') != _identity(_genai_version()):
        raise ValueError('Модель Klein требует подготовки для текущего адаптера и GenAI')
    manifest = SOURCE_FILES if _manifest is None else _manifest
    if marker.get('source_files') != manifest or set(marker.get('files', {})) != set(manifest):
        raise ValueError('Происхождение подготовленной модели Klein не подтверждено')
    folder = marker.get('prepared_directory')
    if not isinstance(folder, str) or not folder.startswith('v-') or Path(folder).name != folder:
        raise ValueError('Некорректная подготовленная версия Klein')
    prepared = destination / folder
    if prepared.is_symlink() or not prepared.is_dir():
        raise ValueError('Подготовленная версия Klein недоступна')
    if verify:
        _verify_files(prepared, marker['files'])
    return prepared


def prepare(source, destination, *, _manifest=None):
    """Verify the immutable source; publish a complete version with one rename.

    Old versions remain intact for readers that already resolved their path.
    The private manifest argument lets tests use tiny graphs, never CLI input.
    """
    import fcntl
    import openvino as ov
    source, destination = Path(source), Path(destination)
    manifest = SOURCE_FILES if _manifest is None else _manifest
    _verify_files(source, manifest)
    identity = _identity(_genai_version())
    if destination.is_symlink():
        raise ValueError('Каталог Klein не должен быть ссылкой')
    destination.mkdir(parents=True, exist_ok=True)
    destination.chmod(0o755)
    lock_path = destination / '.prepare.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Подготовка модели Klein уже выполняется')
                time.sleep(0.05)
        try:
            prepared_directory(destination, _manifest=manifest)
            existing = _json(destination / POINTER)
            if existing.get('source_files') == manifest:
                return destination
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            pass
        suffix = uuid.uuid4().hex
        staging = destination / ('.preparing-' + suffix)
        version = 'v-' + identity['adapter_sha256'][:12] + '-' + suffix
        staging.mkdir()
        try:
            replaced = {part + '/openvino_model.' + extension for part in ('text_encoder', 'transformer') for extension in ('xml', 'bin')}
            for relative in manifest:
                if relative in replaced:
                    continue
                output = staging / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(_regular(source, relative), output)
            for part in ('text_encoder', 'transformer'):
                (staging / part).mkdir(exist_ok=True)
            _bn_config(source, staging)
            model, bindings = _text_model(ov.Core().read_model(source / 'text_encoder/openvino_model.xml'))
            ov.serialize(model, staging / 'text_encoder/openvino_model.xml', staging / 'text_encoder/openvino_model.bin')
            del model
            model = _id_model(ov.Core().read_model(source / 'transformer/openvino_model.xml'))
            ov.serialize(model, staging / 'transformer/openvino_model.xml', staging / 'transformer/openvino_model.bin')
            del model
            files = {relative: {'bytes': (staging / relative).stat().st_size, 'sha256': _digest(staging / relative)} for relative in manifest}
            marker = {'identity': identity, 'source_files': manifest, 'prepared_directory': version, 'files': files,
                      'adaptation': {'hidden_states': bindings, 'ids': 'batch-one squeeze: [1,S,4] to [S,4]',
                                     'bn': 'original NPZ running_mean/running_var; no numerical changes',
                                     'weights': 'original tensors; outputs/input shapes adapted without retraining'}}
            (staging / 'enki-model.json').write_text(json.dumps(marker, indent=2))
            _sync_tree(staging)
            staging.rename(destination / version)
            temporary = destination / ('.pointer-' + suffix)
            try:
                with temporary.open('x') as output:
                    os.fchmod(output.fileno(), 0o644)
                    json.dump(marker, output, indent=2)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(destination / POINTER)
                parent = os.open(destination, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
            finally:
                temporary.unlink(missing_ok=True)
            return destination
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    finally:
        os.close(descriptor)


def create_pipeline(source, threads, cache_dir):
    genai = importlib.import_module('openvino_genai')
    prepared = prepared_directory(source)
    return genai.Image2ImagePipeline(prepared, 'CPU', INFERENCE_NUM_THREADS=threads,
                                    NUM_STREAMS=1, INFERENCE_PRECISION_HINT='f32', CACHE_DIR=str(cache_dir))
