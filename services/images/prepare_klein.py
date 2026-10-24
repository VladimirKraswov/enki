"""Provision only the pinned CPU instruction editor; no downloaded Python runs."""
import os
from pathlib import Path

from klein import MODEL_ID, REPOSITORY, REVISION, SOURCE_FILES, prepare


def main():
    from huggingface_hub import snapshot_download
    root = Path(os.environ.get('IMAGE_MODELS_DIR', '/opt/enki-images/models'))
    source = root / '.sources' / (MODEL_ID + '-' + REVISION)
    if source.is_symlink():
        raise ValueError('Каталог исходной модели Klein не должен быть ссылкой')
    snapshot_download(REPOSITORY, revision=REVISION, local_dir=source,
                      allow_patterns=list(SOURCE_FILES), max_workers=2)
    result = prepare(source, root / MODEL_ID)
    print('Подготовлен проверенный CPU-редактор ' + str(result))


if __name__ == '__main__':
    main()
