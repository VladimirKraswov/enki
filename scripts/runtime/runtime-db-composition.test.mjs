// Installer + ACTUAL runtime data composition: runtimePaths/DATA_LAYOUT
// (runtime.sqlite, never the backup name state.sqlite), the real schema from
// store/db.ts with commands/events/queue/schedules rows, and Pi SDK JSONL
// session files through the paired snapshot. Lifecycle is the in-memory port of
// remote-fixture.mjs; no daemon, SDK, model or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { installRemote } from './install-remote.mjs';
import { CURRENT_SCHEMA, REPO, artifact, hasJournal, setup } from './remote-fixture.mjs';

const { runtimePaths, DATA_LAYOUT } = await import(pathToFileURL(path.join(REPO, 'src-tauri/resources/agent/src/platform/paths.ts')).href);
const { Database } = await import(pathToFileURL(path.join(REPO, 'src-tauri/resources/agent/src/store/db.ts')).href);
const KEY = '0123456789abcdef', FILE = '2026-10-25T00-00-00-000Z_session.jsonl';
const NEXT = [{ sdk: '0.85.1', node: '24.22.1' }, { sdk: '0.86.0', node: '24.22.1' }];
const live = s => { fs.mkdirSync(s.base.data, { recursive: true, mode: 0o700 }); return runtimePaths(fs.realpathSync(s.base.data)); };
const transcript = (s, name = FILE) => path.join(live(s).sessions, KEY, name);
function seed(file, id) {
  const db = new DatabaseSync(file);
  try {
    db.prepare("INSERT INTO commands(id,kind,session_id,directory,payload_hash,state,created,updated) VALUES(?,'prompt','s1','/p','h','done',1,1)").run(`command-${id}`);
    db.prepare("INSERT INTO events(time,session_id,type,payload) VALUES(1,'s1',?,'{}')").run(`event-${id}`);
    db.prepare("INSERT INTO queue(id,session_id,directory,position,text,model,state,queued_at) VALUES(?,'s1','/p',1,'next','m','queued',1)").run(`queue-${id}`);
    db.prepare("INSERT INTO schedules(id,session_id,directory,body) VALUES(?,'s1','/p','{}')").run(`timer-${id}`);
  } finally { db.close(); }
}
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Object.fromEntries(['commands', 'events', 'queue', 'schedules'].map(table => [table, db.prepare(`SELECT ${table === 'events' ? 'type' : 'id'} AS k FROM ${table} ORDER BY 1`).all().map(row => row.k)])); }
  finally { db.close(); }
}
const tables = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name); } finally { db.close(); } };
const preserved = (s, prefix) => fs.readdirSync(fs.realpathSync(s.base.data)).filter(name => name.startsWith(prefix)).map(name => path.join(fs.realpathSync(s.base.data), name));

test('the installer uses the runtime LIVE layout, not the backup filename', t => {
  const s = setup(t);
  assert.equal(DATA_LAYOUT.database, 'runtime.sqlite');
  assert.equal(path.basename(live(s).db), DATA_LAYOUT.database);
  assert.equal(path.basename(live(s).sessions), DATA_LAYOUT.sessions);
});

test('existing actual runtime data without an authenticated previous runtime is never treated as fresh', async t => {
  const s = setup(t); new Database(live(s).db).close(); seed(live(s).db, 'user');
  await assert.rejects(installRemote(s.v1), /explicit adoption/);
  assert.deepEqual(rows(live(s).db).commands, ['command-user'], 'untouched'); assert.equal(hasJournal(s), false);
  const s2 = setup(t); fs.mkdirSync(path.dirname(transcript(s2)), { recursive: true }); fs.writeFileSync(transcript(s2), '{"type":"session"}\n');
  await assert.rejects(installRemote(s2.v1), /explicit adoption/, 'a session transcript alone is live data too');
});

test('first-install candidate crash quarantines the actual database and sessions, then retries cleanly', async t => {
  const s = setup(t);
  s.daemon.onLaunch = data => { seed(runtimePaths(data).db, 'candidate'); fs.mkdirSync(path.join(runtimePaths(data).sessions, KEY), { recursive: true }); fs.writeFileSync(path.join(runtimePaths(data).sessions, KEY, FILE), 'candidate\n'); };
  s.daemon.dieAfterData = true;
  await assert.rejects(installRemote(s.v1), /not fully confirmed/);
  assert.deepEqual(await installRemote(s.v1), { version: '0.85.1-1111111111111111', changed: true });
  const [aside] = preserved(s, 'failed-first-install-');
  assert.deepEqual(rows(path.join(aside, 'runtime.sqlite')).commands, ['command-candidate']);
  assert.equal(fs.readFileSync(path.join(aside, 'sessions', KEY, FILE), 'utf8'), 'candidate\n');
  assert.deepEqual(rows(live(s).db).commands, [], 'retry starts from fresh actual data');
  assert.equal(fs.existsSync(transcript(s)), false); assert.equal(fs.existsSync(path.join(live(s).data, 'state.sqlite')), false);
});

test('candidate crash after an update restores the exact paired runtime.sqlite rows and JSONL bytes', async t => {
  const s = setup(t); await installRemote(s.v1);
  seed(live(s).db, 'before'); fs.mkdirSync(path.dirname(transcript(s)), { recursive: true }); fs.writeFileSync(transcript(s), '{"type":"session","id":"a"}\n{"type":"message"}\n');
  const original = fs.readFileSync(transcript(s));
  s.daemon.onLaunch = data => {
    const db = new DatabaseSync(runtimePaths(data).db); try { db.exec('CREATE TABLE candidate_only(x)'); } finally { db.close(); }
    seed(runtimePaths(data).db, 'candidate'); fs.appendFileSync(path.join(runtimePaths(data).sessions, KEY, FILE), '{"type":"migrated-by-candidate"}\n');
    fs.writeFileSync(path.join(runtimePaths(data).sessions, KEY, 'new.jsonl'), 'candidate-only\n');
  };
  s.daemon.dieAfterData = true;
  await assert.rejects(installRemote(s.v2), /not fully confirmed/);
  assert.equal((await installRemote(s.v2)).changed, true, 'recovery rolls back, then the update completes');
  assert.ok(!tables(live(s).db).includes('candidate_only'), 'candidate-only table is gone from the LIVE database');
  assert.deepEqual(rows(live(s).db), { commands: ['command-before'], events: ['event-before'], queue: ['queue-before'], schedules: ['timer-before'] });
  assert.deepEqual(fs.readFileSync(transcript(s)), original, 'exact JSONL bytes');
  assert.equal(fs.existsSync(transcript(s, 'new.jsonl')), false);
  const [aside] = preserved(s, 'failed-update-');
  assert.ok(tables(path.join(aside, 'runtime.sqlite')).includes('candidate_only'), 'candidate data preserved aside, never deleted');
  assert.equal(fs.readFileSync(path.join(aside, 'sessions', KEY, 'new.jsonl'), 'utf8'), 'candidate-only\n');
});

test('cross-SDK update and explicit rollback go through the exact paired DB + JSONL snapshot', async t => {
  const s = setup(t), next = { ...s.base, ...artifact(s.root, '3333333333333333', { sdk: '0.86.0' }), qualifiedRuntimes: NEXT };
  await installRemote({ ...s.v1, qualifiedRuntimes: NEXT });
  seed(live(s).db, 'old'); fs.mkdirSync(path.dirname(transcript(s)), { recursive: true }); fs.writeFileSync(transcript(s), '{"v":"old-sdk"}\n');
  const original = fs.readFileSync(transcript(s));
  assert.equal((await installRemote(next)).changed, true);
  seed(live(s).db, 'new'); fs.appendFileSync(transcript(s), '{"v":"new-sdk"}\n');
  const rollback = { ...s.base, rollback: true, qualifiedRuntimes: NEXT };
  await assert.rejects(installRemote(rollback), /--restore-paired-data/);
  assert.equal(s.daemon.running.sdk, '0.86.0', 'refusal changed nothing');
  assert.deepEqual(await installRemote({ ...rollback, restoreDataBackup: true }), { version: '0.85.1-1111111111111111', changed: true });
  assert.equal(s.daemon.running.sdk, '0.85.1');
  assert.deepEqual(rows(live(s).db).commands, ['command-old']); assert.deepEqual(fs.readFileSync(transcript(s)), original);
  const [aside] = preserved(s, 'failed-update-');
  assert.deepEqual(rows(path.join(aside, 'runtime.sqlite')).commands, ['command-new', 'command-old'], 'newer work preserved aside');
  assert.match(fs.readFileSync(path.join(aside, 'sessions', KEY, FILE), 'utf8'), /new-sdk/);
});

test('artifact metadata must advertise the actual store schema: a stale dataSchema pairs no backup', async t => {
  // Regression: protocol SCHEMA_VERSION moved to 3 while runtime-lock/build
  // metadata still said 2. The real Database user_version is authoritative and
  // verifyBackup stays fail-closed; the fixture default now derives from it.
  const probe = setup(t); new Database(live(probe).db).close();
  const db = new DatabaseSync(live(probe).db, { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA, 'fixture metadata matches the real schema'); } finally { db.close(); }
  const s = setup(t), stale = { ...s.base, ...artifact(s.root, '4444444444444444', { dataSchema: CURRENT_SCHEMA - 1 }) };
  await installRemote(stale); seed(live(s).db, 'kept');
  await assert.rejects(installRemote(s.v2));
  assert.equal(s.daemon.running?.version, '4444444444444444', 'the previous runtime keeps serving');
  assert.deepEqual(rows(live(s).db).commands, ['command-kept'], 'live data untouched');
  assert.ok(!s.daemon.log.some(([kind, value]) => kind === 'launch' && value === '2222222222222222'), 'the candidate never launched');
});

test('a DB-only receipt can never authorize an SDK change, and a tampered snapshot is never restored', async t => {
  const s = setup(t), next = { ...s.base, ...artifact(s.root, '3333333333333333', { sdk: '0.86.0' }), qualifiedRuntimes: NEXT };
  await installRemote({ ...s.v1, qualifiedRuntimes: NEXT }); s.daemon.dbOnlyBackup = true;
  await assert.rejects(installRemote(next), error => error.code === 'ENKI_UPDATE_REFUSED' && /paired session snapshot/.test(error.message));
  assert.equal(hasJournal(s), false); assert.equal(s.daemon.running.sdk, '0.85.1'); assert.equal(s.daemon.held, null, 'its fence was released');
  const s2 = setup(t); await installRemote(s2.v1); fs.mkdirSync(path.dirname(transcript(s2)), { recursive: true }); fs.writeFileSync(transcript(s2), 'x\n');
  s2.daemon.onLaunch = data => { const backups = path.join(data, 'update-backups'); for (const id of fs.readdirSync(backups)) fs.writeFileSync(path.join(backups, id, 'sessions', KEY, FILE), 'tampered\n'); };
  s2.daemon.dieAfterData = true;
  await assert.rejects(installRemote(s2.v2), /not fully confirmed/);
  await assert.rejects(installRemote(s2.v2), /snapshot integrity failed/, 'recovery refuses unauthenticated transcript bytes');
  assert.ok(hasJournal(s2), 'journal retained for an explicit operator decision');
});
