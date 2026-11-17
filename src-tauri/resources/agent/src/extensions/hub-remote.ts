import { Type, type Static } from "typebox";
import type { Broker } from "../control/broker.ts";
import type { SdkExtension } from "../sdk/adapter.ts";

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const COMMAND_KINDS = new Set([
  "update.check",
  "update.prepare",
  "update.apply",
  "providers.refresh",
  "settings.update",
]);
const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("command"),
    Type.Literal("result"),
  ]),
  device: Type.Optional(Type.String({ maxLength: 160, description: "Exact Hub device ID from status." })),
  kind: Type.Optional(Type.Union([
    Type.Literal("update.check"),
    Type.Literal("update.prepare"),
    Type.Literal("update.apply"),
    Type.Literal("providers.refresh"),
    Type.Literal("settings.update"),
  ])),
  id: Type.Optional(Type.String({ maxLength: 160, description: "Stable command id, reused only for the exact same operation." })),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

function bounded(value: unknown, chars = 24000): string {
  const text = JSON.stringify(value);
  return text.length <= chars ? text : text.slice(0, chars) + "\n[Result truncated; use the Hub console for full detail.]";
}

function deviceSummary(item: Record<string, unknown>) {
  const overview = item.overview && typeof item.overview === "object"
    ? item.overview as Record<string, unknown>
    : null;
  return {
    id: item.id,
    name: item.name,
    platform: item.platform,
    appVersion: item.appVersion,
    online: item.online === true,
    seen: item.seen,
    revision: item.revision,
    host: overview?.host ?? null,
    statuses: overview?.statuses ?? null,
    activity: overview?.activity ?? null,
    queues: overview?.queues ?? null,
    questions: overview?.questions ?? null,
    permissions: overview?.permissions ?? null,
    updates: overview?.updates ?? null,
    sessions: Array.isArray(overview?.sessions)
      ? (overview.sessions as Array<Record<string, unknown>>).slice(0, 20).map(session => ({
          id: session.id,
          title: session.title,
          directory: session.directory,
          updated: (session.time as Record<string, unknown> | undefined)?.updated ?? null,
        }))
      : [],
  };
}

/** Owner-authorized Hub relay for another Enki device. It deliberately does
 * not offer shell execution, arbitrary files, model prompts or session control:
 * updates and safe settings remain executable even when the remote model is
 * unavailable. Every command still goes through the remote Runtime's own
 * signed-updater/idle/backup gates. */
export function hubRemoteTool(broker: Broker) {
  return {
    name: "hub_remote",
    label: "Удалённый Enki через Hub",
    parameters,
    description: "Read another owner Enki device through Hub and run its existing update/settings commands without a model or agent on that device. "
      + "Use status to get the exact device ID; use command only for update.check/prepare/apply, providers.refresh or settings.update. "
      + "This cannot execute shell, read files, send prompts or bypass the remote updater's idle/backup/signature gates. "
      + "A command receipt is not completion; poll result with the same id.",
    async execute(call: string, input: Static<typeof parameters>, signal?: AbortSignal) {
      const { scope } = await broker.call<{ scope: string | null }>("hub.identity", {}, signal);
      if (!scope) throw new Error("Hub не подключён. Настройте библиотеку Hub на этом устройстве.");
      const request = (route: string, body?: Record<string, unknown>) =>
        broker.call<unknown>("hub.request", { path: route, body: body ?? null, scope }, signal, 30_000);
      if (input.action === "status") {
        const raw = await request("remote/overview");
        const devices = raw && typeof raw === "object" && Array.isArray((raw as { devices?: unknown }).devices)
          ? ((raw as { devices: Array<Record<string, unknown>> }).devices).map(deviceSummary)
          : [];
        return { content: [{ type: "text" as const, text: bounded({ devices, authorization: "lan-only" }) }],
          details: { action: "status" } };
      }
      if (!input.device || !ID.test(input.device)) throw new Error("Нужен точный ID устройства из status.");
      if (input.action === "result") {
        if (!input.id || !ID.test(input.id)) throw new Error("Нужен точный ID команды.");
        const result = await request(`remote/command?id=${encodeURIComponent(input.id)}`);
        return { content: [{ type: "text" as const, text: bounded(result) }], details: { action: "result" } };
      }
      if (!input.kind || !COMMAND_KINDS.has(input.kind)) throw new Error("Эта remote-операция не разрешена.");
      const id = input.id ?? call;
      if (!ID.test(id)) throw new Error("Некорректный ID команды.");
      const result = await request("remote/command", {
        device: input.device, kind: input.kind, id,
        payload: input.payload ?? {},
      });
      return { content: [{ type: "text" as const, text: bounded(result) }],
        details: { action: "command" } };
    },
  };
}

export function hubRemoteExtension(broker: Broker): SdkExtension {
  return { name: "enki-hub-remote", factory: pi => { pi.registerTool(hubRemoteTool(broker)); } };
}
