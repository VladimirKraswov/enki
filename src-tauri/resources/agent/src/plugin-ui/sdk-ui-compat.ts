import { createHash } from "node:crypto";
import { readFile, realpath, lstat } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { sdkProfileDirectory } from "../platform/environment.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { KeybindingsManager, Theme, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsConfig } from "@earendil-works/pi-tui";
import { record, UiProtocolError } from "./protocol.ts";

/** One reviewed PRIVATE compatibility boundary. Never patches an installed package. */
export const SDK_UI_COMPAT_0851 = Object.freeze({
  name: "@earendil-works/pi-coding-agent", version: "0.85.1",
  packageJsonSha256: "f1738e4b42203e5f22bcb513f13fb2fb224f1e98d1f129ff042f87048665a94c",
  keybindingsSha256: "588794892300bacf84ddbea13e44882a63d9f03ddfeab5bdbe22cdb9d1816a73",
  themeSha256: "5ced0adb09ca8ce0f9b4eefcf89825755e9873cd53388825694025a4b046d1d5",
  /** dist/core/extensions/loader.js, used by resource-compat.ts. */
  resourceLoaderSha256: "a1393de916487a2c47107ac7239f3139dcdb938705f88ba1ea5a954b3c8bb483",
});
export interface SdkUiCompat {
  createKeybindings(bindings: KeybindingsConfig, configPath: string): KeybindingsManager;
  initializeTheme(theme: Theme): Theme;
  themes: Pick<ExtensionUIContext, "theme" | "getAllThemes" | "getTheme" | "setTheme">;
  registerThemes(themes: Theme[]): void;
  loadTheme(file: string): Theme;
  stopThemeWatcher(): void;
}
async function checkedFile(file: string, expected: string, max: number): Promise<string> {
  const resolved = await realpath(file);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.size > max) throw new UiProtocolError("sdk-file", "Файл совместимости SDK имеет неверный тип или размер.");
  const bytes = await readFile(resolved);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new UiProtocolError("sdk-hash", "Версия интерфейса SDK изменилась. Требуется проверенная адаптация.");
  return resolved;
}
function manager(value: unknown): value is KeybindingsManager {
  return record(value) && ["matches", "getKeys", "getEffectiveConfig", "reload", "setUserBindings"]
    .every(key => typeof value[key] === "function");
}
function theme(value: unknown): value is Theme {
  return record(value) && ["fg", "bg", "bold", "italic", "getColorMode", "getThinkingBorderColor"]
    .every(key => typeof value[key] === "function");
}
function call(namespace: Record<string, unknown>, name: string, args: unknown[]): unknown {
  const fn = namespace[name];
  if (typeof fn !== "function") throw new UiProtocolError("sdk-export", `SDK не предоставляет обязательный интерфейс ${name}.`);
  return Reflect.apply(fn, undefined, args);
}

/** entryUrl must come from the signed runtime SDK selection, never a model/tool argument. */
export async function loadSdkUiCompat(entryUrl: URL, options: { agentDir: string }): Promise<SdkUiCompat> {
  if (entryUrl.protocol !== "file:" || entryUrl.search || entryUrl.hash) throw new UiProtocolError("sdk-url", "SDK должен быть выбран из локального проверенного runtime.");
  const entry = await realpath(fileURLToPath(entryUrl));
  const root = path.resolve(path.dirname(entry), "..");
  if (entry !== path.join(root, "dist", "index.js")) throw new UiProtocolError("sdk-entry", "Выбран неподдерживаемый входной модуль SDK.");
  const packageFile = await checkedFile(path.join(root, "package.json"), SDK_UI_COMPAT_0851.packageJsonSha256, 65536);
  const pkg: unknown = JSON.parse(await readFile(packageFile, "utf8"));
  if (!record(pkg) || pkg.name !== SDK_UI_COMPAT_0851.name || pkg.version !== SDK_UI_COMPAT_0851.version)
    throw new UiProtocolError("sdk-version", "Эта версия SDK не прошла проверку совместимости интерфейса.");
  // Theme helpers consult SDK getAgentDir(). The worker must set its private
  // environment before importing SDK; never silently discover the owner's ~/.pi.
  if (!path.isAbsolute(options.agentDir) || !process.env.PI_CODING_AGENT_DIR
    || !path.isAbsolute(process.env.PI_CODING_AGENT_DIR)) throw new UiProtocolError("sdk-agent-dir", "Worker должен явно выбрать приватную папку ресурсов Enki до загрузки SDK.");
  const agentDir = await realpath(options.agentDir);
  if (await realpath(process.env.PI_CODING_AGENT_DIR) !== await realpath(sdkProfileDirectory() ?? agentDir)
    || !(await lstat(agentDir)).isDirectory())
    throw new UiProtocolError("sdk-agent-dir", "Папка ресурсов SDK не совпадает с выбранным профилем Enki.");
  const keyPath = await checkedFile(path.join(root, "dist/core/keybindings.js"), SDK_UI_COMPAT_0851.keybindingsSha256, 65536);
  const themePath = await checkedFile(path.join(root, "dist/modes/interactive/theme/theme.js"), SDK_UI_COMPAT_0851.themeSha256, 131072);
  if (!keyPath.startsWith(root + path.sep) || !themePath.startsWith(root + path.sep)) throw new UiProtocolError("sdk-path", "Модуль SDK выходит за границы выбранного runtime.");
  const keysValue: unknown = await import(pathToFileURL(keyPath).href);
  const themeValue: unknown = await import(pathToFileURL(themePath).href);
  if (!record(keysValue) || !record(themeValue) || typeof keysValue.KeybindingsManager !== "function") throw new UiProtocolError("sdk-shape", "SDK вернул несовместимые модули интерфейса.");
  const Keybindings = keysValue.KeybindingsManager;
  let ready = false;
  const current = (): Theme => {
    if (!ready) throw new UiProtocolError("theme-init", "Тема интерфейса ещё не инициализирована.");
    const value = themeValue.theme;
    if (!theme(value)) throw new UiProtocolError("theme-shape", "SDK вернул несовместимую тему.");
    return value;
  };
  return {
    createKeybindings(bindings, configPath) {
      if (!path.isAbsolute(configPath) || path.basename(configPath) !== "keybindings.json"
        || realpathSync(path.dirname(configPath)) !== agentDir
        || existsSync(configPath) && lstatSync(configPath).isSymbolicLink())
        throw new UiProtocolError("keybinding-path", "Настройки клавиатуры должны находиться в приватном профиле Enki.");
      const value: unknown = Reflect.construct(Keybindings, [bindings, path.join(agentDir, "keybindings.json")]);
      if (!manager(value)) throw new UiProtocolError("keybinding-shape", "SDK вернул несовместимый менеджер клавиатуры.");
      return value;
    },
    initializeTheme(value) {
      if (!theme(value)) throw new UiProtocolError("theme-shape", "Некорректная исходная тема.");
      call(themeValue, "setThemeInstance", [value]);
      ready = true;
      return current();
    },
    themes: {
      get theme() { return current(); },
      getAllThemes() {
        const list = call(themeValue, "getAvailableThemesWithPaths", []);
        if (!Array.isArray(list) || !list.every(item => record(item) && typeof item.name === "string"
          && (item.path === undefined || typeof item.path === "string"))) throw new UiProtocolError("theme-list", "SDK вернул некорректный список тем.");
        return list.map(item => ({ name: String(item.name), path: typeof item.path === "string" ? item.path : undefined }));
      },
      getTheme(name) {
        const value = call(themeValue, "getThemeByName", [name]);
        if (value === undefined) return undefined;
        if (!theme(value)) throw new UiProtocolError("theme-shape", "SDK вернул несовместимую тему.");
        return value;
      },
      setTheme(nameOrTheme) {
        const value = typeof nameOrTheme === "string" ? call(themeValue, "getThemeByName", [nameOrTheme]) : nameOrTheme;
        if (!theme(value)) return { success: false, error: "Тема не найдена или несовместима с SDK." };
        call(themeValue, "setThemeInstance", [value]);
        ready = true;
        return { success: true };
      },
    },
    registerThemes(values) {
      if (!values.every(theme)) throw new UiProtocolError("theme-list", "Список содержит несовместимую тему.");
      call(themeValue, "setRegisteredThemes", [values]);
    },
    loadTheme(file) {
      if (!path.isAbsolute(file)) throw new UiProtocolError("theme-path", "Путь темы должен быть абсолютным.");
      const value = call(themeValue, "loadThemeFromPath", [file]);
      if (!theme(value)) throw new UiProtocolError("theme-shape", "Файл содержит несовместимую тему.");
      return value;
    },
    stopThemeWatcher() { call(themeValue, "stopThemeWatcher", []); },
  };
}
