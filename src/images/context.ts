import type { PromptRequest } from '../api/types';
import { isNative } from '../native/platform';

/** Input bytes come only from prepared USER attachments, never Markdown, paths,
 * model output or tool arguments. The native command binds them to this request. */
export function imageContextSources(parts: PromptRequest['parts']) {
  const images: { name: string; mime: string; data: string }[] = [];
  const unsupported: { name: string; mime: string; reason: string }[] = [];
  let total = 0;
  for (const part of parts) {
    if (part.type !== 'file' || !part.mime.startsWith('image/')) continue;
    const name = part.filename ?? 'image';
    const matched = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url);
    const bytes = matched ? Math.floor(matched[2].length * 3 / 4) - (matched[2].endsWith('==') ? 2 : matched[2].endsWith('=') ? 1 : 0) : 0;
    const reason = !matched || matched[1] !== part.mime ? 'Редактирование поддерживает PNG, JPEG и WebP; произвольные URL не загружаются.'
      : images.length >= 4 ? 'Для одной правки поддерживается до четырёх исходников.'
      : bytes > 8 * 1024 * 1024 || total + bytes > 16 * 1024 * 1024 ? 'Исходник для редактирования: до 8 МБ, все исходники вместе до 16 МБ.' : '';
    if (reason) { if (unsupported.length < 12) unsupported.push({ name, mime: part.mime, reason }); continue; }
    images.push({ name, mime: part.mime, data: matched![2] });
    total += bytes;
  }
  return { images, unsupported };
}

/** Text-only engines still edit from real pixels through the image service.
 * Never send unsupported binary input or pretend the chat model saw the image. */
export function imagePromptParts(parts: PromptRequest['parts'], supportsVision: boolean, referenceImages: boolean): PromptRequest['parts'] {
  if (supportsVision || !referenceImages) return parts;
  const sources = imageContextSources(parts);
  return parts.map(part => {
    if (part.type !== 'file' || !part.mime.startsWith('image/')) return part;
    const source = sources.images.find(image => part.url === `data:${image.mime};base64,${image.data}`);
    const name = part.filename ?? 'image';
    return {
      type: 'text',
      text: source
        ? `Приложено исходное изображение ${JSON.stringify(name)}. Проверь его доступность через image_inputs; Enki сохраняет поддерживаемые оригиналы для edit_image. Текущая модель не поддерживает Vision: она может передать этот исходник генератору для правки по просьбе пользователя, но не видит пиксели и не должна заявлять о визуальной проверке. Для анализа картинки выберите модель с Vision.`
        : `Приложено изображение ${JSON.stringify(name)}. Текущая модель не поддерживает Vision; исходник недоступен редактору: ${sources.unsupported.find(image => image.name === name)?.reason ?? 'формат или размер не поддерживается.'}`,
      metadata: { enkiImageReference: { name, mime: part.mime } },
    };
  });
}

export async function stageImagePromptContext(context: {
  engine: string; sessionId: string; directory: string; messageId: string;
  parts: PromptRequest['parts']; supportsVision: boolean; local: boolean; automatic?: boolean;
}, invoke?: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  // Remote engines cannot use this device's private context. Their ordinary
  // chats keep working; image tools report the missing local scoped context.
  if (!context.local || !isNative() && !invoke) return;
  const call = invoke ?? (await import('@tauri-apps/api/core')).invoke;
  const { parts, local: _local, ...identity } = context;
  await call('image_prompt_context', { ...identity, ...imageContextSources(parts) });
}
