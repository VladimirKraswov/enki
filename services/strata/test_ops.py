import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock
import sys


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


w, r, g = (module(n) for n in ("watchdog", "ready", "gateway_config"))


class Recovery(unittest.TestCase):
    def test_elastic_vision_absence_does_not_restart_healthy_engine(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"status":"ok","loaded":true,"model":"qwen38-flash-next"}'
        psutil = MagicMock()
        psutil.Error = RuntimeError
        child = MagicMock()
        child.exe.return_value = "/opt/strata/bin/strata"
        child.is_running.return_value = True
        psutil.Process.return_value.children.return_value = [child]
        with patch.dict(sys.modules, {"psutil": psutil}), patch.object(w.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = response
            self.assertTrue(w.healthy(123))
            child.exe.return_value = "/opt/strata/bin/strata-vision"
            self.assertFalse(w.healthy(123))
            child.is_running.return_value = False
            self.assertFalse(w.healthy(123))

    def test_three_observations_then_only_one_restart(self):
        state = {}
        for i in range(2):
            state, action = w.decision(state, False, 1000+i)
            self.assertEqual(action, "observe")
        state, action = w.decision(state, False, 1002)
        self.assertEqual(action, "restart")
        self.assertEqual(state, {"failures": 0, "restarts": [1002]})
        for i in range(3): state, action = w.decision(state, False, 1003+i)
        self.assertEqual(action, "cooldown")

    def test_success_resets_failure_count_not_restart_history(self):
        self.assertEqual(w.decision({"failures": 2, "restarts": [900]}, True, 1000),
                         ({"failures": 0, "restarts": [900]}, "healthy"))

    def test_bounded_restarts_and_backwards_clock(self):
        self.assertEqual(w.decision({"failures": 2, "restarts": [100, 800, 1500]}, False, 2200)[1], "limited")
        self.assertEqual(w.decision({"failures": 2, "restarts": [1500]}, False, 1000)[1], "cooldown")

    def test_corrupt_state_fails_closed(self):
        for value in ({"restarts": [float("nan")]}, {"restarts": "bad"}, {"failures": -1}):
            with self.assertRaises(ValueError): w.decision(value, False, 1000)


class Boundaries(unittest.TestCase):
    def test_gateway_preserves_explicit_lan_and_ssh_loopback_binds(self):
        config = dict(listen="192.168.31.71", backendKey="a"*64, clientKeys=["local"])
        self.assertIn("listen 192.168.31.71:1919;", g.render(config))
        self.assertIn("listen 127.0.0.1:1919;", g.render(config))
        self.assertIn("listen [fd00::71]:1919;", g.render({**config, "listen": "fd00::71"}))
        self.assertEqual(g.render({**config, "listen": "127.0.0.1"}).count("listen "), 1)

    def test_exact_readiness_not_http200_or_advertised_model_alone(self):
        h = dict(status="ok", loaded=True, model=r.MODEL, max_context=262144)
        m = dict(data=[dict(id=r.MODEL)])
        self.assertTrue(r.ready(h, m))
        for change in [dict(loaded=False), dict(model="other"), dict(max_context=131072), dict(status="loading")]:
            self.assertFalse(r.ready({**h, **change}, m))
        self.assertFalse(r.ready(h, dict(data=[])))

    def test_gateway_refuses_secret_injection_or_weak_backend(self):
        good = dict(listen="192.168.31.71", backendKey="a"*64, clientKeys=["local"])
        for change in [dict(backendKey="local"), dict(clientKeys=['x"; evil']), dict(listen="0.0.0.0")]:
            with self.assertRaises(ValueError): g.render({**good, **change})


if __name__ == "__main__": unittest.main()
