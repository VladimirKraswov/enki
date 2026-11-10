// Self-improvement without rewriting production prompts: the agent records a
// short lesson after a corrected mistake, and later turns of the same directory
// see a few of them. Bounded, durable, advisory text — never new authority.
import { randomUUID } from "node:crypto";
import { integer, text, type Database } from "./db.ts";

export interface Lesson { id: string; directory: string; text: string; created: number }

export const LESSON_LIMIT = 500;
export const LESSONS_PER_DIRECTORY = 50;
export const LESSONS_IN_PROMPT = 5;

export class LessonStore {
  constructor(private readonly db: Database) {
    this.db.run("CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY, directory TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL)");
    this.db.run("CREATE INDEX IF NOT EXISTS lessons_dir ON lessons(directory, created)");
  }

  add(directory: string, value: string): Lesson {
    const clean = value.trim().replace(/\s+/g, " ").slice(0, LESSON_LIMIT);
    if (!clean) throw new Error("Пустой урок не сохраняется.");
    const lesson: Lesson = { id: randomUUID(), directory, text: clean, created: Date.now() };
    this.db.run("INSERT INTO lessons(id,directory,text,created) VALUES(?,?,?,?)", lesson.id, directory, lesson.text, lesson.created);
    // Bounded per directory: the oldest drop out.
    this.db.run("DELETE FROM lessons WHERE directory=? AND id NOT IN (SELECT id FROM lessons WHERE directory=? ORDER BY created DESC LIMIT ?)",
      directory, directory, LESSONS_PER_DIRECTORY);
    return lesson;
  }

  list(directory: string, limit = LESSONS_IN_PROMPT): Lesson[] {
    return this.db.all("SELECT id,directory,text,created FROM lessons WHERE directory=? ORDER BY created DESC LIMIT ?", directory, limit)
      .map(row => ({ id: text(row, "id"), directory, text: text(row, "text"), created: integer(row, "created") }));
  }
}
