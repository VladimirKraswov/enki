// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { defaultAsr, transcribeAudio } from "../src/voice/asr";
it("does not send an unparseable fragment to ASR and keeps the audio for recovery", async () => {
  vi.stubGlobal("AudioContext", class {
    decodeAudioData() { return Promise.reject(new Error("EBML header parsing failed")); }
    close() { return Promise.resolve(); }
  });
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  await expect(transcribeAudio(new Blob(["not-a-container"]), defaultAsr, new AbortController().signal))
    .rejects.toThrow(/повреждён.*Запрос к ASR не отправлен/);
  expect(request).not.toHaveBeenCalled();
});

it("sends a fragment that decodes to real samples", async () => {
  vi.stubGlobal("AudioContext", class {
    decodeAudioData() { return Promise.resolve({ length: 16000, duration: 1 }); }
    close() { return Promise.resolve(); }
  });
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ text: "ок" }) }));
  await expect(transcribeAudio(new Blob(["audio"], { type: "audio/webm" }), defaultAsr, new AbortController().signal))
    .resolves.toBe("ок");
});

