// Initialized once, BEFORE any SDK value import. Pi's process-global defaults
// must resolve to the immutable bundled profile, never the owner's ~/.pi.
// The three host overrides are restored for the SDK's project shell tools.
import fs from "node:fs";
import path from "node:path";

const KEYS = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "GOOGLE_APPLICATION_CREDENTIALS"] as const;
let installed: { profile: string; original: Readonly<Record<string, string | undefined>> } | undefined;

export function installSdkEnvironment(profile: string): void {
  if (!path.isAbsolute(profile) || profile.includes("\0")) throw new Error("Каталог встроенного SDK должен быть абсолютным.");
  const physical = fs.realpathSync(profile);
  if (physical !== path.resolve(profile) || !fs.lstatSync(profile).isDirectory()) throw new Error("Каталог встроенного SDK не должен содержать символические ссылки.");
  if (installed) {
    if (installed.profile !== physical) throw new Error("Нельзя сменить профиль SDK внутри работающего ядра.");
    return;
  }
  for (const name of ["rg", "fd"]) {
    const file = path.join(physical, "bin", name + (process.platform === "win32" ? ".exe" : ""));
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()
      || fs.realpathSync(file) !== file) throw new Error(`Повреждена встроенная поисковая утилита ${name}.`);
  }
  const missingAdc = path.join(physical, ".no-ambient-adc");
  if (fs.existsSync(missingAdc)) throw new Error("Встроенный профиль SDK содержит посторонний файл авторизации.");
  const original = Object.freeze(Object.fromEntries(KEYS.map(key => [key, process.env[key]])));
  installed = { profile: physical, original };
  process.env.PI_CODING_AGENT_DIR = physical;
  process.env.PI_OFFLINE = "1";
  // SDK 0.85.1 otherwise probes ~/.config/gcloud during model availability
  // checks even with an explicit credential store and network disabled.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = missingAdc;
}

export function sdkProfileDirectory(): string | undefined { return installed?.profile; }

export function projectToolEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (installed) for (const key of KEYS) {
    const original = installed.original[key];
    if (original === undefined) delete result[key]; else result[key] = original;
  }
  return result;
}
