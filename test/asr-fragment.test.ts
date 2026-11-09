// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { defaultAsr, transcribeAudio } from "../src/voice/asr";
it("sends a fragment that decodes to real samples", async () => {
  vi.stubGlobal("AudioContext", class {
    decodeAudioData() { return Promise.resolve({ length: 16000, duration: 1 }); }
    close() { return Promise.resolve(); }
  });
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ text: "ок" }) }));
  await expect(transcribeAudio(new Blob(["audio"], { type: "audio/webm" }), defaultAsr, new AbortController().signal))
    .resolves.toBe("ок");
});


it("does not block dictation when the browser simply cannot decode the format", async () => {
  vi.stubGlobal("AudioContext", class {
    decodeAudioData() { return Promise.reject(new DOMException("format unsupported", "NotSupportedError")); }
    close() { return Promise.resolve(); }
  });
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ text: "ок" }) }));
  await expect(transcribeAudio(new Blob(["audio"], { type: "audio/webm" }), defaultAsr, new AbortController().signal))
    .resolves.toBe("ок");
});
