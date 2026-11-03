/** Presentation envelope only. It grants no file access; image_inputs checks
 * the native session/request identity independently. Never fetch a URL here. */
export interface ImageReference { version: 1; name: string; mime: string; available: boolean }
export function imageReference(value: unknown): ImageReference | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.name !== 'string' || !v.name || v.name.length > 1024
    || /[\u0000-\u001f]/.test(v.name) || typeof v.mime !== 'string'
    || !/^image\/[a-z0-9.+-]{1,80}$/.test(v.mime) || typeof v.available !== 'boolean') return;
  return { version: 1, name: v.name, mime: v.mime, available: v.available };
}
const OPEN = '<enki-image-reference-v1>', CLOSE = '</enki-image-reference-v1>';
export function imageReferenceText(reference: ImageReference, instruction: string): string {
  if (!imageReference(reference)) throw new Error('Invalid image reference');
  return OPEN + JSON.stringify({ ...reference, instruction }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e') + CLOSE;
}
export function splitImageReferenceText(text: string): { text: string; references: ImageReference[] } {
  const references: ImageReference[] = [];
  const visible = text.replace(/<enki-image-reference-v1>([^\n]{1,16384})<\/enki-image-reference-v1>/g, original => {
    if (references.length >= 12) return original;
    try {
      const ref = imageReference(JSON.parse(original.slice(OPEN.length, -CLOSE.length)));
      if (ref) { references.push(ref); return ''; }
    } catch { /* Preserve unrecognized user text. */ }
    return original;
  });
  return { text: references.length ? visible.trim() : text, references };
}
