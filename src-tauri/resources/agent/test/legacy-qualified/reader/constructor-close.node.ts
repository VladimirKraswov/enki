// Typed connection-port fault injection. No experimental module mocks or SQLite execution.
// Source-only revision: the coordinator runs qualification separately.
import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeArchiveReader, type ReadonlySqliteConnection, type ReadonlySqliteOptions } from "../../../src/legacy/opencode-reader.ts";

test("constructor closes the opened read-only connection when schema discovery throws", () => {
  const file = "test-owned-constructor-failure.sqlite";
  const opened: Array<{ file: string; options: ReadonlySqliteOptions }> = [];
  const setup: string[] = [];
  const failure = new Error("SYNTHETIC_SCHEMA_DISCOVERY_FAILURE");
  let closeCount = 0;
  const connection: ReadonlySqliteConnection = {
    exec(sql): void { setup.push(sql); },
    prepare(): never { throw failure; },
    close(): void { closeCount += 1; },
  };
  assert.throws(() => new OpenCodeArchiveReader(file, {
    connect(selectedFile, options) {
      opened.push({ file: selectedFile, options });
      return connection;
    },
  }), (error: unknown) => error === failure, "cleanup must retain the original schema-discovery error");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].file, file);
  assert.deepEqual(opened[0].options, { readOnly: true, enableForeignKeyConstraints: false });
  assert.deepEqual(setup, ["PRAGMA query_only=ON; BEGIN DEFERRED"]);
  assert.equal(closeCount, 1, "failed constructor must not leak or double-close its SQLite connection");
});
