import { afterEach, expect, it, vi } from 'vitest';
import { turnImageResults } from '../src/images/results';

const base = 'file:///work/.enki/generated-images/01234567-1234-1234-1234-123456789abc/';
const output = (name: string) => JSON.stringify({ enkiImages: 1, status: 'completed', images: [{ name, url: base + name }], archive: base + 'images.zip' });
afterEach(() => vi.restoreAllMocks());

it('a streamed turn parses each tool output once; a replaced part is parsed again; cards stay per part', () => {
  const parse = vi.spyOn(JSON, 'parse');
  const bulky = { state: { output: JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i })) }) } };
  const image = { state: { output: output('image-01.png') } };
  const parts = [bulky, image, { state: { output: 'plain text' } }, {}];
  for (let delta = 0; delta < 50; delta++) expect(turnImageResults(parts).map(r => r.images.map(i => i.name))).toEqual([['image-01.png']]);
  // Non-image outputs never reach JSON.parse; the image output once, not per render.
  expect(parse).toHaveBeenCalledTimes(1);
  // The reducer replaces a changed part (new state object): its new result is used.
  const redrawn = [bulky, { state: { output: output('normal.png') } }];
  expect(turnImageResults(redrawn)[0].images[0].name).toBe('normal.png');
  expect(turnImageResults(redrawn)[0].archive).toBe(base + 'images.zip');
  expect(parse).toHaveBeenCalledTimes(2);
});
