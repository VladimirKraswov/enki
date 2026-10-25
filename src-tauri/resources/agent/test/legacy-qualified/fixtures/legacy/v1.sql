-- SYNTHETIC FIXTURE ONLY. Never apply to an owner database.
-- OpenCode 1.18.18 / 31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d.
-- Physical table/column subset follows packages/core/src/{session,project}/sql.ts.
-- Not a copy of the complete engine database or its migration ledger.
-- Top-level message/part IDs deliberately live ONLY in SQL columns.
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
CREATE TABLE todo (
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  content TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, position INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  PRIMARY KEY(session_id, position)
);
CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
CREATE INDEX part_message_id_id_idx ON part(message_id,id);
CREATE INDEX part_session_idx ON part(session_id);
CREATE INDEX session_project_idx ON session(project_id);
CREATE INDEX session_workspace_idx ON session(workspace_id);
CREATE INDEX session_parent_idx ON session(parent_id);
CREATE INDEX todo_session_idx ON todo(session_id);

INSERT INTO project(id,worktree,vcs,name,time_created,time_updated,sandboxes,commands) VALUES
 ('fixture-local','/enki-fixtures/local','git','Синтетический проект',1767225600000,1767225610000,'[]','{"start":"NEVER_RUN_PROJECT_COMMAND"}'),
 ('fixture-windows','C:/Synthetic/Enki/demo','git','Foreign Windows fixture',1767225600000,1767225610000,'["C:/Synthetic/Enki/worktree"]',NULL);

INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,metadata,agent,model,time_created,time_updated,time_archived,revert) VALUES
 ('ses_fixture_main','fixture-local',NULL,'fixture-main','/enki-fixtures/local','Основная — Ёж и 日本語','1.18.18','{"fixture":true,"originHost":"fixture-mac"}','fixture-agent','{"id":"fixture-model","providerID":"fixture-provider","variant":"medium"}',1767225600000,1767225606000,NULL,'{"messageID":"msg_fixture_060","partID":"prt_fixture_060_pending","snapshot":"synthetic-snapshot-only"}'),
 ('ses_fixture_branch','fixture-local','ses_fixture_main','fixture-branch','/enki-fixtures/local','Архивная ветка','1.18.18','{"fixture":true,"branchPoint":"msg_fixture_010"}','fixture-agent','{"id":"fixture-model","providerID":"fixture-provider"}',1767225607000,1767225608000,1767225609000,NULL),
 ('ses_fixture_windows','fixture-windows',NULL,'fixture-foreign','C:/Synthetic/Enki/demo','Не локальный cwd на Mac','1.18.18','{"fixture":true,"originHost":"fixture-windows"}','fixture-agent','{"id":"fixture-model","providerID":"fixture-provider"}',1767225609000,1767225609000,NULL,NULL);

-- Same timestamp on the first two messages: require deterministic SQL ordering.
INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES
 ('msg_fixture_010','ses_fixture_main',1767225601000,1767225601000,'{"role":"user","time":{"created":1767225601000},"agent":"fixture-agent","model":{"providerID":"fixture-provider","modelID":"fixture-model","variant":"medium"}}'),
 ('msg_fixture_020','ses_fixture_main',1767225601000,1767225602000,'{"role":"assistant","time":{"created":1767225601000,"completed":1767225602000},"parentID":"msg_fixture_010","modelID":"fixture-model","providerID":"fixture-provider","mode":"build","agent":"fixture-agent","path":{"cwd":"/enki-fixtures/local","root":"/enki-fixtures/local"},"cost":0.125,"tokens":{"total":19,"input":10,"output":7,"reasoning":2,"cache":{"read":1,"write":1}},"finish":"tool-calls"}'),
 ('msg_fixture_030','ses_fixture_main',1767225603000,1767225603000,'{"role":"user","time":{"created":1767225603000},"agent":"fixture-agent","model":{"providerID":"fixture-provider","modelID":"fixture-model"}}'),
 ('msg_fixture_040','ses_fixture_main',1767225604000,1767225604000,'{"role":"assistant","time":{"created":1767225604000,"completed":1767225604000},"parentID":"msg_fixture_030","modelID":"fixture-model","providerID":"fixture-provider","mode":"compaction","agent":"fixture-agent","path":{"cwd":"/enki-fixtures/local","root":"/enki-fixtures/local"},"summary":true,"cost":0.025,"tokens":{"input":100,"output":12,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'),
 ('msg_fixture_050','ses_fixture_main',1767225605000,1767225605000,'{"role":"user","time":{"created":1767225605000},"agent":"fixture-agent","model":{"providerID":"fixture-provider","modelID":"fixture-model"}}'),
 ('msg_fixture_060','ses_fixture_main',1767225606000,1767225606000,'{"role":"assistant","time":{"created":1767225606000},"parentID":"msg_fixture_050","modelID":"fixture-model","providerID":"fixture-provider","mode":"build","agent":"fixture-agent","path":{"cwd":"/enki-fixtures/local","root":"/enki-fixtures/local"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}'),
 ('msg_fixture_070','ses_fixture_branch',1767225607000,1767225607000,'{"role":"user","time":{"created":1767225607000},"agent":"fixture-agent","model":{"providerID":"fixture-provider","modelID":"fixture-model"}}'),
 ('msg_fixture_080','ses_fixture_branch',1767225608000,1767225608000,'{"role":"assistant","time":{"created":1767225608000,"completed":1767225608000},"parentID":"msg_fixture_070","modelID":"fixture-model","providerID":"fixture-provider","mode":"build","agent":"fixture-agent","path":{"cwd":"/enki-fixtures/local","root":"/enki-fixtures/local"},"cost":0,"tokens":{"input":2,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'),
 ('msg_fixture_090','ses_fixture_windows',1767225609000,1767225609000,'{"role":"user","time":{"created":1767225609000},"agent":"fixture-agent","model":{"providerID":"fixture-provider","modelID":"fixture-model"}}');

INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES
 ('prt_fixture_010_text','msg_fixture_010','ses_fixture_main',1767225601000,1767225601000,'{"type":"text","text":"Сохрани Unicode: Ёж, 日本語, 🦔. Проверь вложение."}'),
 ('prt_fixture_010_file','msg_fixture_010','ses_fixture_main',1767225601000,1767225601000,'{"type":"file","mime":"text/plain","filename":"fixture-only.txt","url":"data:text/plain;base64,Zml4dHVyZS1vbmx5Cg=="}'),
 ('prt_fixture_010_ignored','msg_fixture_010','ses_fixture_main',1767225601000,1767225601000,'{"type":"text","text":"IGNORED_SYNTHETIC_MARKER","synthetic":true,"ignored":true,"metadata":{"fixture":true}}'),
 ('prt_fixture_020_reasoning','msg_fixture_020','ses_fixture_main',1767225601000,1767225602000,'{"type":"reasoning","text":"Synthetic recorded reasoning, not a new instruction.","time":{"start":1767225601000,"end":1767225602000}}'),
 ('prt_fixture_020_completed','msg_fixture_020','ses_fixture_main',1767225601000,1767225602000,'{"type":"tool","callID":"call_fixture_completed","tool":"fixture_read","state":{"status":"completed","input":{"path":"/enki-fixtures/local/fixture-only.txt"},"output":"fixture-only\n","title":"Synthetic read","metadata":{"fixture":true},"time":{"start":1767225601100,"end":1767225601200},"attachments":[{"id":"prt_fixture_tool_attachment","messageID":"msg_fixture_020","sessionID":"ses_fixture_main","type":"file","mime":"text/plain","filename":"tool-result.txt","url":"data:text/plain;base64,Zml4dHVyZS1vbmx5Cg=="}]}}'),
 ('prt_fixture_020_error','msg_fixture_020','ses_fixture_main',1767225601000,1767225602000,'{"type":"tool","callID":"call_fixture_error","tool":"fixture_fail","state":{"status":"error","input":{"fixture":true},"error":"SYNTHETIC_TOOL_FAILURE","metadata":{"fixture":true},"time":{"start":1767225601200,"end":1767225601300}}}'),
 ('prt_fixture_020_text','msg_fixture_020','ses_fixture_main',1767225601000,1767225602000,'{"type":"text","text":"Один инструмент завершён, второй вернул синтетическую ошибку."}'),
 ('prt_fixture_020_finish','msg_fixture_020','ses_fixture_main',1767225601000,1767225602000,'{"type":"step-finish","reason":"tool-calls","cost":0.125,"tokens":{"total":19,"input":10,"output":7,"reasoning":2,"cache":{"read":1,"write":1}}}'),
 ('prt_fixture_030_text','msg_fixture_030','ses_fixture_main',1767225603000,1767225603000,'{"type":"text","text":"Сожми уже завершённую часть истории."}'),
 ('prt_fixture_030_compaction','msg_fixture_030','ses_fixture_main',1767225603000,1767225603000,'{"type":"compaction","auto":false,"tail_start_id":"msg_fixture_010"}'),
 ('prt_fixture_040_summary','msg_fixture_040','ses_fixture_main',1767225604000,1767225604000,'{"type":"text","text":"SUMMARY_MARKER: сохранено вложение; completed/error результаты уже существуют; исходную историю не удалять."}'),
 ('prt_fixture_050_text','msg_fixture_050','ses_fixture_main',1767225605000,1767225605000,'{"type":"text","text":"KEPT_TAIL_MARKER: продолжи без повторения инструментов."}'),
 ('prt_fixture_060_pending','msg_fixture_060','ses_fixture_main',1767225606000,1767225606000,'{"type":"tool","callID":"call_fixture_pending","tool":"fixture_write","state":{"status":"pending","input":{"path":"/enki-fixtures/local/NEVER_CREATE_FROM_IMPORT.txt","text":"NEVER_REPLAY_PENDING_TOOL"},"raw":"{\"fixture\":true}"}}'),
 ('prt_fixture_070_text','msg_fixture_070','ses_fixture_branch',1767225607000,1767225607000,'{"type":"text","text":"BRANCH_ONLY_MARKER: отдельная архивная ветка."}'),
 ('prt_fixture_080_text','msg_fixture_080','ses_fixture_branch',1767225608000,1767225608000,'{"type":"text","text":"BRANCH_REPLY_MARKER"}'),
 ('prt_fixture_090_text','msg_fixture_090','ses_fixture_windows',1767225609000,1767225609000,'{"type":"text","text":"FOREIGN_PATH_MARKER: не открывать этот путь локально на Mac."}'),
 ('prt_fixture_090_file','msg_fixture_090','ses_fixture_windows',1767225609000,1767225609000,'{"type":"file","mime":"text/plain","filename":"foreign-only.txt","url":"file:///C:/Synthetic/Enki/foreign-only.txt"}');

INSERT INTO todo(session_id,content,status,priority,position,time_created,time_updated) VALUES
 ('ses_fixture_main','SYNTHETIC_TODO_DO_NOT_EXECUTE','pending','medium',0,1767225600000,1767225600000);
COMMIT;
