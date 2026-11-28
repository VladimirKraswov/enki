/**
 * A notice may carry a whole failure list (for example every provider whose key
 * could not be read). Rendering it verbatim covers the chat with text and hides
 * the window. The toast keeps one readable line; the full text stays available
 * in the tooltip, so nothing is hidden, only not shouted.
 */
export const TOAST_TEXT_LIMIT = 300;

export function toastSummary(message: string, limit = TOAST_TEXT_LIMIT): string {
  const text = message.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const wholeWords = cut.replace(/\s+\S*$/, "");
  return `${wholeWords || cut}…`;
}
