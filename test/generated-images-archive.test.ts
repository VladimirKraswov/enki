// @vitest-environment jsdom
// Final seam review: the generated images.zip gets a real save action. The UI
// only names the archive URL and the OPEN chat's directory; the native
// `image_archive_save` command verifies the exact chat-folder archive, shows the
// save dialog and copies it (src-tauri/src/images.rs archive_tests). PNG/map
// preview cards keep using `image_asset`. Written, NOT RUN.
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageResult } from "../src/images/results";

const fake = vi.hoisted(() => ({
  native: vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> =>
    command === "image_asset" ? "data:image/png;base64,iVBORw0KGgo=" : null),
  state: { directory: "/work/project" as string | null },
}));
vi.mock("../src/capabilities/integration", () => ({ capabilityNative: fake.native }));
vi.mock("../src/state/store", () => ({ useAppSelector: (select: (state: unknown) => unknown) => select(fake.state) }));
vi.mock("../src/components/AttachmentViewer", () => ({ AttachmentViewer: () => null }));
import GeneratedImages from "../src/components/GeneratedImages";

const ID = "01234567-1234-1234-1234-123456789abc";
const base = `file:///work/project/.enki/generated-images/${ID}`;
const result = (archive = true): ImageResult => ({ enkiImages: 1, status: "completed",
  images: [{ name: "image-01.png", url: `${base}/image-01.png`, previewUrl: `${base}/preview-01.png` },
    { name: "normal.png", url: `${base}/normal.png`, previewUrl: `${base}/preview-normal.png` }],
  ...(archive ? { archive: `${base}/images.zip` } : {}) });

let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.clearAllMocks(); fake.state.directory = "/work/project"; });
async function mount(value: ImageResult) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(createElement(GeneratedImages, { result: value })));
  return node;
}
const saveButton = (node: HTMLElement) => [...node.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Сохранить images.zip"));

it("saves the chat's archive through the native verified port and reports the chosen path", async () => {
  fake.native.mockImplementation(async (command) => command === "image_archive_save" ? "/Users/owner/Desktop/enki-images-01234567.zip" : "data:image/png;base64,iVBORw0KGgo=");
  const node = await mount(result());
  // The PNG/map cards still load through the PNG-only reader.
  expect(fake.native).toHaveBeenCalledWith("image_asset", { fileUrl: `${base}/preview-01.png` });
  expect(fake.native).toHaveBeenCalledWith("image_asset", { fileUrl: `${base}/preview-normal.png` });
  expect(node.querySelectorAll(".generated-image-preview")).toHaveLength(2);
  await act(async () => saveButton(node)!.click());
  expect(fake.native).toHaveBeenCalledWith("image_archive_save", { fileUrl: `${base}/images.zip`, directory: "/work/project" });
  expect(node.querySelector("[role=status]")?.textContent).toBe("Архив сохранён: /Users/owner/Desktop/enki-images-01234567.zip");
  expect(node.querySelector("[role=alert]")).toBeNull();
});

it("a cancelled dialog reports nothing; a refusal is shown; nothing is offered without an archive or a chat folder", async () => {
  fake.native.mockImplementation(async (command) => command === "image_archive_save" ? null : "data:image/png;base64,iVBORw0KGgo=");
  let node = await mount(result());
  await act(async () => saveButton(node)!.click());
  expect(node.querySelector("[role=status]")).toBeNull();
  expect(node.querySelector("[role=alert]")).toBeNull();
  fake.native.mockImplementation(async (command) => {
    if (command === "image_archive_save") throw "Архив изображений повреждён или содержит посторонние файлы";
    return "data:image/png;base64,iVBORw0KGgo=";
  });
  await act(async () => saveButton(node)!.click());
  expect(node.querySelector("[role=alert]")?.textContent).toContain("посторонние файлы");
  act(() => root.unmount()); document.body.innerHTML = "";
  node = await mount(result(false));
  expect(saveButton(node)).toBeUndefined();
  act(() => root.unmount()); document.body.innerHTML = "";
  fake.state.directory = null;
  node = await mount(result());
  expect(saveButton(node)!.disabled).toBe(true);
  expect(fake.native.mock.calls.filter(([command]) => command === "image_archive_save")).toHaveLength(2);
});
