// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fileKind, LARGE_PASTE_THRESHOLD, pastedTextFile, prepareAttachments } from "../src/attachments/prepare";
import { validHelperEndpoint, helperHealth } from "../src/attachments/helper";
import type { DraftAttachment } from "../src/attachments/drafts";
import type { ModelInfo } from "../src/api/types";

const asr = { endpoint: "http://192.168.31.59:8080/api/asr/v1/audio/transcriptions", model: "gigaam-v3-e2e-rnnt", language: "ru" };
const vision: ModelInfo = { id: "v100", providerID: "local", name: "V100", capabilities: { input: { text: true, image: true, audio: false, video: false, pdf: false } } };
function attachment(name: string, mime: string, data: string): DraftAttachment {
  const blob = new Blob([data], { type: mime });
  return { id: name, name, mime, size: blob.size, blob };
}
beforeEach(() => vi.unstubAllGlobals());

it("classifies supported files and turns long pasted text into a real text file", () => {
  expect(fileKind({ name: "manual.pdf", mime: "" })).toBe("pdf");
  expect(fileKind({ name: "clip.mov", mime: "" })).toBe("video");
  expect(fileKind({ name: "notes.md", mime: "" })).toBe("text");
  expect(fileKind({ name: "bundle.zip", mime: "application/zip" })).toBe("archive");
  const pasted = pastedTextFile("x".repeat(LARGE_PASTE_THRESHOLD));
  expect(pasted.type).toBe("text/plain");
  expect(pasted.size).toBe(LARGE_PASTE_THRESHOLD);
});

it('stages original ZIP bytes and sends a small reusable file reference, not a model binary part', async () => {
  const file = attachment('source.zip', 'application/zip', 'PK\x03\x04original zip');
  const reference = {version:1 as const, name:file.name, path:'/home/test/.local/share/opencode-desktop/attachments/12345678-1234-1234-1234-123456789abc/archive.zip', url:'file:///home/test/.local/share/opencode-desktop/attachments/12345678-1234-1234-1234-123456789abc/archive.zip', size:file.size, sha256:'a'.repeat(64), remote:false};
  const stage = vi.fn(async input => {expect(await input.blob.text()).toBe('PK\x03\x04original zip');return reference;});
  const parts = await prepareAttachments([file], vision, '', asr, new AbortController().signal, undefined, stage);
  expect(stage).toHaveBeenCalledOnce();
  expect(parts).toEqual([expect.objectContaining({type:'text', synthetic:true, metadata:{arvelaAttachment:reference}})]);
  expect(parts[0]).not.toHaveProperty('mime');
  expect(parts[0]).toHaveProperty('text',expect.stringContaining(reference.path));
});

it("requires a loopback tunnel for the helper", async () => {
  expect(validHelperEndpoint("http://127.0.0.1:18107")).toBe(true);
  expect(validHelperEndpoint("http://192.168.31.54:8080")).toBe(false);
  expect(validHelperEndpoint("http://127.0.0.1:18107/evil")).toBe(false);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, version: "0.1.0", services: ["pdf"], maxInputBytes: 52_428_800 }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect((await helperHealth("http://127.0.0.1:18107")).services).toEqual(["pdf"]);
  expect(fetcher.mock.calls.length).toBe(1);
  await expect(helperHealth("http://192.168.31.54:8080")).rejects.toThrow("локальным");
  expect(fetcher.mock.calls.length).toBe(1);
});

it("sends text as an OpenCode text/plain file part and does not silently truncate", async () => {
  const prepared = await prepareAttachments([attachment("story.md", "text/markdown", "Привет")], vision, "http://127.0.0.1:18107", asr, new AbortController().signal);
  expect(prepared).toHaveLength(1);
  expect(prepared[0]).toMatchObject({ type: "file", mime: "text/plain", filename: "story.md" });
  expect(atob((prepared[0] as { url: string }).url.split(",")[1])).toBe(new TextEncoder().encode("Привет").reduce((str, byte) => str + String.fromCharCode(byte), ""));
  await expect(prepareAttachments([attachment("big.txt", "text/plain", "x".repeat(750_001))], vision, "http://127.0.0.1:18107", asr, new AbortController().signal)).rejects.toThrow("Разделите");
});

it("routes PDF through the helper for a vision model and keeps its extracted content", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ kind: "pdf", text: "Документ содержит 42", images: [{ label: "Страница 1/1", mime: "image/jpeg", data: "AQID" }], audio: [], notes: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const prepared = await prepareAttachments([attachment("report.pdf", "application/pdf", "%PDF-1.4")], vision, "http://127.0.0.1:18107", asr, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(prepared).toHaveLength(2);
  expect(prepared[0]).toMatchObject({ type: "file", mime: "text/plain" });
  expect(prepared[1]).toMatchObject({ type: "file", mime: "image/jpeg", filename: "report.pdf.page-1.jpg" });
  expect(prepared[1]).toHaveProperty("url", "data:image/jpeg;base64,AQID");
});

it("does not discard visual content when a model lacks image input", async () => {
  const noVision: ModelInfo = { ...vision, capabilities: { input: { text: true, image: false, pdf: false } } };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ kind: "pdf", text: "", images: [{ label: "Страница 1/1", mime: "image/jpeg", data: "AQID" }], audio: [], notes: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(prepareAttachments([attachment("scan.pdf", "application/pdf", "%PDF-1.4")], noVision, "http://127.0.0.1:18107", asr, new AbortController().signal)).rejects.toThrow("не принимает изображения");
});
it('allows a scoped original-image reference for editing with a text-only model', async () => {
  const noVision: ModelInfo = { ...vision, capabilities: { input: { text:true,image:false } } };
  const prepared=await prepareAttachments([attachment('original.png','image/png','original-bytes')],noVision,'',asr,new AbortController().signal,undefined,undefined,{imageReferences:true});
  expect(prepared).toEqual([{type:'file',filename:'original.png',mime:'image/png',url:`data:image/png;base64,${btoa('original-bytes')}`}]);
  await expect(prepareAttachments([attachment('original.png','image/png','original-bytes')],noVision,'',asr,new AbortController().signal)).rejects.toThrow('не принимает изображения');
});
