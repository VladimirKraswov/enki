"""Authenticated coordinator, not an inference proxy or VM/process manager.

Only operator-configured gateways can be contacted. Device requests contain
catalog IDs, never URLs/commands/credentials. Persistent, expiring reservations
protect whole agent turns (including gaps spent executing tools).
"""
import contextlib
from http.client import HTTPConnection, HTTPSConnection
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import urlsplit
import uuid

ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
LEASE_SECONDS = 600
MAX_WAIT = 31 * 60
MAX_RESPONSE = 128 * 1024


class ModelServices:
    def __init__(self, root, catalog, fault, config=None, transport=None, clock=time.time):
        self.path = root / "model-reservations.sqlite3"
        self.catalog, self.fault, self.clock = catalog, fault, clock
        self.config = Path(config or os.environ.get("ENKI_MODEL_SERVICES_CONFIG") or os.environ.get("ARVELA_MODEL_SERVICES_CONFIG") or ("/etc/enki-hub/model-services.json" if Path("/etc/enki-hub").exists() or not Path("/etc/arvela-hub").exists() else "/etc/arvela-hub/model-services.json"))
        self.transport = transport or self._request
        self.lock = threading.RLock()
        self.locks = {}
        with self.db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS reservations (
                id TEXT PRIMARY KEY, device TEXT NOT NULL, request_key TEXT NOT NULL,
                service TEXT NOT NULL, resource TEXT NOT NULL, target TEXT NOT NULL,
                agent TEXT NOT NULL, mode TEXT NOT NULL, created REAL NOT NULL,
                expires REAL NOT NULL, phase TEXT NOT NULL, status TEXT,
                UNIQUE(device, request_key))""")
        self.path.chmod(0o600)

    @contextlib.contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def fail(self, code, text):
        raise self.fault(code, text)

    @contextlib.contextmanager
    def gate(self, lock):
        acquired = lock.acquire(timeout=.05)
        try:
            yield acquired
        finally:
            if acquired:
                lock.release()

    def services(self):
        if not self.config.exists():
            return {}
        if self.config.is_symlink() or self.config.stat().st_mode & 0o077 or self.config.stat().st_size > MAX_RESPONSE:
            self.fail(503, "Небезопасная конфигурация сервисов моделей на Hub.")
        try:
            data = json.loads(self.config.read_bytes())
            services = data["services"]
            if not isinstance(services, dict) or len(services) > 32:
                raise ValueError()
            for sid, service in services.items():
                url = urlsplit(service["endpoint"])
                ip = ipaddress.ip_address(url.hostname)
                if (not ID.fullmatch(sid) or not ID.fullmatch(service["resource"]) or
                    url.scheme not in ("http", "https") or not (ip.is_private or ip.is_loopback) or
                    ip.is_unspecified or ip.is_multicast or url.username or url.password or
                    url.path not in ("", "/") or url.query or url.fragment or not url.port):
                    raise ValueError()
                if not isinstance(service["label"], str) or not 1 <= len(service["label"]) <= 120:
                    raise ValueError()
                if service.get("kind", "switch") not in ("switch", "fixed"):
                    raise ValueError()
                if service.get("kind") == "fixed" and (not ID.fullmatch(service.get("model", "")) or
                    not isinstance(service.get("agents"), list) or not service["agents"] or
                    any(a not in ("opencode", "pi") for a in service["agents"])):
                    raise ValueError()
                key = Path(service["tokenFile"])
                if not key.is_absolute() or key.is_symlink() or key.stat().st_mode & 0o077 or key.stat().st_size > 4096:
                    raise ValueError()
            return services
        except (ValueError, KeyError, TypeError, OSError):
            self.fail(503, "Проверьте конфигурацию сервисов моделей на Hub.")

    def routes(self):
        services = self.services()
        routes = []
        for model in self.catalog.get()["models"]:
            control = model.get("control")
            if not control:
                continue
            # A missing service is still advertised, so clients fail closed instead
            # of silently bypassing the Hub and sending to the inference endpoint.
            for agent in ("opencode", "pi"):
                engine = model.get(agent)
                if not engine:
                    continue
                configured = engine["provider"]["models"]
                ids = configured.keys() if isinstance(configured, dict) else [m["id"] for m in configured]
                for mid in ids:
                    if mid in control["bindings"]:
                        sid = control["service"]
                        route = dict(service=sid, label=services.get(sid, {}).get("label", sid),
                            providerID=engine["providerId"], modelID=mid, agent=agent,
                            target=control["bindings"][mid])
                        # Explicit per-target transport capability. Never guess
                        # from a provider's display name or expose private URLs.
                        progress = services.get(sid, {}).get("promptProgress", {})
                        if isinstance(progress, dict) and progress.get(route["target"]) == "prompt-progress-v1":
                            route["promptProgress"] = "prompt-progress-v1"
                        routes.append(route)
        return routes

    def route(self, data):
        found = [r for r in self.routes() if all(r[k] == data.get(k) for k in ("providerID", "modelID", "agent"))]
        if len(found) != 1:
            self.fail(409, "Модель не имеет однозначной привязки к сервису Hub. Обновите каталог.")
        route = found[0]
        service = self.services().get(route["service"])
        if not service:
            self.fail(503, "Сервис этой модели ещё не настроен на Hub.")
        return route, service

    def _request(self, service, path, body=None):
        if service.get("kind") == "fixed":
            return self._fixed(service, path, body)
        url = urlsplit(service["endpoint"])
        key = Path(service["tokenFile"]).read_text().strip()
        if not key or len(key) > 4096 or "\n" in key or "\r" in key:
            self.fail(503, "Некорректный ключ сервиса на Hub.")
        connection = (HTTPSConnection if url.scheme == "https" else HTTPConnection)(url.hostname, url.port, timeout=4)
        try:
            raw = json.dumps(body).encode() if body is not None else None
            connection.request("POST" if raw else "GET", "/v1/model-control/" + path, raw,
                {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            response = connection.getresponse()
            payload = response.read(MAX_RESPONSE + 1)
            if response.status == 409:
                self.fail(409, "Другой клиент уже переключает модель.")
            if response.status not in (200, 202) or len(payload) > MAX_RESPONSE:
                self.fail(502, "Сервис модели отклонил управление. Проверьте соединение и ключ на Hub.")
            return json.loads(payload)
        except self.fault:
            raise
        except Exception:
            # No raw exception, endpoint, provider body or credential reaches a client.
            self.fail(502, "Hub временно не может связаться с сервисом модели.")
        finally:
            connection.close()

    def _fixed(self, service, path, body=None):
        """A single always-resident server is monitored, never implicitly started,
        unloaded or given a synthetic inference request."""
        model = service["model"]
        if path == "catalog":
            return {"schema": 1, "models": [{"id": model, "agents": service["agents"]}]}
        if path == "select" and (body.get("model") != model or body.get("agent") not in service["agents"]):
            self.fail(403, "Модель недоступна на этом сервисе.")
        url = urlsplit(service["endpoint"])
        key = Path(service["tokenFile"]).read_text().strip()
        connection = (HTTPSConnection if url.scheme == "https" else HTTPConnection)(url.hostname, url.port, timeout=4)
        try:
            connection.request("GET", "/health", headers={"Authorization": "Bearer " + key})
            health = connection.getresponse()
            health_raw = health.read(MAX_RESPONSE + 1)
            try:
                doc = json.loads(health_raw) if len(health_raw) <= MAX_RESPONSE else None
            except ValueError:
                doc = None
            # A model can stay advertised while its weights are unloaded or its
            # engine is draining. HTTP200 alone must not open the dispatch gate.
            healthy = (health.status == 200 and isinstance(doc, dict) and doc.get("status") == "ok"
                       and ("loaded" not in doc or doc["loaded"] is True)
                       and doc.get("maintenance", "serving") == "serving"
                       and doc.get("model", model) == model)
            connection.request("GET", "/v1/models", headers={"Authorization": "Bearer " + key})
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ValueError()
            entries = json.loads(raw).get("data", [])
            ready = healthy and response.status == 200 and any(m.get("id") == model for m in entries)
            return dict(schema=1, operation_id="fixed:" + model, phase="ready" if ready else "failed", ready=ready,
                active_model=model if ready else None, target_model=model, elapsed_seconds=0,
                active_requests=0, loader=None, error=None if ready else "Постоянный сервер модели не готов.")
        except Exception:
            self.fail(502, "Hub не может проверить постоянный сервер модели.")
        finally:
            connection.close()

    def state(self, service):
        state = self.transport(service, "status")
        def counter(value):
            return type(value) in (int, float) and math.isfinite(value) and value >= 0
        required = ("operation_id", "phase", "ready", "active_model", "target_model", "elapsed_seconds", "active_requests", "error", "loader")
        if (not isinstance(state, dict) or state.get("schema") != 1 or any(k not in state for k in required) or
            type(state["ready"]) is not bool or state["phase"] not in ("unloaded", "draining", "unloading", "loading", "warming", "ready", "failed") or
            type(state["active_requests"]) is not int or state["active_requests"] < 0 or not counter(state["elapsed_seconds"]) or
            any(state[k] is not None and (not isinstance(state[k], str) or len(state[k]) > 1024)
                for k in ("operation_id", "active_model", "target_model", "error"))):
            self.fail(502, "Сервис вернул неподдерживаемый статус модели.")
        loader = state["loader"]
        if loader is not None and (not isinstance(loader, dict) or not isinstance(loader.get("phase"), str) or
            loader.get("unit") not in (None, "bytes") or not counter(loader.get("current")) or not counter(loader.get("total"))):
            self.fail(502, "Сервис вернул неподдерживаемый прогресс модели.")
        return {"schema": 1, **{k: state[k] for k in required}, "error": "Ошибка загрузки на сервисе модели." if state["error"] else None}

    def api(self, method, action, actor, data):
        if action == "catalog" and method == "GET":
            return {"schema": 1, "routes": self.routes()}
        if method != "POST":
            self.fail(405, "Метод не поддерживается.")
        if action == "inspect":
            _, service = self.route(data)
            return self.state(service)
        if action == "prepare":
            route, service = self.route(data)
            key = data.get("requestKey")
            mode = data.get("mode")
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9:_-]{1,128}", key) or mode not in ("select", "run"):
                self.fail(400, "Некорректная заявка на модель.")
            catalog = self.transport(service, "catalog")
            if not isinstance(catalog, dict) or not isinstance(catalog.get("models"), list):
                self.fail(502, "Сервис вернул неподдерживаемый каталог.")
            allowed = [m for m in catalog.get("models", []) if m.get("id") == route["target"] and data["agent"] in m.get("agents", [])]
            if catalog.get("schema") != 1 or len(allowed) != 1:
                self.fail(403, "Модель недоступна выбранному агенту на сервисе.")
            now = self.clock()
            with self.lock, self.db() as db:
                db.execute("DELETE FROM reservations WHERE expires < ?", (now - 86400,))
                previous = db.execute("SELECT * FROM reservations WHERE device=? AND request_key=?", (actor["id"], key)).fetchone()
                if previous:
                    if (previous["service"], previous["target"], previous["agent"], previous["mode"]) != (route["service"], route["target"], data["agent"], mode):
                        self.fail(409, "Эта заявка уже относится к другой модели.")
                    if previous["mode"] == "select" and previous["phase"] == "released" and previous["status"] and previous["expires"] >= now:
                        return {k: v for k, v in json.loads(previous["status"]).items() if not k.startswith("_")}
                    if previous["phase"] in ("released", "failed") or previous["expires"] < now:
                        self.fail(409, "Заявка завершена. Создайте новую заявку.")
                    ticket = previous["id"]
                else:
                    if db.execute("SELECT count(*) FROM reservations WHERE expires>? AND phase NOT IN ('released','failed')", (now,)).fetchone()[0] >= 128:
                        self.fail(429, "Очередь переключений Hub заполнена.")
                    if db.execute("SELECT count(*) FROM reservations WHERE device=? AND expires>? AND phase NOT IN ('released','failed')", (actor["id"], now)).fetchone()[0] >= 24:
                        self.fail(429, "Слишком много заявок от этого устройства.")
                    ticket = str(uuid.uuid4())
                    db.execute("INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (ticket, actor["id"], key, route["service"], service["resource"], route["target"], data["agent"], mode, now, now + LEASE_SECONDS, "waiting", None))
            return self.poll(ticket, actor)
        if action in ("status", "release"):
            ticket = data.get("ticket")
            if not isinstance(ticket, str) or len(ticket) != 36:
                self.fail(400, "Некорректный идентификатор заявки.")
            if action == "release":
                with self.lock, self.db() as db:
                    db.execute("UPDATE reservations SET phase='released',expires=? WHERE id=? AND device=?", (self.clock(), ticket, actor["id"]))
                return {"released": True}
            return self.poll(ticket, actor)
        self.fail(404, "Неизвестное действие сервиса моделей.")

    def poll(self, ticket, actor):
        now = self.clock()
        with self.lock, self.db() as db:
            row = db.execute("SELECT * FROM reservations WHERE id=? AND device=?", (ticket, actor["id"])).fetchone()
            if not row:
                self.fail(404, "Заявка не найдена.")
            if row["expires"] < now or row["phase"] == "released":
                self.fail(409, "Срок заявки истёк; запрос агенту не отправлен.")
            if row["phase"] == "failed":
                return {k: v for k, v in json.loads(row["status"]).items() if not k.startswith("_")}
            # Renew BEFORE network IO; transient transport failure must not discard a lease.
            db.execute("UPDATE reservations SET expires=? WHERE id=?", (now + LEASE_SECONDS, ticket))
            gate = self.locks.setdefault(row["resource"], threading.Lock())
        with self.gate(gate) as acquired:
            if not acquired:
                return self.result(row, "checking" if row["phase"] == "ready" else "waiting")
            services = self.services()
            service = services.get(row["service"])
            if not service or service["resource"] != row["resource"]:
                self.fail(503, "Конфигурация сервиса изменилась. Заявка не выполнена.")
            state = self.state(service)
            with self.lock, self.db() as db:
                # Recheck cancellation after IO. A release cannot resurrect a lease.
                current = db.execute("SELECT phase FROM reservations WHERE id=?", (ticket,)).fetchone()
                if current["phase"] == "released":
                    self.fail(409, "Заявка отменена; запрос агенту не отправлен.")
                others = db.execute("SELECT * FROM reservations WHERE resource=? AND id!=? AND expires>? AND phase NOT IN ('failed','released') ORDER BY created,id",
                    (row["resource"], ticket, now)).fetchall()
            blocked = any((r["phase"] == "ready" or (r["created"], r["id"]) < (row["created"], row["id"])) and
                (r["service"] != row["service"] or r["target"] != row["target"]) for r in others)
            busy = state["phase"] in ("draining", "unloading", "loading", "warming")
            previous = json.loads(row["status"]) if row["status"] else {}
            if service.get("kind") == "fixed" and not state["ready"]:
                result = self.result(row, "failed", state)
            elif row["phase"] in ("draining", "unloading", "loading", "warming") and (
                state["phase"] == "failed" or previous.get("_gatewayOperation") != state["operation_id"]):
                result = self.result(row, "failed", error="Загрузка прервана на сервисе модели. Повторите явно.")
            elif row["phase"] == "ready" and (not state["ready"] or state["active_model"] != row["target"]):
                # Another, non-Hub controller took the GPU. Never silently load a
                # different model underneath an already dispatched agent turn.
                result = self.result(row, "failed", error="Модель изменена вне Hub. Остановите задание и повторите явно.")
            elif blocked or busy and state["target_model"] != row["target"]:
                result = self.result(row, "waiting")
            else:
                if not busy and not (state["ready"] and state["active_model"] == row["target"]):
                    try:
                        self.transport(service, "select", {"model": row["target"], "agent": row["agent"]})
                    except self.fault as error:
                        if error.status != 409:
                            raise
                        return self.result(row, "waiting")
                    state = self.state(service)
                result = self.result(row, state["phase"], state)
            if result["phase"] != "ready" and now - row["created"] > MAX_WAIT:
                result = self.result(row, "failed", error="Истекло время ожидания модели. Заявка сохранена; повторите явно.")
            with self.lock, self.db() as db:
                # Select-only requests warm the model without owning an agent turn.
                phase = "released" if row["mode"] == "select" and result["ready"] else result["phase"]
                db.execute("UPDATE reservations SET phase=?,status=? WHERE id=? AND phase!='released'", (phase, json.dumps(dict(result, _gatewayOperation=state["operation_id"])), ticket))
            return result

    def result(self, row, phase, state=None, error=None):
        state = state or {}
        ready = phase == "ready" and state.get("ready") is True and state.get("active_model") == row["target"]
        return dict(schema=1, operation_id=row["id"], phase=phase, ready=ready,
            active_model=state.get("active_model"), target_model=row["target"],
            elapsed_seconds=round(max(0, self.clock() - row["created"]), 1),
            active_requests=state.get("active_requests", 0), loader=state.get("loader"),
            error=error or state.get("error"))
