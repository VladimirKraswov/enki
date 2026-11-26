/** App-owned appearance preferences; never sent to the inference server. */
export interface Appearance {
  uiFontSize: number;
  chatFontSize: number;
  codeFontSize: number;
  accent: string;
  chatWidth: "standard" | "wide" | "full";
  lineSpacing: "standard" | "relaxed";
}
export const DEFAULT_APPEARANCE: Appearance = {
  uiFontSize: 14, chatFontSize: 14, codeFontSize: 12,
  accent: "neutral", chatWidth: "standard", lineSpacing: "standard",
};
export const ACCENTS = [
  ["neutral", "Нейтральный"], ["#e3b341", "Золотой"], ["#5599ee", "Синий"],
  ["#9b83ee", "Фиолетовый"], ["#4caa86", "Зелёный"], ["#e78060", "Коралловый"],
] as const;
export function normalizeAppearance(raw: unknown): Appearance {
  const x = raw && typeof raw === "object" ? raw as Partial<Appearance> : {};
  const size = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
  return {
    uiFontSize: size(x.uiFontSize, 14, 12, 18),
    chatFontSize: size(x.chatFontSize, 14, 12, 24),
    codeFontSize: size(x.codeFontSize, 12, 10, 22),
    accent: typeof x.accent === "string" && /^#[0-9a-f]{6}$/i.test(x.accent) ? x.accent.toLowerCase() : "neutral",
    chatWidth: x.chatWidth === "wide" || x.chatWidth === "full" ? x.chatWidth : "standard",
    lineSpacing: x.lineSpacing === "relaxed" ? "relaxed" : "standard",
  };
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) => rgb(hex).map(c => {const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;})
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
export const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
function mix(color: string, target: string, amount: number): string {
  const a = rgb(color), b = rgb(target);
  return `#${a.map((c, i) => Math.round(c + (b[i] - c) * amount).toString(16).padStart(2, "0")).join("")}`;
}
/** Keep accent labels legible even with a very dark/light custom color. */
export function accentColors(accent: string, dark: boolean) {
  const bg = dark ? "#202020" : "#ffffff";
  let ink = accent;
  for (let i = 0; contrast(ink, bg) < 4.5 && i < 20; i++) ink = mix(ink, dark ? "#ffffff" : "#000000", .12);
  return { fill: accent, ink, on: contrast(accent, "#ffffff") >= contrast(accent, "#000000") ? "#ffffff" : "#000000" };
}
export function applyAppearance(raw: unknown): void {
  if (typeof document === "undefined") return;
  const a = normalizeAppearance(raw), root = document.documentElement;
  root.style.setProperty("--ui-font-size", `${a.uiFontSize}px`);
  root.style.setProperty("--chat-font-size", `${a.chatFontSize}px`);
  root.style.setProperty("--code-font-size", `${a.codeFontSize}px`);
  // A fixed 830 px column wastes a wide screen and squeezes tables. The presets
  // scale with the window and keep a readable floor on smaller ones.
  root.style.setProperty("--chat-width", a.chatWidth === "full" ? "100%"
    : a.chatWidth === "wide" ? "clamp(1060px, 78vw, 1800px)"
    : "clamp(830px, 58vw, 1400px)");
  root.style.setProperty("--chat-line-height", a.lineSpacing === "relaxed" ? "1.85" : "1.6");
  const keys = ["--accent", "--accent-fill", "--accent-on", "--accent-soft"];
  if (a.accent === "neutral") keys.forEach(k => root.style.removeProperty(k));
  else {
    const colors = accentColors(a.accent, root.dataset.theme === "dark");
    root.style.setProperty("--accent", colors.ink);
    root.style.setProperty("--accent-fill", colors.fill);
    root.style.setProperty("--accent-on", colors.on);
    root.style.setProperty("--accent-soft", `${colors.fill}20`);
  }
}
