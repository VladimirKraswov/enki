// Client for the trusted native build-job port (`enki-build-runner
// --enki-build-job`, src-tauri/build_job.rs). No side effects at import.
//
// Trust: the runner is the receipt returned by build-runner.mjs bootstrapRunner,
// compiled in this preparation from the authenticated source into a fresh
// private directory and re-verified by hash before every use. There is no
// environment-configured, installed, discovered or candidate-supplied runner,
// and no unowned spawn fallback.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyRunner } from './build-runner.mjs';

const RESULT_OVERHEAD = 64 * 1024;

/** Exact runner path from a bootstrap receipt. Throws instead of falling back. */
export function trustedRunner(identity) {
  if (!identity) throw new Error('Windows preparation requires the native build runner bootstrapped from this source');
  return verifyRunner(identity);
}

function parseResult(text, kind) {
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('Native build runner returned no result'); }
  if (result === null || typeof result !== 'object' || result.schema !== 1 || result.kind !== kind) throw new Error('Native build runner returned an invalid result');
  return result;
}

/** One job through the native runner. Resolves with captured output on exit 0. */
export function runBuildJob(runner, { program, argv, cwd, env, timeoutMs, capture, maxOutputBytes = 1024 * 1024 }, { signal } = {}) {
  const request = JSON.stringify({ schema: 1, kind: 'run', program, args: argv, cwd: cwd ?? process.cwd(), env, timeoutMs, maxOutputBytes, capture });
  // JSON escaping can grow each byte to six characters; anything beyond is a protocol failure.
  const ceiling = maxOutputBytes * 6 + RESULT_OVERHEAD;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Build cancelled')); return; }
    // Hidden; its stderr carries streamed (non-captured) child output only.
    const runner$ = spawn(runner, ['--enki-build-job'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '', length = 0, failure;
    // Killing the runner closes its kill-on-close Job, which ends the whole tree.
    const stop = reason => { failure ??= reason; runner$.kill(); };
    const abort = () => stop(signal.reason ?? new Error('Build cancelled'));
    // Runner enforces timeoutMs itself; this outer bound only covers a stuck runner.
    const guard = setTimeout(() => stop(new Error('Native build runner did not finish')), timeoutMs + 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    runner$.stdout.on('data', chunk => { length += chunk.length; if (length > ceiling) stop(new Error('Native build runner result exceeds its bound')); else stdout += chunk.toString('utf8'); });
    runner$.once('error', error => { failure ??= error; });
    runner$.stdin.on('error', () => {});
    runner$.stdin.end(request);
    runner$.once('close', code => {
      clearTimeout(guard); signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`Native build runner refused the job (exit ${code})`)); return; }
      let result; try { result = parseResult(stdout, 'run'); } catch (error) { reject(error); return; }
      const name = path.basename(program);
      if (result.status === 'timeout') reject(new Error(`Build timed out: ${name}`));
      else if (result.status === 'output-limit') reject(new Error(`Build output exceeds ${maxOutputBytes} bytes`));
      else if (result.status !== 'exited') reject(new Error(`Build process state lost: ${name}`));
      // Never publish from a job whose owned tree was not proven settled.
      else if (result.reaped !== true) reject(new Error(`Build process tree did not settle (${result.scope ?? 'unknown'}): ${name}`));
      else if (result.code !== 0) reject(new Error(`${name} exited ${result.code}: ${String(result.output ?? '').slice(-2000)}`));
      else resolve(String(result.output ?? ''));
    });
  });
}

/** Durable directory flush through the native port (FlushFileBuffers on a
 * directory handle, exact link-free paths). Synchronous by design: callers are
 * journaled promotion steps that must not proceed before durability. */
export function flushDirectoriesSync(runner, directories) {
  if (!directories.length) return;
  const result = spawnSync(runner, ['--enki-build-job'], { input: JSON.stringify({ schema: 1, kind: 'flush-directories', paths: directories }),
    shell: false, windowsHide: true, timeout: 120_000, maxBuffer: RESULT_OVERHEAD, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error) throw new Error('Native directory flush did not complete', { cause: result.error });
  if (result.status !== 0) throw new Error(`Native directory flush refused: ${String(result.stderr).slice(0, 500)}`);
  const parsed = parseResult(result.stdout, 'flush-directories');
  if (parsed.status !== 'flushed' || parsed.count !== directories.length) throw new Error('Native directory flush returned an incomplete result');
}
