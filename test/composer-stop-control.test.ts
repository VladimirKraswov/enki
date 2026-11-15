// One stop control: recording owns the stop while dictation is active; the
// ordinary session stop is not rendered beside it. The recording stop has its
// own red style and an explicit accessible name.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const composer = read("../src/components/Composer.tsx");
const voice = read("../src/components/VoiceInput.tsx");
const css = read("../src/styles.css");

it("does not render the session stop while dictation owns the control", () => {
  expect(composer).toContain('{!voiceActive && ((running && session) || s.ui.sending) && (');
  expect(composer).toContain('aria-label={running ? "Остановить сессию" : "Отменить подготовку"}');
  expect(css).not.toContain(':not(.stop-btn)');
  expect(css).toContain('.composer-voice-active .composer-actions > :not(.voice-control) { display: none; }');
});

it("uses a distinct, explicitly named stop for dictation", () => {
  expect(voice).toContain('className="voice-finish voice-stop icon-btn"');
  expect(voice).toContain('aria-label="Остановить диктовку"');
  expect(css).toContain('.voice-recording .voice-stop { background: var(--err); color: #fff; }');
});
