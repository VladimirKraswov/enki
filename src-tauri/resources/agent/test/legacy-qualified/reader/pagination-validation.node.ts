// Source-only pagination/whole-archive validation checks. NOT EXECUTED.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures.ts";

test("strict page iteration preserves V1 and V2 order across small page boundaries", t => {
  for (const [file, sessionID] of [["v1.sql", "ses_fixture_main"], ["v2.sql", "ses_fixture_v2"]] as const) {
    const archive = fixture(t, file).open();
    const pages = [...archive.messagePages(sessionID, { pageSize: 2 })];
    assert.ok(pages.length > 1);
    assert.ok(pages.every(page => page.length > 0 && page.length <= 2));
    assert.deepEqual(pages.flat(), archive.messages(sessionID));
  }
});

test("whole archive validation inspects corrupt V1 shadows even when V2 chat is readable", t => {
  const archive = fixture(t, "v2.sql", db => {
    db.prepare("UPDATE message SET data=? WHERE id=?").run("{broken-shadow", "msg_fixture_v2_shadow");
  }).open();
  assert.equal(archive.messages("ses_fixture_v2").length, 6,
    "corrupt nonauthoritative shadow is never a fallback transcript");
  const issues = [...archive.validationIssues()];
  assert.ok(issues.some(issue => issue.code === "JSON_INVALID" && issue.table === "message" && issue.rowId === "msg_fixture_v2_shadow"));
  assert.ok(archive.validate().some(issue => issue.severity === "error" && issue.rowId === "msg_fixture_v2_shadow"),
    "the importer must reject a complete-success manifest for a corrupt raw archive");
  assert.equal(archive.details("ses_fixture_v2").v1Shadow.messages[0].json.data.raw, "{broken-shadow");
});

test("unknown SQL blob and int64 fields are losslessly available without unsafe numeric coercion", t => {
  const bytes = Buffer.from([0, 255, 13, 10]);
  const archive = fixture(t, "v1.sql", db => {
    db.exec("ALTER TABLE session ADD COLUMN future_blob BLOB");
    db.exec("ALTER TABLE session ADD COLUMN future_integer INTEGER");
    db.prepare("UPDATE session SET future_blob=?,future_integer=? WHERE id=?")
      .run(bytes, 9223372036854775807n, "ses_fixture_main");
  }).open();
  const raw = archive.details("ses_fixture_main").record.row;
  assert.deepEqual(raw.future_blob, { encoding: "base64", value: bytes.toString("base64") });
  assert.deepEqual(raw.future_integer, { encoding: "int64", value: "9223372036854775807" });
  assert.doesNotThrow(() => JSON.stringify(raw));
});

test("a corrupt later page is an explicit failure rather than a truncated successful transcript", t => {
  const archive = fixture(t, "v2.sql", db => {
    db.prepare("UPDATE session_message SET data=? WHERE id=?").run("{late-corruption", "msg_fixture_v2_100");
  }).open();
  const iterator = archive.messagePages("ses_fixture_v2", { pageSize: 2 });
  const first = iterator.next(), second = iterator.next();
  if (first.done || second.done) throw new Error("Fixture must have at least two pages before the corrupt row");
  assert.equal(first.value.length, 2);
  assert.equal(second.value.length, 2);
  assert.throws(() => iterator.next(), /msg_fixture_v2_100|JSON|архив/i);
  assert.throws(() => archive.messages("ses_fixture_v2"), /msg_fixture_v2_100|JSON|архив/i);
});
