// Tool output discipline for small local models. The SDK already truncates bash
// output to its tail; a tail-only cut loses early compiler/test errors and can
// still send ~50KB per call. Keep the beginning AND the end, and point to the
// full log the SDK already saved instead of re-reading it into the context.

export const LOCAL_TOOL_TEXT_LIMIT = 12_000;
const HEAD_CHARS = 4_000;
const TAIL_CHARS = 6_000;

export function compactToolText(text: string, fullOutputPath?: string): string {
  if (text.length <= LOCAL_TOOL_TEXT_LIMIT) return text;
  let head = text.slice(0, HEAD_CHARS);
  let tail = text.slice(-TAIL_CHARS);
  // Cut on line boundaries: half a line reads as corrupted output.
  const headBreak = head.lastIndexOf("\n");
  if (headBreak >= HEAD_CHARS / 2) head = head.slice(0, headBreak);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak >= 0 && tailBreak <= TAIL_CHARS / 2) tail = tail.slice(tailBreak + 1);
  const omitted = Math.max(0, text.length - head.length - tail.length);
  const note = `\n…[пропущено ${omitted} символов из середины${fullOutputPath ? `; полный вывод: ${fullOutputPath}` : ""}]…\n`;
  return head + note + tail;
}
