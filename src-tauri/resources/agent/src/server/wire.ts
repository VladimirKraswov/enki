// One envelope → one SSE `data:` payload within the shared wire bound.
// An event above EVENT_WIRE_LIMIT_BYTES (a legal large attachment inside a
// part) keeps its seq but travels as an explicit `event.oversized` stub: the
// client advances its cursor AND reconciles from the authoritative routes. The
// stored durable event is untouched, so nothing is lost or silently skipped.
import { EVENT_WIRE_LIMIT_BYTES, type EventEnvelope, type OversizedEventProperties } from "../protocol.ts";

const field = (value: unknown): string | undefined => typeof value === "string" && value.length <= 200 ? value : undefined;

export function oversizedProperties(envelope: EventEnvelope, bytes: number): OversizedEventProperties {
  const props = envelope.event.properties ?? {};
  const part = props.part && typeof props.part === "object" ? (props.part as Record<string, unknown>) : undefined;
  const info = props.info && typeof props.info === "object" ? (props.info as Record<string, unknown>) : undefined;
  const sessionID = envelope.sessionID ?? field(props.sessionID) ?? field(part?.sessionID) ?? field(info?.sessionID);
  const messageID = field(part?.messageID) ?? field(props.messageID) ?? field(info?.id);
  const partID = field(part?.id) ?? field(props.partID);
  return { type: envelope.event.type, bytes, ...(sessionID ? { sessionID } : {}), ...(messageID ? { messageID } : {}), ...(partID ? { partID } : {}) };
}

/** Serialized wire form of `envelope`; never longer than the shared limit. */
export function wireEnvelope(envelope: EventEnvelope, limit = EVENT_WIRE_LIMIT_BYTES): string {
  const json = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(json);
  if (bytes <= limit) return json;
  const stub: EventEnvelope = {
    seq: envelope.seq, time: envelope.time, directory: envelope.directory, sessionID: envelope.sessionID,
    event: { id: envelope.event.id, type: "event.oversized", properties: { ...oversizedProperties(envelope, bytes) } },
  };
  return JSON.stringify(stub);
}
