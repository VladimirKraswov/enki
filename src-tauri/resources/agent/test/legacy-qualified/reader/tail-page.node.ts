import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures.ts";
import { archiveWireId } from "../../../src/legacy/wire-projection.ts";

for (const [file, session] of [["v1.sql", "ses_fixture_main"], ["v2.sql", "ses_fixture_v2"]] as const) {
  test(`${file}: tail pages equal full history with namespaced cursors and no duplicates`, t => {
    const reader = fixture(t, file).open(), expected = reader.messages(session);
    const cursorId = (id: string) => archiveWireId("message", "outer-session", id);
    let before: string | undefined;
    const pages = [];
    do {
      const page = reader.historyPage(session, 2, before, cursorId);
      assert.ok(page.messages.length > 0 && page.messages.length <= 2);
      pages.unshift(...page.messages); before = page.before;
    } while (before);
    assert.deepEqual(pages, expected);
    assert.deepEqual(reader.historyPage(session, 2, "foreign-cursor", cursorId), { messages: [] });
    assert.deepEqual(reader.historyPage(session, 1000).messages, expected);
  });

  test(`${file}: reading the tail does not decode an older payload; full validation still refuses it`, t => {
    const table = file === "v1.sql" ? "message" : "session_message";
    const reader = fixture(t, file, db => {
      const key = file === "v1.sql" ? "time_created" : "seq";
      const row = db.prepare(`SELECT id FROM ${table} WHERE session_id=? ORDER BY ${key},id LIMIT 1`).get(session);
      assert.ok(row);
      db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run("{old-unread-payload", row.id!);
    }).open();
    const tail = reader.historyPage(session, 2);
    assert.equal(tail.messages.length, 2);
    assert.ok(tail.before);
    assert.throws(() => reader.messages(session), /JSON|архив/i);
    assert.ok([...reader.validationIssues()].some(issue => issue.code === "JSON_INVALID"));
    assert.throws(() => reader.historyPage(session, 1000), /JSON|архив/i);
  });
}

test("V1 equal timestamps retain the id tie-break across tail cursors", t => {
  const reader = fixture(t, "v1.sql", db => {
    db.prepare("UPDATE message SET time_created=1 WHERE session_id=?").run("ses_fixture_main");
  }).open();
  const all = reader.messages("ses_fixture_main");
  const tail = reader.historyPage("ses_fixture_main", 3);
  const prior = reader.historyPage("ses_fixture_main", 3, tail.before);
  assert.deepEqual([...prior.messages, ...tail.messages], all);
  assert.equal(prior.before, undefined);
});
