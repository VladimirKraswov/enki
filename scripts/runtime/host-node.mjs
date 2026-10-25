// Host interpreter guard shared by every runtime CLI entry. NO imports: an
// entry checks the host here BEFORE it loads modules that statically import
// node:sqlite (artifact leases, the remote installer), so an unsupported Node
// gets an actionable message instead of ERR_UNKNOWN_BUILTIN_MODULE.

/** null when this host can run runtime preparation/installation: unflagged
 * node:sqlite needs 22.13+/23.4+. The bundled runtime itself always uses the
 * pinned Node of runtime-lock.json; 24.22.1 is the qualified host. */
export function hostNodeProblem(version = process.version, action = 'Preparing the bundled agent runtime', consequence = 'no app was built') {
  const match = /^v(\d+)\.(\d+)\.\d+/.exec(String(version));
  if (match) {
    const major = Number(match[1]), minor = Number(match[2]);
    if (major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13)) return null;
  }
  return `${action} needs host Node.js >=22.13 (qualified 24.22.1); found ${version}. Install a supported Node.js and retry; ${consequence}.`;
}

/** Entry helper: refuse an unsupported host, otherwise load `module` lazily and
 * run its exported `main(argv)`. Resolves the process exit code. */
export async function guardedMain(label, module, argv, { version = process.version, action, consequence, load = specifier => import(specifier) } = {}) {
  const problem = hostNodeProblem(version, action, consequence);
  if (problem) { console.error(`${label}: ${problem}`); return 1; }
  const { main } = await load(module);
  return await main(argv);
}
