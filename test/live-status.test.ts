import { expect, it } from 'vitest';
import { liveStatusConfirmed } from '../src/state/sidebar';
import { executionEvidence } from '../src/chat/execution';

const open = { phase: 'connected' as const, streamState: 'open' as const, globalStreamState: 'open' as const, statusError: null };

// Regression: the chat-row rule was gated on a constant `isPiSession() === true`,
// so a busy spinner stayed "confirmed" while the runtime event stream was down.
it('a running chat or project is confirmed only while the runtime-wide stream is open', () => {
  expect(liveStatusConfirmed(open, '/p', '/p')).toBe(true);
  for (const state of ['idle', 'connecting', 'reconnecting', 'closed', 'error'] as const)
    expect(liveStatusConfirmed({ ...open, globalStreamState: state }, '/p', '/p')).toBe(false);
  // Before the global stream reports, the project stream state is used.
  expect(liveStatusConfirmed({ ...open, globalStreamState: undefined, streamState: 'reconnecting' }, '/p', '/p')).toBe(false);
  expect(liveStatusConfirmed({ ...open, phase: 'disconnected' }, '/p', '/p')).toBe(false);
  // A status read failure affects only the current project.
  expect(liveStatusConfirmed({ ...open, statusError: 'EACCES' }, '/p', '/p')).toBe(false);
  expect(liveStatusConfirmed({ ...open, statusError: 'EACCES' }, '/other', '/p')).toBe(true);
});

it('an unfinished tool shows as running only with a busy server AND a live stream', () => {
  expect(executionEvidence(false, true, true)).toBe('active');
  expect(executionEvidence(false, true, false)).toBe('unconfirmed');
  expect(executionEvidence(false, false, true)).toBe('inactive');
  expect(executionEvidence(true, true, false)).toBe('inactive');
});
