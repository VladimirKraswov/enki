// Enki's own MCP servers (agent control, computer use) are reserved entries of
// the global shared registry (src/capabilities/reserved.ts). Ported from the
// retired OpenCode JSONC writers agentControlConfig/computerConfig: other
// servers are preserved in order, an unrelated entry under the reserved id is
// never adopted, enabling/disabling updates only our entry, writes are CAS.
import { expect, it, vi } from "vitest";
import { AGENT_CONTROL_SERVER, COMPUTER_SERVER, ownsEntry, reservedEntry, reservedServerEnabled, setReservedServer } from "../src/capabilities/reserved";
import { emptyRegistry, type Catalog, type SharedServer } from "../src/capabilities/registry";

const COMMAND = "/Applications/Enki.app/Contents/MacOS/enki";
const foreign: SharedServer = { id: "existing", name: "Existing", enabled: true, kind: "http", command: "", args: [], url: "https://example.test/mcp", envKeys: [], bearer: false };
const catalog = (servers: SharedServer[], command = COMMAND): Catalog =>
  ({ key: "global", content: `rev-${servers.length}`, registry: { ...emptyRegistry(), servers }, inherited: emptyRegistry(), skills: [], runtimeReady: true, command, scopeDirectory: null });
function native(initial: Catalog) {
  let current = initial;
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "shared_catalog") return current;
    if (command === "shared_save") {
      if (args?.expected !== current.content) throw new Error("stale registry");
      current = { ...current, content: `${current.content}+`, registry: args.registry as Catalog["registry"] };
      return current;
    }
    throw new Error(`unexpected ${command}`);
  });
  return { invoke, current: () => current, saves: () => invoke.mock.calls.filter(([c]) => c === "shared_save") };
}

for (const reserved of [AGENT_CONTROL_SERVER, COMPUTER_SERVER]) {
  it(`${reserved.id}: adds its entry with Enki's executable and only its flag, keeping other servers in order`, async () => {
    const n = native(catalog([foreign]));
    await setReservedServer(reserved, true, n.invoke as never);
    expect(n.current().registry.servers).toEqual([foreign, { id: reserved.id, name: reserved.name, enabled: true, kind: "stdio", command: COMMAND, args: [reserved.flag], url: "", envKeys: [], bearer: false }]);
    expect(n.saves()[0][1]).toMatchObject({ scope: "global", directory: null, expected: "rev-1" });
    expect(await reservedServerEnabled(reserved, n.invoke as never)).toBe(true);
  });

  it(`${reserved.id}: re-enabling and disabling update only its entry and never duplicate it`, async () => {
    const n = native(catalog([foreign]));
    await setReservedServer(reserved, true, n.invoke as never);
    await setReservedServer(reserved, true, n.invoke as never);
    await setReservedServer(reserved, false, n.invoke as never);
    expect(n.current().registry.servers.filter(s => s.id === reserved.id)).toEqual([expect.objectContaining({ enabled: false, args: [reserved.flag] })]);
    expect(n.current().registry.servers[0]).toEqual(foreign);
    expect(await reservedServerEnabled(reserved, n.invoke as never)).toBe(false);
  });

  it(`${reserved.id}: an unrelated entry using the reserved id is kept and refused`, async () => {
    for (const other of [
      { ...foreign, id: reserved.id },
      { ...foreign, id: reserved.id, kind: "stdio" as const, command: "/foreign/binary", args: ["serve"] },
      { ...foreign, id: reserved.id, kind: "stdio" as const, command: "relative/enki", args: [reserved.flag] },
      { ...foreign, id: reserved.id, kind: "stdio" as const, command: COMMAND, args: [reserved.flag, "--extra"] },
    ]) {
      const n = native(catalog([other]));
      await expect(setReservedServer(reserved, true, n.invoke as never)).rejects.toThrow("уже занят");
      await expect(setReservedServer(reserved, false, n.invoke as never)).rejects.toThrow("уже занят");
      expect(n.saves()).toHaveLength(0);
      expect(ownsEntry(other, reserved)).toBe(false);
    }
  });
}

it("adopts its own entry after the app moved, rewriting only the executable path", async () => {
  const moved = reservedEntry(COMPUTER_SERVER, "/Volumes/Old/Arvela.app/Contents/MacOS/opencode-desktop", true);
  const n = native(catalog([moved, foreign], COMMAND));
  await setReservedServer(COMPUTER_SERVER, true, n.invoke as never);
  expect(n.current().registry.servers).toEqual([{ ...moved, command: COMMAND }, foreign]);
});

it("disabling an absent entry writes nothing; a relative executable is refused; a concurrent edit is not overwritten", async () => {
  const n = native(catalog([foreign]));
  await setReservedServer(AGENT_CONTROL_SERVER, false, n.invoke as never);
  expect(n.saves()).toHaveLength(0);
  const relative = native(catalog([], "enki"));
  await expect(setReservedServer(AGENT_CONTROL_SERVER, true, relative.invoke as never)).rejects.toThrow("абсолютный путь");
  expect(relative.saves()).toHaveLength(0);
  const raced = native(catalog([foreign]));
  raced.invoke.mockImplementationOnce(async () => catalog([foreign])).mockImplementationOnce(async () => { throw new Error("stale registry"); });
  await expect(setReservedServer(AGENT_CONTROL_SERVER, true, raced.invoke as never)).rejects.toThrow("stale registry");
  expect(raced.current().registry.servers).toEqual([foreign]);
});

it("Windows drive-letter executables are absolute; UNC/relative ones are judged by the shared path rule", () => {
  expect(reservedEntry(COMPUTER_SERVER, "C:\\Program Files\\Enki\\enki.exe", true).args).toEqual(["--computer-mcp"]);
  expect(() => reservedEntry(COMPUTER_SERVER, "enki.exe", true)).toThrow();
});
