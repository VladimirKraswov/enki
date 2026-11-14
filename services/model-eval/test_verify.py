import shutil
from pathlib import Path
import tempfile
import unittest

from verify import verify_task


class VerifyFixtures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_backend(self):
        (self.root / "backend_limiter.py").write_text('''import math, threading\nclass TokenBucket:\n def __init__(self, capacity, refill_per_second, clock=None):\n  if not math.isfinite(capacity) or not math.isfinite(refill_per_second) or capacity <= 0 or refill_per_second <= 0: raise ValueError()\n  self.capacity=capacity; self.rate=refill_per_second; self.clock=clock or __import__('time').monotonic; self.tokens=capacity; self.at=self.clock(); self.lock=threading.Lock()\n @property\n def available(self):\n  with self.lock:\n   now=self.clock(); self.tokens=min(self.capacity,self.tokens+max(0,now-self.at)*self.rate); self.at=max(self.at,now); return self.tokens\n def try_acquire(self,tokens=1.0):\n  if not math.isfinite(tokens) or tokens <= 0: raise ValueError()\n  with self.lock:\n   now=self.clock(); self.tokens=min(self.capacity,self.tokens+max(0,now-self.at)*self.rate); self.at=max(self.at,now)\n   if tokens > self.tokens:return False\n   self.tokens-=tokens;return True\n''')
        self.assertTrue(verify_task("backend", self.root)["pass"])

    @unittest.skipUnless(shutil.which("node"), "node unavailable")
    def test_telemetry(self):
        (self.root / "telemetry.mjs").write_text('''const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);\nexport function validateTelemetry(v){const errors=[];if(!plain(v))return {ok:false,errors:['object']};if(!Number.isInteger(v.sequence)||v.sequence<0)errors.push('sequence');if(!Number.isFinite(v.timestamp)||v.timestamp<0)errors.push('timestamp');if(!Number.isFinite(v.temperatureC)||v.temperatureC < -40||v.temperatureC>125)errors.push('temperature');if(typeof v.deviceId!=='string'||!v.deviceId||v.deviceId.length>64)errors.push('device');return {ok:!errors.length,errors};}\nconst csv=s=>/[" ,\\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;\nexport function telemetryCsvRow(v){return validateTelemetry(v).ok?`${csv(v.deviceId)},${v.sequence},${v.timestamp},${v.temperatureC}`:'';}\n''')
        self.assertTrue(verify_task("telemetry", self.root)["pass"])

    def test_scene(self):
        (self.root / "scene3d.mjs").write_text('''export function cuboidVertices(cx,cy,cz,w,h,d){const o=[];for(const x of [-.5,.5])for(const y of [-.5,.5])for(const z of [-.5,.5])o.push([cx+x*w,cy+y*h,cz+z*d]);return o;}\nexport function projectPoint(x,y,z,c={}){const width=c.width||800,height=c.height||600,zoom=c.zoom??1,near=c.near??1;const depth=z+near;return {x:width/2+x*zoom,y:height/2-y*zoom,depth};}\nexport function projectCuboid(cx,cy,cz,w,h,d,c={}){const vertices=cuboidVertices(cx,cy,cz,w,h,d).map(v=>({x:v[0],y:v[1],z:v[2],...projectPoint(v[0],v[1],v[2],c)}));const faces=[[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]].map(f=>({f,d:f.reduce((s,i)=>s+vertices[i].depth,0)/4})).sort((a,b)=>b.d-a.d).map(x=>x.f);return {vertices,faces};}''')
        self.assertTrue(verify_task("scene3d", self.root)["pass"])

    @unittest.skipUnless(shutil.which("g++"), "g++ unavailable")
    def test_esp32(self):
        (self.root / "esp32_controller.ino").write_text('''#include <Arduino.h>\n#include <OneWire.h>\n#include <DallasTemperature.h>\nOneWire wire(4); DallasTemperature sensors(&wire); bool led=false; unsigned long lastLed=0,lastSensor=0;\nvoid setup(){pinMode(2,OUTPUT);pinMode(0,INPUT_PULLUP);Serial.begin(115200);sensors.begin();}\nvoid loop(){unsigned long now=millis();if(now-lastLed>=500){lastLed=now;led=!led;digitalWrite(2,led);}if(now-lastSensor>=2000){lastSensor=now;sensors.requestTemperatures();Serial.println(sensors.getTempCByIndex(0));}}\n''')
        result = verify_task("esp32", self.root)
        self.assertTrue(result["pass"], result["summary"])


if __name__ == "__main__":
    unittest.main()
