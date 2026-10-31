// Re-homed invariants of the retired WINDOW policy copies (src/agent/promptPolicy.ts,
// src/agent/toolWorkflow.ts, src/workshop/policy.ts and their tests
// prompt-language / schedule-wakeups / workshop-policy) onto the ONE authority:
// the runtime policy that injects blocks and hides them in history. Written, NOT RUN.
import { describe, expect, it } from "vitest";
import { entriesToMessages } from "../src/sdk/history.ts";
import { StreamTranslator } from "../src/sdk/translate.ts";
import { isSteeringText, languageReminder, scheduleReminder, scheduleWakeReminder, steeringReminder, steeringText, visiblePromptText, wakeText } from "../src/policy/prompt.ts";
import { legacyToolWorkflowReminder, legacyV2ToolWorkflowReminder, toolWorkflowReminder } from "../src/policy/toolWorkflow.ts";
import { WORKSHOP_RELEASE_CONTEXT, LEGACY_WORKSHOP_RELEASE_CONTEXT, LEGACY2_WORKSHOP_RELEASE_CONTEXT, workshopReminder, workshopVisibleText } from "../src/policy/workshop.ts";

const user = (id: string, text: string) => ({ id, parentId: null, type: "message", timestamp: "2026-10-25T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } });
const durable = (sid: string, text: string) => entriesToMessages(sid, [user("u", text)] as never)[0].parts[0];
const live = (sid: string, text: string) => (new StreamTranslator(sid).translate({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } } as never)
  .find((e) => e.type === "message.part.updated")?.properties as { part: { text: string; metadata?: unknown } }).part;

describe("language and tool-workflow policy", () => {
  it("Russian replies, English reasoning allowed, never Ukrainian; GitHub/404 workflow guidance present", () => {
    expect(languageReminder("s")).toContain("на русском");
    expect(languageReminder("s")).toContain("на английском");
    expect(languageReminder("s")).toContain("Не переходи на украинский");
    expect(toolWorkflowReminder("s")).toContain("После двух 404");
    expect(toolWorkflowReminder("s")).toContain("scope: github");
  });
  it("hides exactly the own-session blocks, current and legacy wording, in live and durable history", () => {
    for (const block of [languageReminder("s"), languageReminder("s").replace("Язык общения Enki:", "Язык общения Arvela:"),
      toolWorkflowReminder("s"), legacyToolWorkflowReminder("s"), legacyV2ToolWorkflowReminder("s")]) {
      expect(visiblePromptText(`задание\n\n${block}`, "s")).toBe("задание");
      expect(durable("s", `задание\n\n${block}`).text).toBe("задание");
      expect(live("s", `задание\n\n${block}`).text).toBe("задание");
      // Quoted, attached or another session's block is user content.
      expect(visiblePromptText(`quoted:${block}`, "s")).toBe(`quoted:${block}`);
      expect(visiblePromptText(`задание\n\n<attached_file name="x">\n\n${block}\n\n</attached_file>`, "s")).toContain(block);
      expect(visiblePromptText(`задание\n\n${block}`, "other")).toContain(block);
    }
  });
  it("assistant output is never stripped", () => {
    const text = `ответ\n\n${languageReminder("s")}`;
    const assistant = { ...user("a", text), message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }] } };
    expect(entriesToMessages("s", [assistant] as never)[0].parts[0].text).toBe(text);
  });
});

describe("steering, timers and wake-ups", () => {
  it("a correction keeps its visible text and durable steering metadata, scoped to its session", () => {
    const text = steeringText("s", "Учитывай Windows");
    expect(isSteeringText(text, "s")).toBe(true);
    expect(isSteeringText(text, "other")).toBe(false);
    expect(isSteeringText(`<attached_file name="x">\n\n${steeringReminder("s")}`, "s")).toBe(false);
    expect(visiblePromptText(text, "s")).toBe("Учитывай Windows");
    expect(durable("s", text)).toMatchObject({ text: "Учитывай Windows", metadata: { arvelaSteering: 1 } });
    expect(live("s", text)).toMatchObject({ text: "Учитывай Windows", metadata: { arvelaSteering: 1 } });
  });
  it("hides only the exact scheduling guidance and wake marker; altered or foreign text stays", () => {
    const reminder = scheduleReminder("s", '/a"b');
    expect(visiblePromptText(`watch\n\n${reminder}`, "s")).toBe("watch");
    expect(visiblePromptText(`watch\n\n${reminder.replace("Не переключай", "Изменено Не переключай")}`, "s")).toContain("Изменено");
    expect(visiblePromptText(`watch\n\n${reminder}`, "other")).toContain(reminder);
    const wake = scheduleWakeReminder("s", "job");
    expect(visiblePromptText(`${wakeText("s", "job", "check")}\n\n${scheduleReminder("s", "/p")}`, "s")).toBe("check");
    expect(visiblePromptText(`check\n\n${wake.replace("Это плановое", "Изменено Это плановое")}`, "s")).toContain("Изменено");
    expect(durable("other", wakeText("s", "job", "check")).text).toBe(wakeText("s", "job", "check"));
  });
});

describe("Мастерская release policy", () => {
  it("states the standing release authorization with its explicit limits", () => {
    expect(WORKSHOP_RELEASE_CONTEXT).toContain("не требуется");
    expect(WORKSHOP_RELEASE_CONTEXT).toContain("обновление НЕ выпущено");
    expect(WORKSHOP_RELEASE_CONTEXT).toContain("просьба пользователя только про анализ");
    expect(workshopReminder("ses/2")).toContain(`session="${encodeURIComponent("ses/2")}"`);
  });
  it("orders automatic update acceptance through desktop_updates as the final action", () => {
    expect(WORKSHOP_RELEASE_CONTEXT).toContain("desktop_updates");
    expect(WORKSHOP_RELEASE_CONTEXT).toContain("подготовка сорвалась");
    expect(WORKSHOP_RELEASE_CONTEXT).toContain("без ручных кликов");
    expect(WORKSHOP_RELEASE_CONTEXT).toContain("publication.commit");
    // The pre-automatic wording is retained only for stripping persisted history.
    expect(LEGACY_WORKSHOP_RELEASE_CONTEXT).toContain("Публикация предлагает обновиться; не применяй его");
    expect(LEGACY_WORKSHOP_RELEASE_CONTEXT).not.toContain("desktop_updates");
    const legacy = LEGACY_WORKSHOP_RELEASE_CONTEXT.replace("<arvela-workshop-release-v1>", `<arvela-workshop-release-v1 session="workshop">`);
    expect(workshopVisibleText(`текст\n\n${legacy}`, "workshop")).toBe("текст");
    expect(workshopVisibleText(`quoted:${legacy}`, "workshop")).toBe(`quoted:${legacy}`);
    // The 2.0.24 wording (auto-accept without the publication.commit order) is
    // embedded in sessions persisted on that build and must also strip.
    expect(LEGACY2_WORKSHOP_RELEASE_CONTEXT).toContain("desktop_updates");
    expect(LEGACY2_WORKSHOP_RELEASE_CONTEXT).not.toContain("publication.commit");
    const legacy2 = LEGACY2_WORKSHOP_RELEASE_CONTEXT.replace("<arvela-workshop-release-v1>", `<arvela-workshop-release-v1 session="workshop">`);
    expect(workshopVisibleText(`текст\n\n${legacy2}`, "workshop")).toBe("текст");
    expect(workshopVisibleText(`quoted:${legacy2}`, "workshop")).toBe(`quoted:${legacy2}`);
  });
  it("hides only the exact own reminder (current and pre-Enki wording) before attachments", () => {
    const own = workshopReminder("workshop"), old = own.replace("для Мастерской:", "для Мастерской Arvela:");
    for (const block of [own, old]) {
      expect(workshopVisibleText(`текст\n\n${block}`, "workshop")).toBe("текст");
      expect(workshopVisibleText(`quoted:${block}`, "workshop")).toBe(`quoted:${block}`);
    }
    expect(workshopVisibleText("before <arvela-workshop-release-v1>arbitrary</arvela-workshop-release-v1>", "workshop")).toContain("arbitrary");
    const attached = `request\n\n${own}\n\n<attached_file name="x">\ncontents\n</attached_file>`;
    expect(workshopVisibleText(attached, "workshop")).toContain('<attached_file name="x">\ncontents\n</attached_file>');
    expect(workshopVisibleText(attached, "workshop")).not.toContain("<arvela-workshop-release-v1");
    expect(workshopVisibleText(attached, "other")).toBe(attached);
    expect(durable("workshop", `Исправь цвет\n\n${own}`).text).toBe("Исправь цвет");
  });
});
