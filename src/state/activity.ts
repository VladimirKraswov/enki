import type { AppState } from './types';

/** Live activity overrides an older directory snapshot for the SAME session.
 * This is a UI hint only; maintenance/config writes still require the runtime's
 * authoritative idle gate (including tools and pending interactions). */
export function hasActiveSessions(state: Pick<AppState, 'statuses' | 'activityStatuses'>): boolean {
  return Object.values({ ...state.statuses, ...state.activityStatuses }).some(status => status.type !== 'idle');
}
