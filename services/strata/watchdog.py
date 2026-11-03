"""Bounded recovery of this VM's owned service. No inference or prompt replay."""
import json
import math
import os
from pathlib import Path
import subprocess
import time
import urllib.request

STATE = Path("/var/lib/strata-control/watchdog.json")
UNIT = "strata-api.service"


def decision(previous, healthy, now):
    history = previous.get("restarts", [])
    if not isinstance(history, list) or any(type(t) not in (int, float) or not math.isfinite(t) for t in history):
        raise ValueError("Invalid watchdog state; refusing recovery")
    history = [t for t in history if now - 3600 < t]
    failures = previous.get("failures", 0)
    if type(failures) is not int or not 0 <= failures <= 3:
        raise ValueError("Invalid watchdog state; refusing recovery")
    failures = 0 if healthy else min(failures + 1, 3)
    state = dict(failures=failures, restarts=history)
    if failures < 3:
        return state, "healthy" if healthy else "observe"
    if len(history) >= 3:
        return state, "limited"
    if history and now - history[-1] < 600:
        return state, "cooldown"
    state.update(failures=0, restarts=history + [now])
    return state, "restart"


def healthy(pid):
    import psutil
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:1920/health", timeout=4) as response:
        h = json.load(response)
    if h.get("status") != "ok" or h.get("loaded") is not True or h.get("model") != "qwen38-flash-next":
        return False
    try:
        children = {p.exe() for p in psutil.Process(pid).children(recursive=True) if p.is_running()}
    except psutil.Error:
        return False
    # Control 0.1.56 starts Vision lazily and stops it after idle timeout.
    # Its absence is healthy; the owned text engine must still be running.
    return "/opt/strata/bin/strata" in children


def main():
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    old = json.loads(STATE.read_text()) if STATE.exists() else {}
    properties = subprocess.check_output(["systemctl", "show", UNIT, "-p", "ActiveState", "-p", "MainPID"], text=True)
    properties = dict(line.split("=", 1) for line in properties.splitlines())
    if properties.get("ActiveState") != "active":
        old["failures"] = 0
        state, action = old, "not-active"
    else:
        try:
            ok = healthy(int(properties["MainPID"]))
        except (OSError, ValueError, ProcessLookupError):
            ok = False
        state, action = decision(old, ok, time.time())
    temp = STATE.with_suffix(".tmp")
    temp.write_text(json.dumps(state)); temp.chmod(0o600); os.replace(temp, STATE)
    if action == "restart":
        print("Strata unhealthy on3checks: restarting only ownedAPIunit, no inference replay", flush=True)
        subprocess.run(["systemctl", "restart", UNIT], check=True, timeout=660)
    elif action in ("limited", "cooldown"):
        print("Strata recovery " + action + "; no extra restart or inference", flush=True)


if __name__ == "__main__":
    main()
