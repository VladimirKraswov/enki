// Remainder review: read-only project file preview. Written, NOT RUN.
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileContent, listFiles } from "../src/platform/files.ts";
import { tempDir } from "./helpers.ts";

it("a large UTF-8 text cut inside a multi-byte character is still text (truncated), not binary", () => {
  const root = tempDir("files-utf8");
  // "ж" is 2 bytes; 2 MiB + 1 byte puts the 2 MiB boundary inside a character.
  const body = "ж".repeat(1024 * 1024) + "ж";
  fs.writeFileSync(path.join(root, "big.txt"), "x" + body);
  const preview = fileContent(root, "big.txt");
  expect(preview.type).toBe("text");
  expect(preview.truncated).toBe(true);
  expect(preview.content!.startsWith("xжж")).toBe(true);
  expect(preview.content!.includes("�")).toBe(false);
  // A small complete file and a genuinely binary file keep their meaning.
  fs.writeFileSync(path.join(root, "small.txt"), "привет");
  expect(fileContent(root, "small.txt")).toEqual({ type: "text", content: "привет", size: Buffer.byteLength("привет") });
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  expect(fileContent(root, "blob.bin")).toEqual({ type: "binary", size: 4 });
  // An invalid sequence in a complete small file is not text.
  fs.writeFileSync(path.join(root, "bad.txt"), Buffer.from([0x61, 0xff, 0x62]));
  expect(fileContent(root, "bad.txt").type).toBe("binary");
});

it("paths never leave the project directory, also through links", () => {
  const root = tempDir("files-scope"), outside = tempDir("files-outside");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  expect(() => fileContent(root, "../" + path.basename(outside) + "/secret.txt")).toThrow();
  expect(() => fileContent(root, "link.txt")).toThrow();
  expect(listFiles(root, "").map((entry) => entry.name)).not.toContain("link.txt");
});
