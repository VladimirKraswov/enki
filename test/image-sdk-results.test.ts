import { expect, it } from 'vitest';
import { toolOutputText } from '../src-tauri/resources/agent/src/sdk/history';
import { imageResult, turnImageResults } from '../src/images/results';

const base = 'file:///work/.enki/generated-images/01234567-1234-1234-1234-123456789abc/';
const names = ['image-01', 'normal', 'height', 'roughness', 'metallic', 'relight', 'relight-right', 'tile-preview'];
const result = { enkiImages: 1, status: 'completed', images: names.map(n => ({ name: `${n}.png`, url: `${base}${n}.png` })), archive: `${base}images.zip` };
const output = (text: string, images = 8) => toolOutputText([{ type: 'text', text }, ...Array.from({ length: images }, () => ({ type: 'image' }))]);

it('shows all material cards and ZIP from the actual SDK Vision tool-output projection, including reopened history', () => {
  const state = { output: output(JSON.stringify(result)) };
  expect(state.output).toContain('\n[изображение]');
  expect(turnImageResults([{ state }])).toEqual([result]);
  expect(turnImageResults(JSON.parse(JSON.stringify([{ state }])))).toEqual([result]);
  expect(turnImageResults([{ state }, { state: { output: JSON.stringify(result) } }])).toEqual([result]);
});

it('keeps the existing strict file-name, local-path and size restrictions for SDK image outputs', () => {
  for (const url of ['https://example.test/image.png', 'file:///etc/passwd']) {
    expect(imageResult(output(JSON.stringify({ ...result, images: [{ name: 'image-01.png', url }] })))).toBeNull();
  }
  expect(imageResult(output(JSON.stringify({ ...result, images: [{ name: 'private.png', url: `${base}private.png` }] })))).toBeNull();
  expect(imageResult(output(JSON.stringify({ ...result, note: 'x'.repeat(32768) })))).toBeNull();
});

it('accepts only bounded exact SDK image markers after the JSON, never arbitrary trailing text or another JSON value', () => {
  const json = JSON.stringify(result);
  for (const suffix of ['\nextra', '\n{}', '\n[изображение]\nextra', '\n[изображениеx]']) expect(imageResult(json + suffix)).toBeNull();
  expect(imageResult(output(json, 9))).toBeNull();
});
