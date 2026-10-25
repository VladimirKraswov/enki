// Loaded with `--import` BEFORE any real-SDK suite module (run-node-suites.mjs).
// A connection is allowed ONLY to a listener this harness owns and that is
// still live: a loopback TCP port or an IPC path that some guarded process of
// this run is currently listening on. Any other loopback port (an owner
// service), any expired fixture port (a pool reconnecting after close), any
// foreign IPC path and every non-loopback address or DNS lookup is refused AND
// recorded; run-node-suites.mjs fails the gate on any recorded refusal.
// Ownership is shared across this run's processes through a registry inside
// the private ENKI_SDK_HARNESS_ROOT; Node children spawned by a suite get this
// same guard injected. Owner paths are redirected by the runner's private HOME.
import childProcess from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const SELF = import.meta.url;
const harness = process.env.ENKI_SDK_HARNESS_ROOT;
const registry = harness ? path.join(harness, "guard", "listeners") : null;
const deniedLog = harness ? path.join(harness, "guard", "denied.log") : null;
if (registry) fs.mkdirSync(registry, { recursive: true, mode: 0o700 });

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);
const loopback = (host) => host === undefined || host === null || host === "" || LOOPBACK.has(String(host).toLowerCase());
const key = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex");
const live = new Set();

function record(what) {
  if (deniedLog) try { fs.appendFileSync(deniedLog, `${JSON.stringify({ pid: process.pid, what, stack: new Error().stack?.split("\n").slice(2, 8) })}\n`, { mode: 0o600 }); } catch { /* the throw below still refuses */ }
}
function refuse(what) {
  record(what);
  throw Object.assign(new Error(`ENKI_TEST_NETWORK_BLOCKED: ${what}`), { code: "ENKI_TEST_NETWORK_BLOCKED" });
}
/** Live in this process, or registered by a still-running guarded process of this run. */
function owned(endpoint) {
  if (live.has(endpoint) || !registry) return live.has(endpoint);
  const file = path.join(registry, key(endpoint));
  let entry;
  try { entry = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (entry.endpoint !== endpoint || !Number.isSafeInteger(entry.pid)) return false;
  try { process.kill(entry.pid, 0); return true; } // existence probe only; no signal is delivered
  catch (error) { if (error.code === "EPERM") return false; try { fs.unlinkSync(file); } catch { /* raced */ } return false; }
}
function register(endpoint) {
  live.add(endpoint);
  if (registry) fs.writeFileSync(path.join(registry, key(endpoint)), JSON.stringify({ endpoint, pid: process.pid }), { mode: 0o600 });
}
function unregister(endpoint) {
  live.delete(endpoint);
  if (registry) try { fs.unlinkSync(path.join(registry, key(endpoint))); } catch { /* already gone */ }
}

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
  this.once("listening", () => {
    const address = this.address();
    const endpoint = typeof address === "string" ? `ipc:${address}` : address && `tcp:${address.port}`;
    if (!endpoint) return;
    register(endpoint);
    this.once("close", () => unregister(endpoint));
  });
  return listen.apply(this, args);
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first !== null && typeof first === "object" ? first : typeof first === "string" && Number.isNaN(Number(first)) ? { path: first } : { port: first, host: args[1] };
  if (options.path) { if (!owned(`ipc:${options.path}`)) refuse(`ipc ${options.path}`); }
  else if (!loopback(options.host)) refuse(`${options.host}:${options.port}`);
  else if (!owned(`tcp:${Number(options.port)}`)) refuse(`unowned or closed loopback port ${options.port}`);
  return connect.apply(this, args);
};

for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  const original = dns[name];
  dns[name] = (host, ...rest) => (loopback(host) ? original(host, ...rest) : refuse(`dns ${host}`));
}
const promises = dns.promises, lookup = promises.lookup;
promises.lookup = (host, ...rest) => {
  if (loopback(host)) return lookup(host, ...rest);
  try { refuse(`dns ${host}`); } catch (error) { return Promise.reject(error); }
};

// A Node child started by a suite (crash fixtures, daemon launches) runs under
// this same guard; its environment keeps the harness root for the registry.
const injected = (args) => (args.includes(SELF) ? args : ["--import", SELF, ...args]);
const isNode = (command) => typeof command === "string" && path.resolve(command) === process.execPath;
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedChild(command, args, ...rest) {
    return isNode(command) && Array.isArray(args) ? original.call(this, command, injected(args), ...rest) : original.call(this, command, args, ...rest);
  };
}
// ESM named imports of node:dns / node:child_process see the guarded functions too.
syncBuiltinESMExports();

const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!loopback(url.hostname)) {
    try { refuse(url.origin); } catch (error) { return Promise.reject(error); }
  }
  return fetch(input, init); // the socket connect above still requires an owned live port
};
