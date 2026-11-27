import type {MessagePart} from '../api/types';

/** Tools of the image service whose output names a durable job. */
const JOB_TOOLS = new Set(['generate_image', 'edit_image', 'generate_icon_pack', 'image_status', 'cancel_image']);
const JOB_ID = /^[a-f0-9-]{36}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface ImageJobRef { id: string; state: string; mode?: string }

/** Latest known job state per id from the turn's image tool outputs. */
export function imageJobRefs(parts: readonly MessagePart[]): ImageJobRef[] {
  const byId = new Map<string, ImageJobRef>();
  for (const part of parts) {
    if (part.type !== 'tool' || !part.tool || !JOB_TOOLS.has(part.tool)) continue;
    const output = part.state?.output;
    if (typeof output !== 'string' || output.length > 32768 || !output.includes('"id"')) continue;
    let parsed: { id?: unknown; state?: unknown; mode?: unknown };
    try { parsed = JSON.parse(output); } catch { continue }
    if (typeof parsed.id !== 'string' || !JOB_ID.test(parsed.id) || typeof parsed.state !== 'string') continue;
    byId.delete(parsed.id);
    byId.set(parsed.id, { id: parsed.id, state: parsed.state, ...(typeof parsed.mode === 'string' ? { mode: parsed.mode } : {}) });
  }
  return [...byId.values()];
}

/** A job whose images are already shown in the turn needs no extra card. */
export function jobHasImages(jobId: string, imageUrls: readonly string[]): boolean {
  return imageUrls.some(url => url.includes('/' + jobId + '/'));
}

export const jobActive = (state: string) => !TERMINAL.has(state);

/** Human phase of the hub job, honest about what the engine is doing. */
export function jobPhaseLabel(progress?: { phase?: string; step?: number; steps?: number } | null): string {
  const phase = progress?.phase;
  if (phase === 'queued') return 'В очереди';
  if (phase === 'prepare') return 'Готовлю задание';
  if (phase === 'upload') return 'Загружаю исходник';
  if (phase === 'sampling') return progress?.steps ? `Рисую ${progress.step ?? 0} из ${progress.steps}` : 'Рисую';
  if (phase === 'done') return 'Готово';
  if (phase === 'cancelled') return 'Отменено';
  if (phase === 'failed') return 'Ошибка';
  return 'Запускаю';
}
