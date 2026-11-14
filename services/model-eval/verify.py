#!/usr/bin/env python3
"""Offline behavioural checks for model-generated source files."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess


def command(args, cwd: Path, timeout=40):
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return result.returncode, (result.stdout + result.stderr)[-3000:]
    except subprocess.TimeoutExpired:
        return 124, "verification timeout"


def backend(directory: Path):
    test = r'''import math
import sys
import unittest
sys.path.insert(0, ".")
from backend_limiter import TokenBucket

class BucketTest(unittest.TestCase):
    def test_bucket_contract(self):
        now = [100.0]
        b = TokenBucket(2, 4, clock=lambda: now[0])
        self.assertAlmostEqual(b.available, 2)
        self.assertTrue(b.try_acquire(1.5))
        self.assertFalse(b.try_acquire(1.0))
        self.assertAlmostEqual(b.available, 0.5)
        now[0] -= 50
        self.assertAlmostEqual(b.available, 0.5)
        now[0] = 100.25
        self.assertAlmostEqual(b.available, 1.5)
        now[0] = 101.0
        self.assertAlmostEqual(b.available, 2)
        self.assertTrue(b.try_acquire(2))
        self.assertAlmostEqual(b.available, 0)

    def test_invalid_arguments(self):
        for args in [(0, 1), (-1, 1), (1, 0), (1, -2), (float("nan"), 1), (1, float("inf"))]:
            with self.assertRaises((ValueError, TypeError)):
                TokenBucket(*args)
        b = TokenBucket(1, 1)
        for value in [0, -1, float("nan"), float("inf")]:
            with self.assertRaises((ValueError, TypeError)):
                b.try_acquire(value)

unittest.main()
'''
    (directory / "test_backend.py").write_text(test)
    return command(["python3", "test_backend.py"], directory)


def telemetry(directory: Path):
    test = r'''import assert from "node:assert/strict";
import { validateTelemetry, telemetryCsvRow } from "./telemetry.mjs";
const valid = {deviceId:"esp32-lab", sequence:4, timestamp:123.5, temperatureC:21.25};
assert.deepEqual(validateTelemetry(valid), {ok:true, errors:[]});
assert.equal(telemetryCsvRow(valid), "esp32-lab,4,123.5,21.25");
assert.equal(validateTelemetry(null).ok, false);
assert.equal(validateTelemetry([]).ok, false);
for (const bad of [
  {...valid, sequence:-1}, {...valid, sequence:1.2}, {...valid, timestamp:Infinity},
  {...valid, temperatureC:NaN}, {...valid, temperatureC:126}, {...valid, deviceId:""},
  {...valid, deviceId:"x".repeat(65)}
]) assert.equal(validateTelemetry(bad).ok, false, JSON.stringify(bad));
assert.equal(telemetryCsvRow({...valid, temperatureC:NaN}), "");
assert.equal(telemetryCsvRow({...valid, deviceId:'a,"b'}), '"a,""b",4,123.5,21.25');
console.log("telemetry checks passed");
'''
    (directory / "telemetry.test.mjs").write_text(test)
    return command(["node", "telemetry.test.mjs"], directory)


def esp32(directory: Path):
    (directory / "Arduino.h").write_text(r'''#pragma once
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#define OUTPUT 1
#define INPUT_PULLUP 2
#define HIGH 1
#define LOW 0
#define DEVICE_DISCONNECTED_C -127.0f
extern uint64_t fake_millis;
extern int pin_modes[64];
extern int button_state;
extern std::vector<std::pair<int,int> > writes;
extern bool delay_called;
extern std::string serial_output;
inline uint64_t millis() { return fake_millis; }
inline void pinMode(int p, int m) { pin_modes[p] = m; }
inline void digitalWrite(int p, int v) { writes.push_back({p,v}); }
inline int digitalRead(int) { return button_state; }
inline void delay(uint32_t) { delay_called = true; }
struct SerialFake {
  void begin(unsigned long) {}
  void print(const char* s) { serial_output += s; }
  void print(int v) { serial_output += std::to_string(v); }
  void print(float v) { serial_output += std::to_string(v); }
  void print(float v, int digits) { char b[64]; std::snprintf(b, sizeof(b), "%.*f", digits, v); serial_output += b; }
  void println() { serial_output += "\n"; }
  void println(const char* s) { serial_output += s; serial_output += "\n"; }
  void println(int v) { serial_output += std::to_string(v); serial_output += "\n"; }
  void println(float v) { serial_output += std::to_string(v); serial_output += "\n"; }
  void println(float v, int digits) { char b[64]; std::snprintf(b, sizeof(b), "%.*f\\n", digits, v); serial_output += b; }
  template<typename... Args> void printf(const char* fmt, Args... args) { char b[256]; std::snprintf(b, sizeof(b), fmt, args...); serial_output += b; }
};
extern SerialFake Serial;
''')
    (directory / "OneWire.h").write_text("#pragma once\nclass OneWire { public: explicit OneWire(int) {} };\n")
    (directory / "DallasTemperature.h").write_text(r'''#pragma once
#include "OneWire.h"
extern int sensor_begin_count;
extern int sensor_request_count;
class DallasTemperature {
 public:
  explicit DallasTemperature(OneWire*) {}
  void begin() { ++sensor_begin_count; }
  int getDeviceCount() { return 1; }
  void setWaitForConversion(bool) {}
  bool isConversionComplete() { return true; }
  void requestTemperatures() { ++sensor_request_count; }
  float getTempCByIndex(int) { return 23.5f; }
};
''')
    (directory / "test.cpp").write_text(r'''#include "Arduino.h"
#include "OneWire.h"
#include "DallasTemperature.h"
#include <cassert>
#include <iostream>
uint64_t fake_millis = 0;
int pin_modes[64] = {};
int button_state = HIGH;
std::vector<std::pair<int,int> > writes;
bool delay_called = false;
std::string serial_output;
SerialFake Serial;
int sensor_begin_count = 0;
int sensor_request_count = 0;
void setup();
void loop();
int main() {
  setup();
  assert(pin_modes[2] == OUTPUT);
  assert(pin_modes[0] == INPUT_PULLUP);
  assert(sensor_begin_count == 1);
  writes.clear();
  fake_millis = 501;
  loop();
  assert(!writes.empty());
  fake_millis = 2001;
  loop();
  assert(sensor_request_count >= 1);
  fake_millis = 2752;
  loop();
  assert(!serial_output.empty());
  assert(!delay_called);
  std::cout << "ESP32 behavioural checks passed\n";
}
''')
    source = (directory / "esp32_controller.ino").read_text(errors="replace")
    forbidden = [x for x in ["delay(", "delayMicroseconds(", "sleep(", "while (true)", "while(true)"] if x in source]
    if forbidden:
        return 1, "blocking calls: " + ", ".join(forbidden)
    return command(["g++", "-std=c++17", "-Wall", "-Wextra", "-pedantic", "-I", ".", "-x", "c++", "esp32_controller.ino", "-x", "c++", "test.cpp", "-o", "esp32_test"], directory) if not command(["g++", "--version"], directory)[0] else (1, "g++ unavailable")


def scene3d(directory: Path):
    test = r'''import assert from "node:assert/strict";
import { cuboidVertices, projectPoint, projectCuboid } from "./scene3d.mjs";
const cube = cuboidVertices(10, 20, 30, 4, 6, 8);
assert.equal(cube.length, 8);
const xs = cube.map(v => v[0]), ys = cube.map(v => v[1]), zs = cube.map(v => v[2]);
assert.equal(Math.min(...xs), 8); assert.equal(Math.max(...xs), 12);
assert.equal(Math.min(...ys), 17); assert.equal(Math.max(...ys), 23);
assert.equal(Math.min(...zs), 26); assert.equal(Math.max(...zs), 34);
const center = projectPoint(0, 0, 0, {});
assert.ok(Math.abs(center.x - 400) < 1e-6 && Math.abs(center.y - 300) < 1e-6);
assert.ok(Number.isFinite(center.depth));
const right = projectPoint(10, 0, 0, {}), left = projectPoint(-10, 0, 0, {});
assert.ok(right.x > 400 && left.x < 400);
const z1 = projectPoint(5, 5, 10, {}), z2 = projectPoint(5, 5, 10, {zoom: 2});
assert.ok(Math.abs((z2.x - 400) - 2 * (z1.x - 400)) < 1e-6);
assert.ok(Math.abs((z2.y - 300) - 2 * (z1.y - 300)) < 1e-6);
const zero = projectPoint(1, 2, 10, {width: 0, height: 0});
assert.ok(Number.isFinite(zero.x) && Number.isFinite(zero.y));
const scene = projectCuboid(0, 0, 0, 4, 6, 8, {});
assert.equal(scene.vertices.length, 8); assert.equal(scene.faces.length, 6);
for (const face of scene.faces) {
  assert.equal(face.length, 4);
  for (const i of face) assert.ok(Number.isInteger(i) && i >= 0 && i < 8);
}
const average = f => f.reduce((s, i) => s + scene.vertices[i].depth, 0) / 4;
for (let i = 1; i < scene.faces.length; i++) assert.ok(average(scene.faces[i - 1]) >= average(scene.faces[i]) - 1e-6);
console.log("3D module checks passed");
'''
    (directory / "scene3d.test.mjs").write_text(test)
    return command(["node", "scene3d.test.mjs"], directory)


def verify_task(name: str, directory: Path):
    files = {"backend": "backend_limiter.py", "telemetry": "telemetry.mjs", "scene3d": "scene3d.mjs", "esp32": "esp32_controller.ino"}
    source = directory / files[name]
    if not source.exists() or len(source.read_text(errors="replace").strip()) < 20:
        return {"pass": False, "summary": "source missing or empty"}
    if name == "scene3d":
        code, output = scene3d(directory)
    elif name == "backend":
        code, output = backend(directory)
    elif name == "telemetry":
        code, output = telemetry(directory)
    else:
        code, output = esp32(directory)
        if code == 0:
            code, output = command(["./esp32_test"], directory)
    return {"pass": code == 0, "summary": output.strip()[-2000:] or f"exit {code}"}
