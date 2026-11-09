// @vitest-environment jsdom
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs") }));
import { convertPdfLocally } from "../src/attachments/pdfLocal";

it("extracts text from a real PDF without the helper service", async () => {
  const bytes = fs.readFileSync("test/fixtures/hello-enki.pdf");
  const blob = new Blob([bytes], { type: "application/pdf" });
  const result = await convertPdfLocally(blob, { renderPage: async () => null });
  expect(result.kind).toBe("pdf");
  expect(result.text).toContain("Hello Enki");
  expect(result.notes.join(" ")).toContain("Извлечено локально");
  expect(result.images).toEqual([]);
});
