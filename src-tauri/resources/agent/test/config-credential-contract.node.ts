// Port of the independent CredentialStore contract regressions against the
// actual public Pi SDK 0.85.1 (sdk-reference/enki-tasks/config-credential-contract.node.ts).
// FakeAuthority is ONLY the TS broker contract model; not native/Keychain proof.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createModels, InMemoryCredentialStore, fauxProvider, type CredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import type { Broker, BrokerMethod } from "../src/control/broker.ts";
import { CredentialConflict, VaultCredentialStore } from "../src/models/credentials.ts";
import { FakeAuthority } from "./config-authority-fake.ts";

const HOME = process.env.HOME;
const provider = "private-oauth";
const expired: OAuthCredential = { type: "oauth", access: "fixture-expired-access", refresh: "fixture-expired-refresh", expires: 1 };
const fresh: OAuthCredential = { type: "oauth", access: "fixture-fresh-access", refresh: "fixture-fresh-refresh", expires: Date.now() + 3_600_000 };

function vault(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enki-credential-contract-"));
  const broker = new FakeAuthority(dir);
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); assert.equal(process.env.HOME, HOME); });
  return { broker, store: new VaultCredentialStore(broker), other: new VaultCredentialStore(broker) };
}
const casCount = (broker: FakeAuthority) => broker.calls.filter(c => c.method === "vault.compareAndSet").length;

test("actual public InMemoryCredentialStore: undefined means unchanged and returns the post-write current entry", async () => {
  const store = new InMemoryCredentialStore();
  await store.modify(provider, async () => expired);
  const result = await store.modify(provider, async () => undefined);
  assert.deepEqual(result, expired);
  assert.deepEqual(await store.read(provider), expired);
});

test("VaultCredentialStore preserves the public undefined-is-unchanged contract", async t => {
  const f = vault(t);
  await f.store.modify(provider, async () => expired);
  const before = casCount(f.broker), revision = f.broker.credentials.get(provider)?.revision;
  const result = await f.store.modify(provider, async () => undefined);
  assert.deepEqual(result, expired, "modify(undefined) must return existing credential");
  assert.deepEqual(await f.store.read(provider), expired, "callback undefined is not logout");
  assert.equal(casCount(f.broker), before, "a no-change callback must not create a tombstone");
  assert.equal(f.broker.credentials.get(provider)?.revision, revision);
});

async function oauthDoubleCheck(store: CredentialStore, other: CredentialStore) {
  await store.modify(provider, async () => expired);
  let callbackCalls = 0, refreshes = 0;
  const raced: CredentialStore = {
    read: (id, options) => store.read(id, options),
    list: options => store.list(options),
    delete: (id, options) => store.delete(id, options),
    modify: async (id, fn, options) => {
      // Deterministic cross-client race: SDK's optimistic read saw expired, but a
      // second client committed fresh data before the serialized callback begins.
      await other.modify(id, async () => fresh);
      return store.modify(id, async current => { callbackCalls++; return fn(current); }, options);
    },
  };
  const models = createModels({ credentials: raced, authContext: { env: async () => undefined, fileExists: async () => false } });
  const faux = fauxProvider({ provider, models: [{ id: "private-model", contextWindow: 8192, maxTokens: 64 }] });
  models.setProvider({ ...faux.provider, auth: { oauth: { name: "Private OAuth fixture", login: async () => { throw Error("No login authorized"); }, refresh: async () => { refreshes++; return fresh; }, toAuth: async credential => ({ apiKey: credential.access }) } } });
  const result = await models.getAuth(provider);
  return { result, stored: await store.read(provider), refreshes, callbackCalls };
}

test("actual public Models OAuth double-check baseline adopts another client fresh token without refreshing", async () => {
  const store = new InMemoryCredentialStore();
  const result = await oauthDoubleCheck(store, store);
  assert.equal(result.refreshes, 0);
  assert.equal(result.callbackCalls, 1);
  assert.equal(result.result?.auth.apiKey, fresh.access);
  assert.deepEqual(result.stored, fresh);
});

test("actual public Models OAuth double-check with VaultCredentialStore does not log out the fresh token", async t => {
  const f = vault(t);
  const result = await oauthDoubleCheck(f.store, f.other);
  assert.equal(result.refreshes, 0);
  assert.equal(result.callbackCalls, 1);
  assert.equal(result.result?.auth.apiKey, fresh.access, "SDK double-check returning undefined must preserve and use fresher committed OAuth credential");
  assert.deepEqual(result.stored, fresh);
  assert.equal(f.broker.credentials.get(provider)?.revision, 2, "no tombstone revision after the double-check");
});

test("modify(undefined) on an empty store resolves undefined and writes nothing", async t => {
  const f = vault(t);
  assert.equal(await f.store.modify(provider, async () => undefined), undefined);
  assert.equal(casCount(f.broker), 0);
  assert.equal(f.broker.credentials.has(provider), false);
});

test("delete is its own serialized CAS tombstone; deleting nothing writes nothing", async t => {
  const f = vault(t);
  await f.store.delete(provider);
  assert.equal(casCount(f.broker), 0, "nothing stored: no tombstone");
  await f.store.modify(provider, async () => fresh);
  // Serialized with modify on the same store: the queued delete observes the write.
  const write = f.store.modify(provider, async () => expired);
  const removal = f.store.delete(provider);
  await write; await removal;
  assert.deepEqual(f.broker.credentials.get(provider), { revision: 3, account: null });
  assert.equal(await f.store.read(provider), undefined);
  const deletes = f.broker.calls.filter(c => c.method === "vault.compareAndSet" && JSON.parse(c.frame).params.value === null);
  assert.equal(deletes.length, 1, "exactly one null CAS");
  assert.deepEqual(await f.store.list(), []);
});

test("delete racing a newer cross-client write is a conflict and never erases the newer credential", async t => {
  const f = vault(t);
  await f.store.modify(provider, async () => expired);
  let raced = false;
  const racing: Broker = {
    kind: "supervisor", available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      if (method === "vault.compareAndSet" && params.value === null && !raced) { raced = true; await f.other.modify(provider, async () => fresh); }
      return f.broker.call<T>(method, params, signal);
    },
  };
  await assert.rejects(new VaultCredentialStore(racing).delete(provider), (e: unknown) => e instanceof CredentialConflict);
  assert.deepEqual(await f.store.read(provider), fresh);
});

test("lost delete ACK is retried with the same operation id and the full null payload", async t => {
  const f = vault(t);
  await f.store.modify(provider, async () => fresh);
  f.broker.loseAck.add("vault.compareAndSet");
  await f.store.delete(provider);
  const frames = f.broker.calls.filter(c => c.method === "vault.compareAndSet").slice(-2).map(c => JSON.parse(c.frame).params);
  assert.equal(frames[0].operationId, frames[1].operationId);
  assert.deepEqual([frames[0].value, frames[1].value], [null, null]);
  assert.deepEqual(f.broker.credentials.get(provider), { revision: 2, account: null }, "one tombstone revision");
});

test("fake broker contract: a reused CAS operation id with a changed value or null is CONFIG_OPERATION_CONFLICT", async t => {
  const f = vault(t);
  const cas = (value: string | null) => f.broker.call("vault.compareAndSet", { operationId: "cas-0000000000000001", providerId: provider, expectedRevision: 0, value });
  assert.deepEqual(await cas("A"), { revision: 1 });
  assert.deepEqual(await cas("A"), { revision: 1 }, "identical retry returns the original receipt");
  await assert.rejects(cas("B"), /CONFIG_OPERATION_CONFLICT/);
  await assert.rejects(cas(null), /CONFIG_OPERATION_CONFLICT/);
});

test("actual SDK parallel provider auth across stores does not overflow the native broker", async () => {
  let active = 0, maximum = 0;
  const seen: string[] = [];
  const broker: Broker = {
    kind: "supervisor", available: () => true,
    async call<T>(method: BrokerMethod, params: Record<string, unknown>): Promise<T> {
      assert.equal(method, "vault.credentialRead");
      active++; maximum = Math.max(maximum, active);
      try {
        if (active > 4) throw Error("native broker capacity exceeded");
        await Promise.resolve();
        const id = String(params.providerId); seen.push(id);
        return { value: JSON.stringify({ type: "api_key", key: `fixture-${id}` }), revision: 1 } as T;
      } finally { active--; }
    },
  };
  const models = [new VaultCredentialStore(broker), new VaultCredentialStore(broker)].map(credentials =>
    createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } }));
  const ids = Array.from({ length: 100 }, (_, i) => `burst-${i}`);
  for (const id of ids) {
    const faux = fauxProvider({ provider: id, models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 64 }] });
    for (const collection of models) collection.setProvider({ ...faux.provider, auth: { apiKey: {
      name: "Fixture credential", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "fixture" } : undefined,
    } } });
  }
  const results = await Promise.all(ids.map((id, i) => models[i % 2].getAuth(id)));
  assert.deepEqual(results.map(r => r?.auth.apiKey), ids.map(id => `fixture-${id}`));
  assert.equal(seen.length, ids.length);
  assert.ok(maximum <= 4, "all auth reads must fit the existing native capacity");
});
