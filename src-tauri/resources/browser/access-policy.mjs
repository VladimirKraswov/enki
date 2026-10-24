import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { executionFeedback } from './execution-feedback.mjs';
// User-selected full access is a session policy, including its delegated work.
// Role prompts remain intact; loop-guard compatibility is handled by the client adapter.
export const fullRules = () => [
  { permission: '*', pattern: '*', action: 'allow' },
  { permission: 'external_directory', pattern: '*', action: 'allow' },
  { permission: 'doom_loop', pattern: '*', action: 'allow' },
];
export function isFull(rules) {
  const tail = Array.isArray(rules) ? rules.slice(-2) : [];
  return JSON.stringify(rules?.slice(-fullRules().length)) === JSON.stringify(fullRules()) ||
    JSON.stringify(tail) === JSON.stringify(fullRules().slice(0, 2)) ||
    JSON.stringify(tail) === JSON.stringify([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'doom_loop', pattern: '*', action: 'ask' },
    ]);
}
// Sessions retain their original paths across app-owned directory migrations.
// Compare filesystem identity only on a mismatch; never infer it from names/suffixes.
async function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !isAbsolute(left) || !isAbsolute(right)) return false;
  if (left === right) return true;
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)]);
    return a === b && (await stat(a)).isDirectory();
  } catch { return false; }
}
export async function sessionAccess(client, directory, sessionID) {
  const seen = new Set(); let current;
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(sessionID)) throw new Error('Cyclic session ancestry');
    seen.add(sessionID);
    const response = await client.session.get({ path: { id: sessionID }, query: { directory }, throwOnError: true, signal: AbortSignal.timeout(10000) });
    const session = response.data;
    if (!session || session.id !== sessionID || !(await sameDirectory(session.directory, directory)))
      throw new Error('Session access context unavailable');
    current ??= session;
    if (!session.parentID) return { full: isFull(session.permission), current, root: session };
    sessionID = session.parentID;
  }
  throw new Error('Session ancestry limit reached');
}
export default async function accessPolicy({ client, directory }) {
  return {
    'tool.execute.before': async (input, output) => {
      if (!/^mesh_enki_images_[a-z0-9_]+$/.test(input.tool)) return;
      if (typeof input.sessionID !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.sessionID))
        throw new Error('Image call requires a valid agent session');
      output.args.__enkiImageContext = { engine: 'opencode', sessionID: input.sessionID };
    },
    'tool.execute.after': async (input, output) => {
      const feedback = executionFeedback('opencode', input.tool, output.output);
      if (!feedback) return;
      output.output += `\n\n${feedback.message}`;
      output.title = 'Команда остановлена по таймауту';
      output.metadata = { ...output.metadata, enkiExecution: { outcome: feedback.outcome } };
    },
    'chat.message': async input => {
      const { full, current, root } = await sessionAccess(client, directory, input.sessionID);
      if ((!current.parentID && !full) || (full
        ? JSON.stringify(current.permission?.slice(-fullRules().length)) === JSON.stringify(fullRules())
        : !isFull(current.permission))) return;
      const permission = full ? fullRules() : root.permission?.length ? root.permission : [
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'external_directory', pattern: '*', action: 'ask' },
      ];
      const response = await client.session.update({ path: { id: current.id }, query: { directory },
        body: { permission }, throwOnError: true, signal: AbortSignal.timeout(10000) });
      if (!response.data || response.data.id !== current.id
        || !(await sameDirectory(response.data.directory, directory))
        || isFull(response.data.permission) !== full)
        throw new Error('OpenCode did not apply inherited full access');
    },
  };
}
