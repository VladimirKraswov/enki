-- SYNTHETIC FIXTURE ONLY. Never apply to an owner database.
-- OpenCode 1.18.18 / 31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d.
-- Includes one V1 shadow row: preserve/archive it, NEVER merge into V2 transcript.
-- V2 row.data omits top-level type/id; those live in SQL columns.
BEGIN;
CREATE TABLE project (
  id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
  icon_url TEXT, icon_url_override TEXT, icon_color TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
  path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  summary_diffs TEXT, metadata TEXT, cost REAL NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0, revert TEXT, permission TEXT,
  agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_compacting INTEGER, time_archived INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE session_message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  type TEXT NOT NULL, seq INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE session_input (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL, delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL,
  promoted_seq INTEGER, time_created INTEGER NOT NULL
);
CREATE TABLE session_context_epoch (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  baseline TEXT NOT NULL, snapshot TEXT NOT NULL, baseline_seq INTEGER NOT NULL
);
CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
CREATE INDEX part_message_id_id_idx ON part(message_id,id);
CREATE INDEX part_session_idx ON part(session_id);
CREATE INDEX session_project_idx ON session(project_id);
CREATE INDEX session_workspace_idx ON session(workspace_id);
CREATE INDEX session_parent_idx ON session(parent_id);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);
CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id,type,seq);
CREATE INDEX session_message_session_time_created_id_idx ON session_message(session_id,time_created,id);
CREATE INDEX session_message_time_created_idx ON session_message(time_created);
CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input(session_id,promoted_seq,delivery,admitted_seq);
CREATE UNIQUE INDEX session_input_session_admitted_seq_idx ON session_input(session_id,admitted_seq);
CREATE UNIQUE INDEX session_input_session_promoted_seq_idx ON session_input(session_id,promoted_seq);

INSERT INTO project(id,worktree,vcs,name,time_created,time_updated,sandboxes) VALUES
 ('fixture-v2','/enki-fixtures/v2','git','Synthetic V2',1767225600000,1767225606000,'[]');
INSERT INTO session(id,project_id,slug,directory,title,version,metadata,time_created,time_updated) VALUES
 ('ses_fixture_v2','fixture-v2','fixture-v2','/enki-fixtures/v2','V2: seq важнее случайного ID','1.18.18','{"fixture":true,"originHost":"fixture-mac"}',1767225600000,1767225606000);

INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES
 ('msg_fixture_v2_shadow','ses_fixture_v2',1767225600000,1767225600000,'{"role":"user","time":{"created":1767225600000},"agent":"fixture-agent","model":{"providerID":"fixture-provider","modelID":"fixture-model"}}');
INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES
 ('prt_fixture_v2_shadow','msg_fixture_v2_shadow','ses_fixture_v2',1767225600000,1767225600000,'{"type":"text","text":"V1_SHADOW_DO_NOT_MERGE"}');

-- IDs deliberately decrease while seq increases; times of first two rows are equal.
INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES
 ('msg_fixture_v2_900','ses_fixture_v2','user',10,1767225601000,1767225601000,'{"time":{"created":1767225601000},"text":"V2_USER_MARKER: сохранить вложение.","files":[{"uri":"data:text/plain;base64,Zml4dHVyZS1vbmx5Cg==","mime":"text/plain","name":"v2-fixture.txt"}]}'),
 ('msg_fixture_v2_800','ses_fixture_v2','assistant',11,1767225601000,1767225602000,'{"time":{"created":1767225601000,"completed":1767225602000},"agent":"fixture-agent","model":{"id":"fixture-model","providerID":"fixture-provider"},"content":[{"type":"text","id":"v2_text_1","text":"V2_ASSISTANT_MARKER"}],"finish":"stop","cost":0.01,"tokens":{"input":9,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}'),
 ('msg_fixture_v2_700','ses_fixture_v2','compaction',20,1767225603000,1767225603000,'{"time":{"created":1767225603000},"reason":"manual","summary":"V2_SUMMARY_MARKER: исходные данные остаются в архиве.","recent":"V2_RECENT_MARKER: не повторять инструменты."}'),
 ('msg_fixture_v2_600','ses_fixture_v2','user',21,1767225604000,1767225604000,'{"time":{"created":1767225604000},"text":"V2_KEPT_TAIL_MARKER"}'),
 ('msg_fixture_v2_500','ses_fixture_v2','shell',22,1767225605000,1767225605000,'{"time":{"created":1767225605000,"completed":1767225605000},"callID":"call_v2_shell_fixture","command":"NEVER_REPLAY_SHELL_FIXTURE","output":"SYNTHETIC_RECORDED_SHELL_OUTPUT"}'),
 ('msg_fixture_v2_100','ses_fixture_v2','assistant',23,1767225606000,1767225606000,'{"time":{"created":1767225606000,"completed":1767225606000},"agent":"fixture-agent","model":{"id":"fixture-model","providerID":"fixture-provider","variant":"medium"},"content":[{"type":"text","id":"v2_text_2","text":"V2_LATEST_MARKER: seq=23, не лексикографически максимальный ID."}],"finish":"stop","cost":0,"tokens":{"input":3,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}');

INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created) VALUES
 ('msg_fixture_v2_900','ses_fixture_v2','{"text":"V2_USER_MARKER: сохранить вложение.","files":[{"uri":"data:text/plain;base64,Zml4dHVyZS1vbmx5Cg==","mime":"text/plain","name":"v2-fixture.txt"}]}','queue',9,10,1767225601000),
 ('msg_fixture_v2_pending','ses_fixture_v2','{"text":"NEVER_REPLAY_PENDING_INPUT","files":[{"uri":"file:///C:/Synthetic/Enki/pending-only.txt","mime":"text/plain","name":"foreign-pending-only.txt"}]}','queue',24,NULL,1767225607000);

INSERT INTO session_context_epoch(session_id,baseline,snapshot,baseline_seq) VALUES
 ('ses_fixture_v2','SYNTHETIC_LEGACY_BASELINE_NOT_AUTOMATIC_RUNTIME_AUTHORITY','{"fixture/context":{"value":{"fixture":true,"originHost":"fixture-mac"},"removed":"SYNTHETIC_REMOVAL_NOTICE"}}',9);
COMMIT;
