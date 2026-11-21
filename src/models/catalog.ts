import { applyEdits, createScanner, modify, parseTree, stripComments as removeComments, type Node, type ParseError } from "jsonc-parser";
/**
 * Shared model catalog received from Enki Hub and merged into the local engine
 * configuration. The catalog is the source of truth for common models; the local
 * machine keeps only its choice (selection, exclusions) and its own extra providers.
 */
export interface OpencodeEngine {
    providerId: string;
    name?: string;
    provider: Record<string, unknown>;
}
export interface PiEngine {
    providerId: string;
    provider: Record<string, unknown>;
}
export interface HubModel {
    id: string;
    label: string;
    note?: string;
    control?: { service: string; bindings: Record<string, string> } | null;
    opencode?: OpencodeEngine;
    pi?: PiEngine;
}
export interface HubCatalog {
    version: number;
    updatedAt?: number;
    updatedBy?: string;
    note?: string;
    models: HubModel[];
}
export interface HubModelsPrefs {
    /** Hub is the primary model source; direct is the external-only fallback. */
    mode: "hub" | "direct";
    /** Derived from mode; kept for callers that already gate on it. */
    enabled: boolean;
    /** Catalog model ids excluded on this device only. */
    excluded: string[];
    /** The published version last applied to this machine, 0 when never. */
    appliedVersion: number;
    /** Provider ids written into opencode config by the catalog. */
    appliedOpencode: string[];
    /** Provider ids written into Pi models.json by the catalog. */
    appliedPi: string[];
}
export function hubModelsState(prefs: {
    hubModels?: Partial<HubModelsPrefs> | null;
}): HubModelsPrefs {
    const raw = prefs.hubModels ?? {};
    const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const mode = raw.mode === "direct" ? "direct" : "hub";
    return {
        mode,
        enabled: mode === "hub",
        excluded: list(raw.excluded),
        appliedVersion: typeof raw.appliedVersion === "number" && raw.appliedVersion > 0
            ? Math.trunc(raw.appliedVersion)
            : 0,
        appliedOpencode: list(raw.appliedOpencode),
        appliedPi: list(raw.appliedPi),
    };
}
export interface CatalogPlan {
    opencode: Record<string, Record<string, unknown>>;
    pi: Record<string, Record<string, unknown>>;
    removeOpencode: string[];
    removePi: string[];
}
/** Models of the catalog that this device wants active (not excluded). */
export function effectiveModels(catalog: HubCatalog, prefs: HubModelsPrefs): HubModel[] {
    return catalog.models.filter((model) => !prefs.excluded.includes(model.id));
}
export function planCatalog(catalog: HubCatalog, prefs: HubModelsPrefs): CatalogPlan {
    const opencode: CatalogPlan["opencode"] = Object.create(null);
    const pi: CatalogPlan["pi"] = Object.create(null);
    for (const model of effectiveModels(catalog, prefs)) {
        if (model.opencode) {
            if (model.opencode.providerId in opencode)
                throw new Error(`Двойной providerId в каталоге: ${model.opencode.providerId}`);
            opencode[model.opencode.providerId] = model.opencode.provider;
        }
        if (model.pi) {
            if (model.pi.providerId in pi)
                throw new Error(`Двойной providerId в каталоге: ${model.pi.providerId}`);
            pi[model.pi.providerId] = model.pi.provider;
        }
    }
    return {
        opencode,
        pi,
        removeOpencode: prefs.appliedOpencode.filter((id) => !(id in opencode)),
        removePi: prefs.appliedPi.filter((id) => !(id in pi)),
    };
}
interface MergeResult {
    text: string;
    changed: boolean;
    added: string[];
    replaced: string[];
    removed: string[];
    error?: string;
}
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function stripComments(input: string): string { return removeComments(input); }
function checkedTree(text: string): Node {
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length || !tree || tree.type !== "object")
        throw new Error("Нужен корректный объект JSONC");
    const check = (node: Node) => {
        if (node.type === "object") {
            const keys = new Set<string>();
            for (const property of node.children ?? []) {
                const key = property.children?.[0]?.value;
                if (keys.has(key))
                    throw new Error(`Повторяется ключ ${key}`);
                keys.add(key);
            }
        }
        node.children?.forEach(check);
    };
    check(tree);
    return tree;
}
// Normalize trailing commas in containers we edit, without scanning strings or
// comments as syntax. Unrelated provider objects retain their original bytes.
function normalizeCommas(text: string, editedContainersOnly = false): string {
    const tree = editedContainersOnly ? parseTree(text) : undefined;
    const provider = tree?.children?.find(p => p.children?.[0]?.value === "provider")?.children?.[1];
    const closes = new Set([tree, provider].filter((node): node is Node => !!node).map(node => node.offset + node.length - 1));
    const scanner = createScanner(text, true);
    const edits: {
        offset: number;
        length: number;
        content: string;
    }[] = [];
    let previous = "", comma = -1;
    for (;;) {
        scanner.scan();
        if (!scanner.getTokenLength())
            break;
        const token = text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength());
        if ((token === "}" || token === "]") && previous === "," && (!editedContainersOnly || closes.has(scanner.getTokenOffset())))
            edits.push({ offset: comma, length: 1, content: "" });
        previous = token;
        if (token === ",")
            comma = scanner.getTokenOffset();
    }
    return applyEdits(text, edits);
}
/** Use the shared JSONC parser for syntax/ranges: comments may contain braces,
 * commas, URLs and quotes. Never recover malformed user configuration by writing
 * a partial parse back to disk. */
export function mergeOpencodeProviders(text: string, desired: Record<string, Record<string, unknown>>, remove: string[]): MergeResult {
    const base: MergeResult = { text, changed: false, added: [], replaced: [], removed: [] };
    if (!Object.keys(desired).length && !remove.length)
        return base;
    try {
        let work = text.trim() ? text : "{}";
        const tree = checkedTree(work);
        const block = tree.children?.find(p => p.children?.[0]?.value === "provider")?.children?.[1];
        if (block && block.type !== "object")
            throw new Error("Блок provider должен быть объектом");
        const entries = new Map((block?.children ?? []).map(p => [p.children![0].value as string, p.children![1]]));
        const result = { ...base, added: [] as string[], replaced: [] as string[], removed: [] as string[] };
        // Replacements touch value ranges only, so neighboring local providers and
        // comments are never reformatted by a whole-object serializer.
        const replacements = Object.entries(desired).flatMap(([id, value]) => {
            const node = entries.get(id);
            if (!node)
                return [];
            const current = JSON.parse(normalizeCommas(stripComments(work.slice(node.offset, node.offset + node.length))));
            if (JSON.stringify(current) === JSON.stringify(value))
                return [];
            result.replaced.push(id);
            return [{ offset: node.offset, length: node.length, content: JSON.stringify(value, null, 2) }];
        });
        work = applyEdits(work, replacements);
        for (const id of remove) {
            if (has(desired, id) || !entries.has(id))
                continue;
            work = applyEdits(work, modify(work, ["provider", id], undefined, {}));
            result.removed.push(id);
        }
        for (const [id, value] of Object.entries(desired)) {
            if (entries.has(id))
                continue;
            work = applyEdits(work, modify(work, ["provider", id], value, {}));
            result.added.push(id);
        }
        if (!result.added.length && !result.replaced.length && !result.removed.length)
            return base;
        work = normalizeCommas(work, true);
        checkedTree(work);
        return { ...result, text: work, changed: true };
    }
    catch (error) {
        return { ...base, error: `Не удалось разобрать конфигурацию: ${String(error)}` };
    }
}
/** Applies the catalog to Pi `models.json` (pure JSON), preserving unrelated fields. */
export function mergePiModels(content: string, desired: Record<string, Record<string, unknown>>, remove: string[]): MergeResult {
    const base = { text: content, changed: false, added: [] as string[], replaced: [] as string[], removed: [] as string[] };
    if (!Object.keys(desired).length && !remove.length)
        return base;
    let root: Record<string, unknown>;
    try {
        root = content.trim() ? JSON.parse(content) : {};
        if (!root || typeof root !== "object" || Array.isArray(root))
            throw new Error("нужен объект");
    }
    catch (error) {
        return { ...base, error: `models.json Pi не разобран: ${String(error)}` };
    }
    if (has(root, "providers") && !object(root.providers))
        return { ...base, error: "Блок providers Pi должен быть объектом" };
    const providers: Record<string, unknown> = Object.assign(Object.create(null), root.providers ?? {});
    const added: string[] = [], replaced: string[] = [], removed: string[] = [];
    for (const [id, value] of Object.entries(desired)) {
        if (has(providers, id)) {
            if (JSON.stringify(providers[id]) === JSON.stringify(value))
                continue;
            replaced.push(id);
        }
        else
            added.push(id);
        providers[id] = value;
    }
    for (const id of remove) {
        if (!has(desired, id) && has(providers, id)) {
            delete providers[id];
            removed.push(id);
        }
    }
    if (!added.length && !replaced.length && !removed.length)
        return base;
    return {
        text: `${JSON.stringify({ ...root, providers }, null, 2)}\n`,
        changed: true,
        added,
        replaced,
        removed,
    };
}
