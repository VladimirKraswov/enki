import { isNative, platform } from "../native/platform";

export type PermissionKey =
  | "screen"
  | "accessibility"
  | "microphone"
  | "fullDisk"
  | "files";

export type MicrophoneState = "granted" | "denied" | "unknown";

export interface SystemPermissionStatus {
  platform: string;
  version: string;
  screen_recording: boolean | null;
  accessibility: boolean | null;
  microphone: boolean | null;
  full_disk_access: boolean | null;
}

export interface PermissionRequestResult {
  service: "screen" | "accessibility";
  granted: boolean;
  needs_settings: boolean;
  needs_restart?: boolean;
}

export interface PermissionRow {
  key: PermissionKey;
  title: string;
  why: string;
  state: "granted" | "missing" | "manual" | "unknown";
  canRequest: boolean;
  canRebind: boolean;
}

/**
 * A version marker is only a prompt trigger. It is deliberately separate from
 * TCC itself: after an ad-hoc rebuild the same version can still have a stale
 * code requirement, so the status checks below remain authoritative.
 */
export const PERMISSION_VERSION_KEY = "enki.permissions.checked-version";

export async function systemPermissionStatus(): Promise<SystemPermissionStatus> {
  if (!isNative()) {
    return {
      platform: platform(),
      version: "",
      screen_recording: null,
      accessibility: null,
      microphone: null,
      full_disk_access: null,
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SystemPermissionStatus>("system_permissions_status");
}

export async function requestSystemPermission(
  service: "screen" | "accessibility",
  rebind = false,
): Promise<PermissionRequestResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PermissionRequestResult>("system_permission_request", {
    service,
    rebind,
  });
}

export function restartApp(): Promise<void> {
  return import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<void>("system_permissions_restart"),
  );
}

export function permissionSettingsUrl(key: PermissionKey): string {
  const anchor =
    key === "screen"
      ? "Privacy_ScreenCapture"
      : key === "accessibility"
        ? "Privacy_Accessibility"
        : key === "microphone"
          ? "Privacy_Microphone"
          : key === "fullDisk"
            ? "Privacy_AllFiles"
            : "Privacy_FilesAndFolders";
  return `x-apple.systempreferences:com.apple.preference.security?${anchor}`;
}

export async function openPermissionSettings(key: PermissionKey): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(permissionSettingsUrl(key));
}

export async function probeMicrophone(): Promise<MicrophoneState> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) return "unknown";
  try {
    const stream = await media.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String(error.name)
        : "";
    return name === "NotAllowedError" ||
      name === "PermissionDeniedError" ||
      name === "SecurityError"
      ? "denied"
      : "unknown";
  }
}

/**
 * A missing screen or accessibility grant is the actionable state. Full Disk
 * Access and Files and Folders are always manual; they must not make the app
 * claim that a restart will fix everything.
 */
export function shouldOpenPermissionCenter(
  status: SystemPermissionStatus,
): boolean {
  return status.screen_recording === false || status.accessibility === false;
}

export function permissionRows(
  status: SystemPermissionStatus,
  microphone: MicrophoneState = "unknown",
): PermissionRow[] {
  const mac = status.platform === "macos";
  const screen = status.screen_recording;
  const accessibility = status.accessibility;
  return [
    {
      key: "screen",
      title: "Запись экрана и системного звука",
      why: "Снимки окон, анализ интерфейса и проверка результата в приложениях.",
      state: screen === true ? "granted" : screen === false ? "missing" : "unknown",
      canRequest: mac && screen === false,
      canRebind: mac && screen === false,
    },
    {
      key: "accessibility",
      title: "Универсальный доступ",
      why: "Чтение окон и элементы управления для отдельного курсора агента.",
      state:
        accessibility === true
          ? "granted"
          : accessibility === false
            ? "missing"
            : "unknown",
      canRequest: mac && accessibility === false,
      canRebind: mac && accessibility === false,
    },
    {
      key: "microphone",
      title: "Микрофон",
      why: "Диктовка: запись начинается только по нажатию кнопки и не отправляется автоматически.",
      state: microphone === "granted" ? "granted" : microphone === "denied" ? "missing" : "unknown",
      canRequest: false,
      canRebind: false,
    },
    {
      key: "fullDisk",
      title: "Полный доступ к диску",
      why: "Чтение файлов вне выбранных папок. macOS выдаёт это только вручную.",
      state: "manual",
      canRequest: false,
      canRebind: false,
    },
    {
      key: "files",
      title: "Файлы и папки",
      why: "Рабочий стол, Документы, Загрузки и выбранные проекты.",
      state: "manual",
      canRequest: false,
      canRebind: false,
    },
  ];
}

export function permissionCenterCacheKey(): string {
  return PERMISSION_VERSION_KEY;
}
