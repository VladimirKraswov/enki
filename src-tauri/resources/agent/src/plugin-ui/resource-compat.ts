// One explicit, hash-pinned SDK 0.85.1 compatibility boundary. The public root
// exports discovery, which always scans project/global extensions; explicit-only
// loading needs these real upstream functions until the root exports them.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EventBus, ExtensionFactory, ExtensionRuntime, Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { SDK_UI_COMPAT_0851 } from "./sdk-ui-compat.ts";

export interface ResourceCompat {
  load(paths: string[], cwd: string, bus: EventBus, runtime: ExtensionRuntime): Promise<LoadExtensionsResult>;
  inline(factory: ExtensionFactory, cwd: string, bus: EventBus, runtime: ExtensionRuntime, name: string): Promise<Extension>;
}
let selected: Promise<ResourceCompat> | undefined;
export function resourceCompat(entryUrl?: URL): Promise<ResourceCompat> {
  return entryUrl ? load(entryUrl) : selected ??= load(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")));
}
async function load(entryUrl: URL): Promise<ResourceCompat> {
    if (entryUrl.protocol !== "file:" || entryUrl.search || entryUrl.hash) throw new Error("SDK resource module должен быть локальным.");
    const entry = await realpath(fileURLToPath(entryUrl));
    const root = path.resolve(path.dirname(entry), "..");
    const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
    const loader = path.join(root, "dist/core/extensions/loader.js");
    if (entry !== path.join(root, "dist/index.js")
      || await hash(path.join(root, "package.json")) !== SDK_UI_COMPAT_0851.packageJsonSha256
      || await hash(loader) !== SDK_UI_COMPAT_0851.resourceLoaderSha256)
      throw new Error("Resource loader SDK изменился: требуется проверка совместимости.");
    const value: unknown = await import(pathToFileURL(loader).href);
    if (!value || typeof value !== "object" || !("loadExtensions" in value) || !("loadExtensionFromFactory" in value)
      || typeof value.loadExtensions !== "function" || typeof value.loadExtensionFromFactory !== "function")
      throw new Error("SDK не предоставляет проверенные методы загрузки ресурсов.");
    const load = value.loadExtensions, inline = value.loadExtensionFromFactory;
    return {
      async load(paths, cwd, bus, runtime) {
        const result: unknown = await Reflect.apply(load, undefined, [paths, cwd, bus, runtime]);
        if (!result || typeof result !== "object" || !("extensions" in result) || !Array.isArray(result.extensions)
          || !("errors" in result) || !Array.isArray(result.errors) || !("runtime" in result) || result.runtime !== runtime)
          throw new Error("SDK вернул некорректный результат загрузки ресурсов.");
        // Version+whole-module hash above proves the producer; this is the only
        // data-shape assertion at the private resource boundary.
        return result as LoadExtensionsResult;
      },
      async inline(factory, cwd, bus, runtime, name) {
        const result: unknown = await Reflect.apply(inline, undefined, [factory, cwd, bus, runtime, name]);
        if (!result || typeof result !== "object" || !("handlers" in result) || !(result.handlers instanceof Map)
          || !("tools" in result) || !(result.tools instanceof Map)) throw new Error("SDK вернул некорректное расширение.");
        return result as Extension;
      },
    };

}
