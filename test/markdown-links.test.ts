// Markdown links opened externally are absolute http(s) only. Written, NOT RUN.
import { expect, it } from 'vitest';
import { safeExternalUrl } from '../src/util/markdown';

it('opens only absolute http(s) addresses; relative paths and other schemes stay text', () => {
  expect(safeExternalUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
  expect(safeExternalUrl('http://localhost:8080/')).toBe('http://localhost:8080/');
  for (const bad of [null, '', 'src/a.ts', './README.md', '/etc/passwd', '#anchor', '//evil.example/x', 'javascript:alert(1)',
    'file:///Users/x/a.txt', 'data:text/html,<b>x</b>', 'mailto:a@b.c', 'http://'])
    expect(safeExternalUrl(bad), String(bad)).toBeNull();
});
