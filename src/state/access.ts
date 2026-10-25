import type { PermissionRule } from "../api/types";
// Per-chat access presets. The Enki Runtime evaluates rules last-match-wins
// (src-tauri/resources/agent/src/interaction/access.ts); "inherit" stores no
// rules, so the runtime's default policy (Settings → Агент) applies.
export type AccessMode = "inherit" | "ask" | "read" | "full";
export const accessOptions = [
  {
    value: "inherit",
    label: "По умолчанию",
    detail: "Политика по умолчанию из настроек агента",
  },
  {
    value: "ask",
    label: "С подтверждением",
    detail: "Чтение разрешено; остальные инструменты спрашивают",
  },
  {
    value: "read",
    label: "Только чтение",
    detail: "Чтение и поиск файлов; команды и изменения запрещены",
  },
  {
    value: "full",
    label: "Полный доступ",
    detail: "Инструменты без подтверждения, в том числе вне проекта",
  },
];
export function accessRules(mode: AccessMode): PermissionRule[] {
  if (mode === "inherit") return [];
  // One wildcard rule also matches `external_directory` in the runtime.
  if (mode === "full") return [{ permission: "*", pattern: "*", action: "allow" }];
  return [
    { permission: "*", pattern: "*", action: mode === "read" ? "deny" : "ask" },
    ...["read", "glob", "grep", "list", "question", "todowrite"].map(
      (permission) => ({ permission, pattern: "*", action: "allow" as const }),
    ),
  ];
}
export function accessMode(
  rules: PermissionRule[] | undefined,
): AccessMode | "custom" {
  if (!rules?.length) return "inherit";
  // Full-access representations stored by earlier versions stay recognized.
  const tail = (n: number) => JSON.stringify(rules.slice(-n));
  if (tail(1) === JSON.stringify([{ permission: "*", pattern: "*", action: "allow" }])) return "full";
  if (tail(2) === JSON.stringify([
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ])) return "full";
  if (tail(3) === JSON.stringify([
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" },
    { permission: "doom_loop", pattern: "*", action: "allow" },
  ])) return "full";
  if (tail(2) === JSON.stringify([
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
  ])) return "full";
  return (
    (["ask", "read"] as const).find(
      (mode) => JSON.stringify(accessRules(mode)) === JSON.stringify(rules.slice(-accessRules(mode).length)),
    ) ?? "custom"
  );
}
