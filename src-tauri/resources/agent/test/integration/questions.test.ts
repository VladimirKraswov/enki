// Structured questions: a real `question` tool in the Enki extension, durable
// question.asked / question.replied / question.rejected events, bounded answers,
// cancellation, deny rules, and pending questions counted by authoritative idle.
// Asking a question never creates a permission request or grant.
import path from "node:path";
import fs from 'node:fs';
import { afterEach, expect, it } from "vitest";
import { InteractionBroker } from "../../src/interaction/broker.ts";
import { fauxAssistantMessage, fauxToolCall } from "../../src/sdk/testing.ts";
import { Database } from "../../src/store/db.ts";
import { EventJournal } from "../../src/store/events.ts";
import { AttachmentStore } from '../../src/store/attachments.ts';
import { questionTool } from '../../src/extensions/enki.ts';
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

it('a question reply delivers real image/text blocks to the waiting tool and persists file references before ACK', async () => {
  const root = tempDir('question-files'), db = new Database(path.join(root, 'runtime.sqlite'));
  const journal = new EventJournal(db), files = new AttachmentStore(db, root), b = new InteractionBroker(db, journal, undefined, files);
  const tool = questionTool({sessionID:'s-files', directory:'/p'}, b);
  const result = tool.execute('q-files', {questions:[{question:'Покажите образец'}]}, undefined);
  const id = b.pendingQuestions()[0].id;
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6V8AAAAASUVORK5CYII=';
  const parts = [
    {type:'file',mime:'image/png',filename:'образец.png',url:`data:image/png;base64,${image}`},
    {type:'file',mime:'text/plain',filename:'заметки.txt',url:`data:text/plain;base64,${Buffer.from('Тёплые цвета').toString('base64')}`},
  ];
  expect(b.replyQuestion(id, [['Вот образец']], '/other', parts)).toBe(false);
  expect(() => b.replyQuestion(id, [['Вот образец']], '/p', [{...parts[0],url:'https://untrusted.invalid/picture'}])).toThrow(/подготовлено|вложения/);
  expect(b.pendingQuestions()).toHaveLength(1);
  expect(b.replyQuestion(id, [['Вот образец']], '/p', parts)).toBe(true);
  const answer = await result;
  expect(answer.content).toContainEqual({type:'image',data:image,mimeType:'image/png'});
  expect(answer.content.some(p => p.type==='text' && p.text.includes('Тёплые цвета') && p.text.includes('unsupported_as_instructions'))).toBe(true);
  const refs = answer.details.attachments!;
  expect(refs).toHaveLength(2);
  const events = journal.replay({directory:'/p'}, 0)!;
  const replied = events.find(e => e.event.type==='question.replied')!;
  expect(replied.event.properties.attachments).toEqual(refs);
  expect(JSON.stringify(replied)).not.toContain(image); // journal/SSE carries metadata, not binary blobs
  db.close();
  const reopened = new Database(path.join(root, 'runtime.sqlite'));
  expect(new AttachmentStore(reopened, root).dataUrl(refs[0].id)).toBe(parts[0].url);
  const reopenedFiles = new AttachmentStore(reopened, root), other = reopenedFiles.put(parts[0].url, 'shared.png', 'question:other-session');
  const reopenedBroker = new InteractionBroker(reopened, new EventJournal(reopened), undefined, reopenedFiles);
  reopenedBroker.forgetSession('s-files');
  expect(()=>reopenedFiles.dataUrl(refs[0].id)).toThrow(/не найдено/);
  expect(reopenedFiles.dataUrl(other.id)).toBe(parts[0].url);
  reopened.close();
});

it('the real SDK resumes the same turn with the attached image in its tool result', async () => {
  h = await harness(); const dir = h.project('question-image'), sid = await newSession(h, dir);
  const events = stream(h, `directory=${encodeURIComponent(dir)}`); await events.hello;
  h.scripted.setResponses([
    fauxAssistantMessage([fauxToolCall('question',{questions:[{question:'Пришлите образец'}]})],{stopReason:'toolUse'}),
    fauxAssistantMessage('Образец получен'),
  ]);
  await h.command(promptCommand(h, 'question-image', sid, dir, 'Уточни образец', h.model('vision')));
  const asked = await events.waitFor(e => e.event.type==='question.asked');
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6V8AAAAASUVORK5CYII=';
  expect((await h.request('POST', `/questions/${asked.event.properties.id}/reply?directory=${encodeURIComponent(dir)}`, {
    answers:[['Вот образец']],parts:[{type:'file',mime:'image/png',filename:'sample.png',url:`data:image/png;base64,${image}`}],
  })).status).toBe(204);
  expect((await h.waitReceipt('question-image',['completed'])).state).toBe('completed');
  const entries = fs.readFileSync(h.runtime.catalog.get(sid)!.sessionFile!, 'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const results = entries.filter(entry=>entry.type==='message' && entry.message?.role==='toolResult');
  expect(results.some(entry=>entry.message.content.some((part:{type:string;data?:string})=>part.type==='image' && part.data===image))).toBe(true);
  expect(entries.filter(entry=>entry.type==='message' && entry.message?.role==='user')).toHaveLength(1);
  events.close();
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
