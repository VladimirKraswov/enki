// @vitest-environment jsdom
// A table in a chat message must live inside its own horizontal scroller, so a
// wide table stays readable in a narrow column instead of squeezing words.
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { Markdown } from "../src/components/Markdown";

it("wraps rendered tables in a scroll container", () => {
  const html = renderToStaticMarkup(createElement(Markdown, {
    source: "| Диск | Модель | Что на нём |\n| --- | --- | --- |\n| nvme0n1 | Samsung 980 PRO | LVM pve: root 96 ГБ |",
  }));
  expect(html).toContain('class="md-table-scroll"');
  expect(html).toMatch(/md-table-scroll"><table>/);
  // The table content itself is untouched.
  expect(html).toContain("Samsung 980 PRO");
});
