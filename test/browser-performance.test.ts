import { expect, it } from "vitest";
import { browserPerformance,currentTurnPerformance } from "../src/browser/performance";
import { browserDefaultEffort,browserEfforts,browserTaskKey } from "../src/browser/task";
import { emptySessionChat } from "../src/state/chatReducer";
it("does not fabricate metrics from absent or malformed data", () => {
  expect(browserPerformance(null)).toBeNull(); expect(browserPerformance({calls:"2"})).toBeNull();
  expect(currentTurnPerformance()).toBeNull(); expect(currentTurnPerformance(emptySessionChat())).toBeNull();
});
it("uses only the current loaded turn and unions overlapping tool intervals", () => {
  const c = emptySessionChat(); c.messageOrder=["old","u","a"];
  c.messages.old={id:"old",sessionID:"s",role:"assistant",time:{created:0,completed:9000},tokens:{output:900}};
  c.messages.u={id:"u",sessionID:"s",role:"user",time:{created:10000}};
  c.messages.a={id:"a",sessionID:"s",role:"assistant",time:{created:11000,completed:20000},tokens:{output:100,reasoning:20}};
  c.partsByMessage.a=["t1","t2","r"];
  c.parts.t1={id:"t1",sessionID:"s",messageID:"a",type:"tool",state:{status:"completed",time:{start:12000,end:15000}}};
  c.parts.t2={id:"t2",sessionID:"s",messageID:"a",type:"tool",state:{status:"error",time:{start:14000,end:17000}}};
  c.parts.r={id:"r",sessionID:"s",messageID:"a",type:"reasoning",time:{start:11000,end:12000}};
  expect(currentTurnPerformance(c)).toEqual({wallMs:10000,toolMs:5000,reasoningMs:1000,calls:2,failed:1,output:100,reasoning:20});
  delete c.messages.a.time.completed; expect(currentTurnPerformance(c)?.wallMs).toBeNull();
});
// Variants are the thinking levels the runtime publishes per model (already
// filtered by the SDK); the window offers exactly those and invents none.
it("never invents a model variant and scopes browser profiles to server, engine and chat", () => {
  expect(browserDefaultEffort(["medium"])).toBeNull(); expect(browserDefaultEffort(["low","medium"])).toBe("low");
  expect(browserDefaultEffort([])).toBeNull(); expect(browserDefaultEffort(["low","medium"],"medium")).toBe("medium");
  expect(browserEfforts(undefined)).toEqual([]); expect(browserEfforts(null)).toEqual([]); expect(browserEfforts({})).toEqual([]);
  expect(browserEfforts({low:{},medium:{},high:{}})).toEqual(["low","medium","high"]);
  expect(browserEfforts({low:{},medium:{}})).not.toContain("xhigh");
  expect(browserEfforts({medium:{}})).not.toContain("low");
  expect(browserTaskKey("s","pi","a")).not.toBe(browserTaskKey("other","pi","a"));
  expect(browserTaskKey("s","pi","a")).not.toBe(browserTaskKey("s","pi","b"));
  expect(browserTaskKey("s","pi","a")).not.toBe(browserTaskKey("s","opencode","a"));
});
