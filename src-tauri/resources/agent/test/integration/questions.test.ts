// Structured questions: a real `question` tool in the Enki extension, durable
// question.asked / question.replied / question.rejected events, bounded answers,
// cancellation, deny rules, and pending questions counted by authoritative idle.
// Asking a question never creates a permission request or grant.
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { InteractionBroker } from "../../src/interaction/broker.ts";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import type { EventEnvelope } from "../../src/protocol.ts";
import { harness, newSession, promptCommand, stream, tempDir, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => { const current = h; h = undefined; await current?.stop(); });

function broker(deadlineMs?: number) {
  const db = new Database(path.join(tempDir("questions"), "runtime.sqlite"));
  const journal = new EventJournal(db);
  return { db, journal, broker: new InteractionBroker(db, journal, deadlineMs) };
}
const QUESTIONS = [
  { question: "Which region?", header: "Region", options: [{ label: "eu" }, { label: "us" }], custom: false },
  { question: "Release tag?", header: "Tag" },
];

it("validates answers, settles once and journals the decision", async () => {
  const { db, broker: b } = broker();
  const answer = b.askQuestion({ sessionID: "s1", directory: "/p", questions: QUESTIONS, callID: "call-1" });
  const [pending] = b.pendingQuestions("/p");
  expect(pending).toMatchObject({ sessionID: "s1", tool: { callID: "call-1" } });
  expect(b.hasPending("s1")).toBe(true);
  expect(b.pendingQuestions("/other")).toEqual([]);
  expect(() => b.replyQuestion(pending.id, [["asia"], ["v1"]])).toThrow(/отсутствует/);
  expect(() => b.replyQuestion(pending.id, [["eu"]])).toThrow(/каждый/);
  expect(() => b.replyQuestion(pending.id, [["eu", "us"], ["v1"]])).toThrow(/Слишком много/);
  expect(b.replyQuestion(pending.id, [["eu"], ["v1"]], "/elsewhere")).toBe(false);
  expect(b.replyQuestion(pending.id, [["eu"], ["v1.2"]], "/p")).toBe(true);
  expect(await answer).toEqual({ answers: [["eu"], ["v1.2"]] });
  expect(b.replyQuestion(pending.id, [["eu"], ["v1.2"]])).toBe(false);
  expect(b.hasPending("s1")).toBe(false);
  // A question never leaves a permission grant behind.
  expect(b.grants("s1")).toEqual([]);
  db.close();
});

it("rejects malformed questions, expires at the deadline and cancels with the turn", async () => {
  const { db, broker: b } = broker(50);
  await expect(b.askQuestion({ sessionID: "s", directory: "/p", questions: [] })).rejects.toThrow(/от 1 до 8/);
  await expect(b.askQuestion({ sessionID: "s", directory: "/p", questions: [{ question: "x", options: [{ label: "a" }, { label: "a" }] }] })).rejects.toThrow(/вариант/);
  expect(await b.askQuestion({ sessionID: "s", directory: "/p", questions: QUESTIONS })).toEqual({ rejected: true });
  const abort = new AbortController();
  const cancelled = b.askQuestion({ sessionID: "s", directory: "/p", questions: QUESTIONS, signal: abort.signal });
  abort.abort();
  expect(await cancelled).toEqual({ rejected: true });
  const rejected = b.askQuestion({ sessionID: "s", directory: "/p", questions: QUESTIONS });
  expect(b.rejectQuestion(b.pendingQuestions()[0].id)).toBe(true);
  expect(await rejected).toEqual({ rejected: true });
  db.close();
});

it("the agent asks through the question tool without a permission prompt; idle waits for the answer", async () => {
  h = await harness();
  const dir = h.project("question");
  // Default policy is "ask": an ordinary unknown tool would prompt. Questions must not.
  const sid = await newSession(h, dir);
  const client = stream(h, `directory=${encodeURIComponent(dir)}`);
  await client.hello;
  h.scripted.setResponses([
    fauxAssistantMessage([fauxToolCall("question", { questions: QUESTIONS })], { stopReason: "toolUse" }),
    fauxAssistantMessage("thanks"),
  ]);
  await h.command(promptCommand(h, "q-1", sid, dir, "ask me"));
  const asked = await client.waitFor(e => e.event.type === "question.asked");
  const id = String(asked.event.properties.id);
  expect(asked.event.properties).toMatchObject({ sessionID: sid, directory: dir });
  expect((await h.request<{ questions: boolean }>("GET", "/capabilities")).body.questions).toBe(true);
  expect((await h.request<Array<{ id: string }>>("GET", `/questions?directory=${encodeURIComponent(dir)}`)).body.map(q => q.id)).toEqual([id]);
  const idle = await h.request<{ idle: boolean; questions: number }>("GET", "/runtime/idle");
  expect(idle.body).toMatchObject({ idle: false, questions: 1 });
  expect((await h.request("POST", `/questions/${id}/reply`, { answers: [["mars"], ["v1"]] })).status).toBe(400);
  expect((await h.request("POST", `/questions/${id}/reply`, { answers: [["us"], ["v1"]] })).status).toBe(204);
  await h.waitReceipt("q-1", ["completed"]);
  // Durable before the receipt; SSE delivery can trail HTTP polling, so await it.
  const isReplied = (e: EventEnvelope) => e.event.type === "question.replied" && e.event.properties.requestID === id;
  const replied = await client.waitFor(isReplied);
  expect(replied.event.properties).toMatchObject({ sessionID: sid, answers: [["us"], ["v1"]] });
  expect(client.events.filter(isReplied)).toHaveLength(1);
  const replay = stream(h, `directory=${encodeURIComponent(dir)}&after=${replied.seq - 1}`);
  await replay.hello;
  expect((await replay.waitFor(e => e.seq === replied.seq)).event).toEqual(replied.event);
  expect(replay.events.filter(isReplied)).toHaveLength(1);
  replay.close();
  expect(client.events.some(e => e.event.type === "permission.asked")).toBe(false);
  expect((await h.request("POST", `/questions/${id}/reply`, { answers: [["us"], ["v1"]] })).status).toBe(404);
  client.close();
});

it("an explicit deny rule still forbids asking", async () => {
  h = await harness();
  const dir = h.project("question-deny");
  const sid = await newSession(h, dir, { permission: [{ permission: "question", pattern: "*", action: "deny" }] });
  const client = stream(h, `directory=${encodeURIComponent(dir)}`);
  await client.hello;
  h.scripted.setResponses([
    fauxAssistantMessage([fauxToolCall("question", { questions: QUESTIONS })], { stopReason: "toolUse" }),
    fauxAssistantMessage("ok"),
  ]);
  await h.command(promptCommand(h, "q-2", sid, dir, "ask me"));
  await h.waitReceipt("q-2", ["completed"]);
  expect(client.events.some(e => e.event.type === "question.asked")).toBe(false);
  expect(client.events.some(e => e.event.type === "permission.asked")).toBe(false);
  client.close();
});
