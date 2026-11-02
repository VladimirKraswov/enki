import { expect, it } from "vitest";
import { contextUsage } from "../src/state/context";
import { emptySessionChat } from "../src/state/chatReducer";
const model = {
  id: "qwen",
  providerID: "local",
  limit: { context: 131072, input: 114688, output: 16384 },
};
it("uses the SDK window reserve once and cache-aware last-turn usage without summing history", () => {
  const chat = emptySessionChat();
  chat.messageOrder = ["a", "b"];
  chat.messages = {
    a: {
      id: "a",
      sessionID: "s",
      role: "assistant",
      time: { created: 1 },
      tokens: { total: 90000 },
    },
    b: {
      id: "b",
      sessionID: "s",
      role: "assistant",
      time: { created: 2 },
      tokens: {
        input: 50000,
        output: 2000,
        reasoning: 1800,
        cache: { read: 10000, write: 1000 },
      },
    },
  };
  expect(contextUsage(chat, model, { reserved: 32768 })).toMatchObject({
    used: 63000,
    // limit.input belonged to the retired engine. Do not subtract its output
    // reserve a second time; SDK compaction uses contextWindow - reserve.
    threshold: 98304,
    remaining: 35304,
    limit: 131072,
    auto: true,
  });
  chat.messages.b = {
    ...chat.messages.b,
    role: "assistant",
    tokens: { total: 98304, input: 60000, output: 5000 },
  };
  expect(contextUsage(chat, model, { reserved: 32768 })).toMatchObject({
    used: 98304,
    remaining: 0,
  });
});
it("has an honest unknown count before first usage and reflects disabled compaction", () => {
  expect(contextUsage(undefined, model, { auto: false })).toMatchObject({
    used: null,
    remaining: null,
    auto: false,
  });
});
it("uses completed compacted-turn usage and detects in-flight compaction", () => {
  const chat = emptySessionChat();
  chat.messageOrder = ["a"];
  chat.messages.a = {
    id: "a",
    sessionID: "s",
    role: "assistant",
    summary: true,
    time: { created: 1 },
    tokens: { total: 1000 },
  };
  expect(contextUsage(chat, model).compacting).toBe(true);
  chat.messages.a.time.completed = 2;
  expect(contextUsage(chat, model).compacting).toBe(false);
});
it("does not report a previous model's token usage against the newly selected model's context", () => {
  const chat = emptySessionChat();
  chat.messageOrder = ["a"];
  chat.messages.a = {
    id: "a",
    sessionID: "s",
    role: "assistant",
    modelID: "flash",
    providerID: "local-qwen-next",
    time: { created: 1, completed: 2 },
    tokens: { total: 100000 },
  };
  expect(contextUsage(chat, { ...model, id: "qwen27", providerID: "local-qwen38" })).toMatchObject({
    used: null,
    measuredModel: undefined,
  });
});

it('does not display the old summarization input as the new compacted context',()=>{
 const chat=emptySessionChat();chat.messageOrder=['summary'];
 chat.messages.summary={id:'summary',sessionID:'s',role:'assistant',summary:true,finish:'stop',modelID:'qwen',providerID:'local',time:{created:1,completed:2},tokens:{total:415589,input:414589,output:1000}};
 expect(contextUsage(chat,model)).toMatchObject({used:null,remaining:null,compacting:false});
});
