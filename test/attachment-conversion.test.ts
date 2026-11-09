import { expect, it } from "vitest";
import { conversionSummary, validateConverted } from "../src/attachments/prepare";
import type { Conversion } from "../src/attachments/helper";
import type { ModelInfo } from "../src/api/types";

const model = (image = false): ModelInfo => ({ id: "m", providerID: "p", name: "M", capabilities: { input: { text: true, ...(image ? { image: true } : {}) } } }) as ModelInfo;
const conversion = (text: string, images: number): Conversion => ({
  kind: "pdf", text, audio: [], notes: [],
  images: Array.from({ length: images }, (_, i) => ({ label: `Страница ${i + 1}`, mime: "image/jpeg", data: "AA==" })),
});

it("never sends a document that became nothing", () => {
  expect(() => validateConverted("a.pdf", conversion("", 0), model(true))).toThrow(/не удалось извлечь/);
});

it("a scanned PDF without a text layer is not handed to a text-only model", () => {
  expect(() => validateConverted("scan.pdf", conversion("", 3), model(false))).toThrow(/скан без текстового слоя/);
  // Модели с изображениями страницы допустимы.
  expect(() => validateConverted("scan.pdf", conversion("", 3), model(true))).not.toThrow();
});

it("the model always learns what document it received and whether a text layer existed", () => {
  expect(conversionSummary("scan.pdf", "pdf", conversion("", 2))).toContain("Текстового слоя нет");
  expect(conversionSummary("doc.pdf", "pdf", conversion("Текст", 0))).toContain("Извлечён текст документа");
  expect(conversionSummary("doc.pdf", "pdf", conversion("Текст", 0))).toContain("Имя файла: doc.pdf");
});
