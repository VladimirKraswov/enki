// Launch argument policy, side-effect free so it is testable (main.ts runs on
// import). Nothing here reads the filesystem or changes HOME.
import os from 'node:os';
import path from 'node:path';
import type { LaunchConfig } from './daemon-control.ts';

export interface Args extends LaunchConfig { mode: 'supervised' | 'daemon' | 'ensure' | 'stop' }
export const PROFILE_ENV = 'ENKI_PROFILE_DIR';

/** An explicit isolated installation (native ENKI_PROFILE_DIR, present even when
 * empty or invalid) never falls back to owner-home defaults: its data root and
 * every legacy source must be named explicitly by the trusted launcher, so the
 * owner's ~/.pi/agent can never be imported into it implicitly. Without a
 * profile the historical production defaults are unchanged. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, home: () => string = os.homedir): Args {
  const value = (flag: string) => { const index = argv.indexOf(flag); if (index < 0) return undefined; const next = argv[index + 1]; if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`); return next; };
  const profiled = Object.prototype.hasOwnProperty.call(env, PROFILE_ENV);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const mode = command === 'ensure' ? 'ensure' : command === 'stop' ? 'stop' : value('--mode') === 'daemon' ? 'daemon' : 'supervised';
  const explicitData = value('--data');
  if (explicitData === undefined && profiled) throw new Error('--data is required for an explicit Enki profile');
  const data = explicitData ?? path.join(home(), '.local/share/enki/runtime');
  if (!path.isAbsolute(data)) throw new Error('--data must be absolute');
  const portValue = value('--port'), port = portValue === undefined ? undefined : Number(portValue);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('--port must be 1..65535');
  const startOwner = value('--start-owner'); if (startOwner && !/^[A-Za-z0-9_-]{43}$/.test(startOwner)) throw new Error('Invalid startup lease');
  const userPiAgentDir = value('--user-pi-agent-dir') ?? (profiled ? undefined : path.join(home(), '.pi/agent'));
  return { mode, data, port, agentDir: value('--agent-dir'), opencodeDb: value('--opencode-db'), piCliRoot: value('--pi-cli-root'), userPiAgentDir, startOwner };
}
