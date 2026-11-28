import importlib.util
import tempfile
import time
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("images", Path(__file__).parents[1] / "images.py")
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


class ImagesService(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.token = self.root / "token"
        self.token.write_text("test-secret")
        self.env = patch.dict("os.environ", {"ENKI_HUB_IMAGES_TOKEN_FILE": str(self.token)})
        self.env.start()
        self.service = images.Images(self.root)

    def tearDown(self):
        # The service owns a background worker; stop it before removing its SQLite database.
        self.service.stop()
        self.env.stop()
        self.tmp.cleanup()

    def test_health_reports_presets_and_engine_readiness(self):
        with patch.object(images, "_json_request", return_value={"devices": [{"name": "Tesla V100", "vram_total": 100, "vram_free": 60}]}):
            health = self.service.health()
        self.assertEqual(health["status"], "ready")
        self.assertEqual(health["engine"]["device"], "Tesla V100")
        self.assertEqual(health["model"]["qualities"]["best"]["steps"], 40)
        self.assertEqual(health["queue"], {"pending": 0, "running": 0})

    def test_database_connections_are_closed_after_each_operation(self):
        original_connect = self.service._connect
        opened = []

        def tracked_connect():
            connection = original_connect()
            opened.append(connection)
            return connection

        with patch.object(self.service, "_connect", side_effect=tracked_connect):
            self.service.jobs()

        self.assertEqual(len(opened), 1)
        with self.assertRaises(images.sqlite3.ProgrammingError):
            opened[0].execute("SELECT 1")

    def test_auth_uses_constant_time_bearer_check(self):
        self.service.authorize({"Authorization": "Bearer test-secret"})
        with self.assertRaises(images.ImagesError) as error:
            self.service.authorize({"Authorization": "Bearer wrong"})
        self.assertEqual(error.exception.status, 401)

    def test_job_validation_rejects_invalid_quality_and_oversized_source(self):
        with self.assertRaises(images.ImagesError) as quality:
            self.service.submit({"prompt": "test", "quality": "unknown"})
        self.assertEqual(quality.exception.code, "invalid_quality")
        with self.assertRaises(images.ImagesError) as source:
            self.service.submit({"prompt": "test", "source_image": {"data_base64": "A" * (images.MAX_SOURCE_BYTES * 2)}})
        self.assertEqual(source.exception.code, "source_too_large")

    def test_cancel_only_interrupts_the_running_job_that_owns_comfy(self):
        def add_job(job_id, state):
            with self.service._connection() as db:
                db.execute("INSERT INTO jobs(id,state,created,mode,width,height,seed,phase,step,steps,prompts,images,request) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (job_id, state, time.time(), "text-to-image", 1024, 1024, 1, state, 0, 4, json.dumps(["test"]), "[]", "{}"))

        add_job("queued", "queued")
        add_job("other-running", "running")
        add_job("owned-running", "running")
        self.service.current = "owned-running"
        self.service.current_prompt = "owned-prompt"
        with patch.object(images, "_json_request") as engine:
            self.assertEqual(self.service.cancel("queued")["state"], "cancelled")
            self.assertEqual(self.service.cancel("other-running")["state"], "cancelled")
            engine.assert_not_called()
            self.assertEqual(self.service.cancel("owned-running")["state"], "cancelled")
            engine.assert_called_once_with("/interrupt", {"prompt_id": "owned-prompt"}, timeout=15)

    def test_edit_workflow_uses_2511_plus_encoder_and_reference_latents(self):
        graph = self.service._workflow(1024, 1024, 9, "make it blue", 0.8, "source.png", images.QUALITIES["best"])
        self.assertEqual(graph["positive"]["class_type"], "TextEncodeQwenImageEditPlus")
        self.assertEqual(graph["positive"]["inputs"]["image1"], ["source", 0])
        self.assertEqual(graph["ref-positive"]["inputs"]["reference_latents_method"], "index_timestep_zero")
        self.assertEqual(graph["sampler"]["inputs"]["steps"], 40)
        self.assertEqual(graph["sampler"]["inputs"]["cfg"], 4.0)


if __name__ == "__main__":
    unittest.main()
