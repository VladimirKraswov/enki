// Independent invariants of the live browser session module, re-homed from
// test/browser-session.test.ts (whose OpenCode plugin cases are retired with
// resources/browser/opencode-session-plugin.mjs; the SDK path is covered by
// test/pi-browser.test.ts "does not accept model-supplied browser ownership or
// full access" / "full access comes only from the session access mode" and
// agent test/browser-access.test.ts). Written, NOT RUN.
import {expect,it} from "vitest";
import {browserSession,sessionKey,stripSession} from "../src-tauri/resources/browser/session.mjs";

it("SDK session metadata is removed before the official tool, preserving unrelated metadata",()=>{
 const input={name:"browser_snapshot",arguments:{},_meta:{arvelaSession:{engine:"pi",sessionID:"pi_session"},other:"keep"}};
 expect(stripSession(input)).toEqual({session:{engine:"pi",sessionID:"pi_session"},params:{name:"browser_snapshot",arguments:{},_meta:{other:"keep"}}});
 // The caller's object is not mutated.
 expect(input._meta.arvelaSession).toEqual({engine:"pi",sessionID:"pi_session"});
});
it("keeps engines, projects and chats independent and rejects invalid identity",()=>{
 const keys=[sessionKey("/a",{engine:"pi",sessionID:"same"}),sessionKey("/b",{engine:"pi",sessionID:"same"}),sessionKey("/a",{engine:"opencode",sessionID:"same"}),sessionKey("/a",{engine:"pi",sessionID:"other"})];
 expect(new Set(keys).size).toBe(4);
 for(const identity of [null,[],{}, {engine:"remote",sessionID:"a"},{engine:"pi",sessionID:"../a"},{engine:"pi",sessionID:""}]) expect(()=>browserSession(identity)).toThrow();
});
