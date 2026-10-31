import type { Release } from "./controller";

export function ReadyUpdateBadge(props: { release: Release | null; prepared: boolean; downloaded: boolean; waiting?: boolean; onOpen(): void }) {
  const { release, prepared, downloaded, waiting, onOpen } = props;
  if (!release?.available || !release.version) return null;
  const hot = release.kind === "hot";
  if (!hot && (release.kind !== "source" || !prepared && release.binary?.state !== "ready")) return null;
  const title = waiting ? `Ожидаем завершения задач для установки ${release.version}`
    : prepared || hot && downloaded ? "Готово к установке"
    : hot ? "Готовое обновление интерфейса" : "Готовое обновление доступно для загрузки";
  return <button className={`update-badge ${hot ? "hot" : "native"}`} aria-label={`Обновление ${release.version}`} title={`${title} · ${release.version}`} onClick={onOpen}><span aria-hidden="true">↑</span></button>;
}
