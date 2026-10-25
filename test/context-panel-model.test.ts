import { expect, it } from "vitest";
import { linkedPath, projectFile, safeLabel, sessionContext, sessionSources, subagentRuns } from "../src/state/taskContext";
import { emptySessionChat } from "../src/state/chatReducer";
it("uses actual source attachments and completed outputs, deduplicates paths and ignores incomplete writes", () => {
 const chat=emptySessionChat(); chat.messageOrder=["u","a"];
 chat.messages.u={id:"u",sessionID:"s",role:"user",time:{created:1}};
 chat.messages.a={id:"a",sessionID:"s",role:"assistant",time:{created:2}};
 chat.partsByMessage={u:["f"],a:["w","t","r","x"]};
 chat.parts={f:{id:"f",messageID:"u",sessionID:"s",type:"file",filename:"source.pdf",mime:"application/pdf"},
 w:{id:"w",messageID:"a",sessionID:"s",type:"tool",tool:"write",state:{status:"completed",input:{filePath:"/project/report.md"}}},
 t:{id:"t",messageID:"a",sessionID:"s",type:"text",text:"[Report](/project/report.md) [Other](https://example.com)"},
 r:{id:"r",messageID:"a",sessionID:"s",type:"tool",tool:"write",state:{status:"running",input:{filePath:"/project/pending.txt"}}},
 x:{id:"x",messageID:"a",sessionID:"s",type:"file",filename:"assistant.json"}};
 const context=sessionContext(chat);expect(context.sources.map(x=>x.name)).toEqual(["source.pdf"]);expect(context.results.map(x=>x.path)).toEqual(["/project/report.md"]);
 // The attachment viewer's user-only projection is exactly the same source list.
 expect(sessionSources(chat)).toEqual(context.sources);expect(sessionSources()).toEqual([]);
});
it("never previews traversal, sibling directories or unrelated absolute files through the project API",()=>{
 expect(projectFile("../private/key","/project")).toBeNull();expect(projectFile("/project-other/key","/project")).toBeNull();
 expect(projectFile("src/main.ts","/project")).toBe("src/main.ts");expect(projectFile("C:\\Work\\src\\a.ts","C:\\Work")).toBe("src/a.ts");
});
it("does not manufacture context for an empty or unloaded chat",()=>expect(sessionContext()).toEqual({sources:[],results:[]}));
it("orders results by latest mention, keeps provenance and accepts file URLs with line anchors",()=>{
 const chat=emptySessionChat();chat.messageOrder=["a1","a2"];
 chat.messages.a1={id:"a1",sessionID:"s",role:"assistant",time:{created:1}};chat.messages.a2={id:"a2",sessionID:"s",role:"assistant",time:{created:2}};
 chat.partsByMessage={a1:["e","l"],a2:["l2"]};
 chat.parts={e:{id:"e",messageID:"a1",sessionID:"s",type:"tool",tool:"edit",state:{status:"completed",input:{filePath:"/p/a.ts"}}},
 l:{id:"l",messageID:"a1",sessionID:"s",type:"text",text:"[b](/p/b.md:12:3) [w](file:///C:/Work/c%20d.txt#L4-L9)"},
 l2:{id:"l2",messageID:"a2",sessionID:"s",type:"text",text:"See [a](/p/a.ts#L3)"}};
 const {results}=sessionContext(chat);
 expect(results.map(r=>r.path)).toEqual(["/p/a.ts","C:/Work/c d.txt","/p/b.md"]);
 expect(results[0]).toMatchObject({messageID:"a2",origin:"link"});expect(results.find(r=>r.path==="/p/b.md")?.origin).toBe("link");
});
it("labels only task-reported child sessions as subagents",()=>{
 const chat=emptySessionChat();chat.messageOrder=["a"];chat.messages.a={id:"a",sessionID:"s",role:"assistant",time:{created:1}};chat.partsByMessage={a:["t"]};
 chat.parts={t:{id:"t",messageID:"a",sessionID:"s",type:"tool",tool:"task",state:{status:"error",metadata:{sessionId:"child"}}}};
 expect([...subagentRuns(chat).values()]).toEqual([{sessionID:"child",messageID:"a",status:"error"}]);expect(subagentRuns().size).toBe(0);
});
it("renders control and bidirectional characters inertly and bounds long names",()=>{
 const rlo=String.fromCharCode(0x202e);
 expect(safeLabel(`evil${rlo}txt.exe`)).toBe(`evil${String.fromCharCode(0xfffd)}txt.exe`);expect(safeLabel("a\nb")).not.toContain("\n");
 expect(safeLabel("x".repeat(500)).length).toBe(200);expect(safeLabel("   ")).toBe("Без имени");
 expect(linkedPath("https://example.com/a")).toBeNull();expect(linkedPath("relative/a.md")).toBeNull();
});
