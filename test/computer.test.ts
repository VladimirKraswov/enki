import {expect,it} from "vitest";
import {computerReadinessError,isLocalComputer,type ComputerStatus} from "../src/state/computer";
import {COMPUTER_SERVER,reservedEntry} from "../src/capabilities/reserved";
const status:ComputerStatus={installed:true,enabled:false,version:"fixture",command:"/Applications/OpenCode Desktop.app/Contents/MacOS/opencode-desktop",skillPath:"/Users/fixture/.local/share/opencode-desktop/computer/skill",permissions:{}};
it("never treats an MCP transport connection as ready after driver revocation",()=>{
  expect(computerReadinessError({...status,enabled:true,permissions:{status:"refused",refusal:{code:"authorization_suspended"}}})).toContain("экстренной остановкой");
  expect(computerReadinessError({...status,enabled:true,permissions:{accessibility:true,screen_recording:false}})).toContain("не подтвердил");
  expect(computerReadinessError({...status,enabled:true,permissions:{accessibility:true,screen_recording:true}})).toBeUndefined();
});
it("requires an interactive Windows desktop and UI Automation before connecting",()=>{
  const win={...status,platform:"windows",command:"C:\\Program Files\\OpenCode Desktop\\opencode-desktop.exe",skillPath:"C:\\Users\\fixture\\AppData\\Local\\opencode-desktop\\computer\\skill"};
  expect(computerReadinessError({...win,permissions:{interactive_session:false,uia:true,windows_visible:true}})).toContain("интерактивный");
  expect(computerReadinessError({...win,permissions:{interactive_session:true,uia:false,windows_visible:true}})).toContain("UI Automation");
  expect(computerReadinessError({...win,permissions:{interactive_session:true,uia:true,windows_visible:true}})).toBeUndefined();
  expect(reservedEntry(COMPUTER_SERVER,win.command,true)).toMatchObject({command:win.command,args:["--computer-mcp"]});
});
// The former OpenCode JSONC writer (computerConfig: comments/models/credentials/
// permissions/other MCP preservation, skill de-duplication, reserved-name
// refusal) is replaced by the shared registry entry: test/reserved-servers.test.ts.
// The computer skill path now reaches sessions through capabilities.prepare.
it("does not register local computer commands in a remote OpenCode server",()=>{
  expect(isLocalComputer("http://127.0.0.1:4096",false)).toBe(true);
  expect(isLocalComputer("http://127.0.0.1:4501",true)).toBe(false);
  expect(isLocalComputer("http://192.168.31.10:4096",false)).toBe(false);
});

it("shows unsupported native-window control without asking Linux users for macOS grants",()=>{
  expect(computerReadinessError({...status,platform:"linux",supported:false,permissions:{status:"unsupported"}})).toContain("браузера");
  expect(computerReadinessError({...status,platform:"other",permissions:{}})).toContain("недоступно");
  expect(computerReadinessError({...status,platform:"windows",permissions:{status:"refused",refusal:{code:"authorization_suspended"},interactive_session:true,uia:true,windows_visible:true}})).toContain("экстренной остановкой");
});
