"""Shared model catalog: the single source of truth for common models of all instances.

An admin publishes the whole catalog; every device reads it and merges it into local
engine configuration (opencode provider block, pi models.json providers). The Hub
never probes endpoints and never executes anything here. Per-device choices
(selection, exclusions, extra local providers) stay on the device.
"""

import importlib.util
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

# Loaded by file location like every Hub module (see releases.py).
_durable_spec = importlib.util.spec_from_file_location("enki_hub_durable", Path(__file__).with_name("durable.py"))
durable = importlib.util.module_from_spec(_durable_spec)
_durable_spec.loader.exec_module(durable)

MAX_CATALOG = 256 * 1024
MAX_MODEL_JSON = 24 * 1024
MODEL_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
PROVIDER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
PLAIN_TOKEN = re.compile(r"\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{8,}")


class ModelCatalog:
    def __init__(self, root, lock, fault):
        self.path, self.lock, self.fault = root / "model-catalog.json", lock, fault

    def error(self, message, status=400):
        raise self.fault(status, message)

    def get(self):
        with self.lock:
            if not self.path.exists():
                return {
                    "version": 0,
                    "models": [],
                    "note": "Каталог общих моделей ещё не опубликован.",
                }
            if self.path.is_symlink():
                self.error("Небезопасный путь каталога моделей.", 500)
            if self.path.stat().st_size > MAX_CATALOG:
                self.error("Каталог моделей слишком велик.", 413)
            return json.loads(self.path.read_bytes())

    def check_url(self, value, field):
        if not isinstance(value, str):
            self.error(f"{field} должен быть http(s)-адресом.")
        try:
            url = urlsplit(value)
        except ValueError:
            return self.error(f"Некорректный {field}.")
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or len(value) > 400
        ):
            self.error(
                f"{field} должен быть http(s)-адресом без учётных данных и query."
            )
        try:
            if url.port is not None and not 0 < url.port < 65536:
                self.error(f"Некорректный порт в {field}.")
        except ValueError:
            self.error(f"Некорректный порт в {field}.")

    def check_text(self, value, field, limit):
        if (
            not isinstance(value, str)
            or not value
            or len(value) > limit
            or any(ord(c) < 32 for c in value)
        ):
            self.error(f"{field} должен быть текстом до {limit} символов.")

    def check_credentials(self, value, allow_env=False):
        # Pattern matching known token prefixes misses arbitrary passwords/API
        # keys. Shared configuration carries references, never inline secrets.
        if isinstance(value, dict):
            for key, item in value.items():
                if key.lower().replace("-", "").replace("_", "") in {
                    "apikey", "xapikey", "authorization", "proxyauthorization", "cookie", "password", "token", "secret"
                }:
                    reference = isinstance(item, str) and (
                        re.fullmatch(r"\{(?:env|file):[^{}\r\n]+\}", item)
                        or (allow_env and re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", item))
                    )
                    placeholder = item in ("local", "none", "dummy", "unused", "not-needed", "not-used") if isinstance(item, str) else False
                    if not reference and not placeholder:
                        self.error("Секреты храните на устройстве; в каталоге используйте ссылку на переменную окружения.")
                self.check_credentials(item, allow_env)
        elif isinstance(value, list):
            for item in value:
                self.check_credentials(item, allow_env)

    def engine(self, entry, name):
        value = entry.get(name)
        if value is None:
            return None
        if not isinstance(value, dict):
            self.error(f"Блок {name} должен быть объектом.")
        extra = set(value) - (
            {"providerId", "name", "provider"}
            if name == "opencode"
            else {"providerId", "provider"}
        )
        if extra:
            self.error(f"Неизвестные поля в блоке {name}: {sorted(extra)[0]}.")
        provider_id = value.get("providerId")
        if not isinstance(provider_id, str) or not PROVIDER_ID.fullmatch(provider_id):
            self.error(f"Некорректный providerId в блоке {name}.")
        if "name" in value:
            self.check_text(value["name"], f"{name}.name", 80)
        provider = value.get("provider")
        if not isinstance(provider, dict) or not provider:
            self.error(f"В блоке {name} нет объекта provider.")
        self.check_credentials(provider, allow_env=name == "pi")
        raw = json.dumps(value, ensure_ascii=False)
        if len(raw.encode()) > MAX_MODEL_JSON:
            self.error(f"Блок {name} слишком велик.")
        if PLAIN_TOKEN.search(raw):
            self.error(
                f"В блоке {name} похожий на ключ секрет; храните ключи вне каталога."
            )
        if name == "opencode":
            options = provider.get("options")
            if not isinstance(options, dict) or "baseURL" not in options:
                self.error("В opencode provider нет options.baseURL.")
            self.check_url(options["baseURL"], f"{name}.provider.options.baseURL")
            models = provider.get("models")
            if not isinstance(models, dict) or not models:
                self.error("В opencode provider нет карты models.")
        else:
            if "baseUrl" not in provider:
                self.error("В pi provider нет поля baseUrl.")
            self.check_url(provider["baseUrl"], f"{name}.provider.baseUrl")
            models = provider.get("models")
            if (
                not isinstance(models, list)
                or not models
                or not all(
                    isinstance(model, dict)
                    and isinstance(model.get("id"), str)
                    and model["id"]
                    for model in models
                )
            ):
                self.error("В pi provider models должен быть списком объектов с id.")
            if "headers" in provider:
                headers = provider["headers"]
                if (
                    not isinstance(headers, dict)
                    or len(headers) > 8
                    or any(
                        not isinstance(k, str)
                        or not isinstance(v, str)
                        or len(k) > 40
                        or len(v) > 200
                        or k.lower() in ("authorization", "cookie", "x-api-key")
                        for k, v in headers.items()
                    )
                ):
                    self.error("Некорректные заголовки в pi provider.")
        return value

    def validate(self, data):
        if not isinstance(data, dict) or not isinstance(data.get("models"), list):
            self.error("Нужен объект с полем models (список).")
        models = data["models"]
        if len(models) > 64:
            self.error("Слишком много моделей в каталоге.")
        seen = set()
        providers = {"opencode": set(), "pi": set()}
        result = []
        for entry in models:
            if not isinstance(entry, dict):
                self.error("Каждая модель должна быть объектом.")
            extra = set(entry) - {"id", "label", "note", "opencode", "pi", "control"}
            if extra:
                self.error(f"Неизвестные поля модели: {sorted(extra)[0]}.")
            model_id = entry.get("id")
            if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id):
                self.error("Некорректный id модели (строчные латинские, цифры, ._-).")
            if model_id in seen:
                self.error(f"Повторяется id модели {model_id}.")
            seen.add(model_id)
            self.check_text(entry.get("label"), "label модели " + model_id, 120)
            if "note" in entry:
                self.check_text(entry["note"], "note модели " + model_id, 400)
            engines = {name: self.engine(entry, name) for name in ("opencode", "pi")}
            for name, engine in engines.items():
                if engine:
                    pid = engine["providerId"]
                    if pid in providers[name]:
                        self.error(f"Повторяется providerId {pid} в {name}.")
                    providers[name].add(pid)
            if not any(engines.values()):
                self.error(f"Модель {model_id} не настроена ни для одного движка.")
            control = entry.get("control")
            if control is not None:
                if (not isinstance(control, dict) or set(control) != {"service", "bindings"} or
                    not isinstance(control["service"], str) or not MODEL_ID.fullmatch(control["service"]) or
                    not isinstance(control["bindings"], dict) or not 1 <= len(control["bindings"]) <= 32):
                    self.error("Нужны service и bindings для управления моделью через Hub.")
                for source, target in control["bindings"].items():
                    if (not isinstance(source, str) or not isinstance(target, str) or
                        not MODEL_ID.fullmatch(source) or not MODEL_ID.fullmatch(target)):
                        self.error("Некорректная привязка модели к сервису Hub.")
                for engine in filter(None, engines.values()):
                    configured = engine["provider"]["models"]
                    ids = set(configured) if isinstance(configured, dict) else {m["id"] for m in configured}
                    if not ids <= set(control["bindings"]):
                        self.error("Каждая модель провайдера должна иметь явную привязку к сервису Hub.")
            result.append(
                {
                    "id": model_id,
                    "label": entry["label"],
                    **({"control": control} if control is not None else {}),
                    **({"note": entry["note"]} if "note" in entry else {}),
                    **{k: v for k, v in engines.items() if v},
                }
            )
        if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_CATALOG:
            self.error("Каталог моделей слишком велик.", 413)
        return result

    def put(self, data, actor):
        models = self.validate(data)
        with self.lock:
            current = self.get()
            requested = {entry["id"]: entry for entry in data["models"]}
            for old in current.get("models", []):
                if old.get("control") and old["id"] in requested and "control" not in requested[old["id"]]:
                    self.error("Сохраните привязку управления Hub или явно удалите её (control: null). Старый редактор не может убрать её неявно.", 409)
            expected = data.get("expectedVersion")
            if expected is not None:
                if type(expected) is not int or expected < 0:
                    self.error("Некорректная ожидаемая версия каталога.")
                if expected != current.get("version", 0):
                    self.error("Каталог изменён на другом устройстве. Обновите его с Hub перед публикацией.", 409)
            record = {
                "version": int(current.get("version", 0)) + 1,
                "updatedAt": int(time.time()),
                "updatedBy": actor.get("name") or actor.get("id") or "admin",
                "models": models,
            }
            durable.publish(self.path, json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode())
            return record
