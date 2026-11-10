import { expect, it } from "vitest";
import { executionEvidence, executionLabel } from "../src/chat/execution";
import { streamStalled } from "../src/state/streamHealth";

// Как решает render.tsx: свидетельство строится по «простой» (stalled), а не по
// самому факту переподключения.
const confirmed = (streamState: string, downSince: number | null, now: number) =>
  !streamStalled(streamState, downSince, now);

it("a short reconnect keeps a running tool confirmed instead of claiming no connection", () => {
  const t0 = 1_000_000;
  const evidence = executionEvidence(false, true, confirmed("reconnecting", t0, t0 + 1_500));
  expect(evidence).toBe("active");
  expect(executionLabel(evidence)).toBe("выполняется");
});

it("only a lasting outage marks the unfinished call as unconfirmed", () => {
  const t0 = 1_000_000;
  const evidence = executionEvidence(false, true, confirmed("reconnecting", t0, t0 + 30_000));
  expect(evidence).toBe("unconfirmed");
  expect(executionLabel(evidence)).toBe("статус не подтверждён: нет связи");
});

it("a finished tool keeps no status at all, connected or not", () => {
  expect(executionEvidence(true, true, false)).toBe("inactive");
});
