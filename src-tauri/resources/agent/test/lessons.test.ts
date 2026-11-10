import path from "node:path";
import { expect, it } from "vitest";
import { LessonStore, LESSONS_PER_DIRECTORY } from "../src/store/lessons.ts";
import { Database } from "../src/store/db.ts";
import { tempDir } from "./helpers.ts";

it("keeps short lessons per directory, newest first, and rejects an empty one", () => {
  const db = new Database(path.join(tempDir("lessons"), "runtime.db"));
  const store = new LessonStore(db);
  expect(() => store.add("/p", "   ")).toThrow(/Пустой урок/);
  const first = store.add("/p", "  Не   повторяй\nпереход по несуществующему пути  ");
  expect(first.text).toBe("Не повторяй переход по несуществующему пути");
  store.add("/p", "Второй урок");
  store.add("/other", "Другой проект");
  expect(store.list("/p").map(l => l.text)).toEqual(["Второй урок", first.text]);
  expect(store.list("/other").map(l => l.text)).toEqual(["Другой проект"]);
  db.close();
});

it("is bounded per directory and keeps only the newest lessons", () => {
  const db = new Database(path.join(tempDir("lessons"), "runtime.db"));
  const store = new LessonStore(db);
  for (let i = 0; i < LESSONS_PER_DIRECTORY + 5; i++) store.add("/p", `Урок ${i}`);
  const all = store.list("/p", 100);
  expect(all).toHaveLength(LESSONS_PER_DIRECTORY);
  expect(all[0].text).toBe(`Урок ${LESSONS_PER_DIRECTORY + 4}`);
  expect(all.at(-1)!.text).toBe("Урок 5");
  db.close();
});
