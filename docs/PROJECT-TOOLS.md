# Project tools: `repo_inspect` and `safe_edit`

Two Enki-owned tools registered in every Enki Runtime session through the pinned
Pi SDK extension API. They replace the retired OpenCode helpers from
`integrations/opencode-agent/` (see [Retired legacy helpers](#retired-legacy-helpers)).

| Item | Location |
| --- | --- |
| Implementation | `src-tauri/resources/agent/src/extensions/project-tools.ts` |
| Registration | `enkiExtensions()` in `src-tauri/resources/agent/src/extensions/enki.ts` (inline extension `enki-project-tools`, once per session) |
| Path scope | `resolveProjectPath()` in `src-tauri/resources/agent/src/interaction/access-paths.ts` |
| Policy classification | `decide()` in `src-tauri/resources/agent/src/interaction/access.ts` |
| Tests (real pinned SDK and isolated project fixtures) | `test/project-tools.test.ts`, `test/integration/project-tools-policy.test.ts` |

Both tools are plain Node/TypeScript. They run no Python, `rg`, `git` or other
subprocess, import nothing from OpenCode and add no dependency. They act only
inside the **physical** session directory (the real path of the chat's folder).

## `repo_inspect`

Read-only navigation. Parameters (both optional, no others accepted):

- `query` — 2–120 characters on one line. Case-insensitive literal search.
  Returns `path` + first matching `line` per file, never the matching text.
- `path` — a project file. Returns a snapshot: `bytes`, `sha256` of the exact
  bytes, `encoding` (`utf-8`/`binary`/`invalid_utf8`), `safe_edit`
  (`ok`/`binary`/`invalid_utf8`/`hardlinked`), likely tests, and the
  root-to-leaf `AGENTS.md`/`CLAUDE.md`/`.pi/TASK.md`/`.opencode/TASK.md`
  and manifest files that apply to it. Their contents are not read.

Every call also returns the overview: physical root, root manifests and
instruction/checkpoint files, top-level folders, `packageManager` and npm script
**names** (not commands) from the root `package.json`, and the Git branch read
from `.git/HEAD` (a `.git` pointer file is not followed).

Likely tests keep the legacy ranking: test-like files (`*test*`, `*spec*`,
`__tests__/`) scored by the file stem's tokens, then — if fewer than 12 —
test files whose source mentions the stem (case-sensitive).

**Hits are navigation hints, not proof.** Read the file with `read` and run the
project's checks before relying on anything found.

### Scope and bounds

Never visited, searched, snapshotted or edited:

- symlinks (never followed: no cycles, no outside reads), FIFOs, sockets, devices;
- `.git`, `.hg`, `.svn`, `node_modules`, `target`;
- private folders `.local`, `.opencode-migration`, `.ssh`, `.gnupg`, `.aws`;
- credential-like names: `.env*`, `id_rsa*`/`id_dsa*`/`id_ecdsa*`/`id_ed25519*`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `*.gpg`,
  `*.asc`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`,
  `auth.json`, `credentials`, `credentials.json`, `secrets.json`;
- paths matched by `.gitignore` files inside the project (subset: comments, `!`,
  trailing `/`, anchored `/`, `*`, `?`, `[...]`, `**`, nested files per subtree;
  `.git/info/exclude` and global excludes are not read);
- search only: `*.lock` files; the overview additionally hides `dist`, `build`,
  `.next`, `.venv`.

Binary (NUL) and invalid UTF-8 files are skipped by search and counted.

| Bound | Value |
| --- | --- |
| File snapshot / search candidate | 2 000 000 bytes |
| Locations / likely tests / top-level / script names | 24 / 12 / 60 / 80 |
| Directory entries per walk | 50 000 |
| Files read / content bytes per walk | 10 000 / 64 MiB |
| Depth | 32 |
| Whole call deadline | 10 s |
| `.gitignore` size / rules | 64 KiB / 1 000 |
| `.gitignore` matching work | 16 000 000 character/state operations per walk or scoped target check, within its deadline |
| Output | 64 KiB JSON (longest lists are halved, `output_truncated: true`) |

When a bound stops the walk the result says so (`exhausted`: `entries`, `files`,
`bytes`, `time` or `depth`; `truncated: true`) instead of pretending the search
was complete. The walk is asynchronous, so it does not block other sessions.
Cancelling the turn aborts it.

An unreadable, linked, non-UTF-8, changed or oversized `.gitignore`, or more than
the supported rule budget, refuses the operation explicitly. It never becomes
an empty exclusion list that would allow an excluded edit. UTF-8 BOM is accepted.
Wildcard matching uses a bounded non-backtracking state machine; exhausted
matching work/deadline refuses instead of treating a path as not ignored.
Output bounding covers guidance/manifest lists too; a cut is flagged. If even
the essential identity fields cannot fit, the call refuses instead of returning
a response beyond the configured bound.

## `safe_edit`

One literal replacement in one project file. Parameters (all required):
`path`, `expected_sha256` (64 lowercase hex, from `repo_inspect` with `path`),
`old` (non-empty, exact, unique), `new` (different from `old`).

1. Validate input; resolve the physical path; refuse out-of-scope targets
   (outside the project, any symlink on the path, private/generated folders,
   credential-like names, `.gitignore`d paths).
2. Serialize with other `safe_edit` calls on the same physical file in this
   runtime process; the tool also runs sequentially within a turn.
3. Read the file without following a final symlink; refuse non-regular,
   hardlinked (`nlink ≠ 1`), larger than 2 000 000 bytes, binary or invalid
   UTF-8 files, and files owned by another user (a rename would change owner).
4. **Conflict, nothing written** when the current SHA-256 differs
   (`stale`), `old` is absent (`missing`, bytes and line endings must match)
   or occurs more than once, overlapping starts included (`ambiguous`).
5. Replace the bytes in place — BOM, CRLF/LF and every other byte stay exact —
   and stage the result as `.enki-safe-edit-<random>.tmp` in the same folder
   (exclusive create, original mode and group, `fsync`).
6. Recheck right before publication: the path still resolves to the same
   physical location, the same inode/device/size/mtime/ctime, single link, and
   identical bytes. Any difference is a `changed` conflict.
7. Publish by `rename`, then try to sync the folder (best effort on POSIX;
   Windows has no directory-sync guarantee from this helper).

On conflict, refusal or cancellation cleanup removes only the temporary file this
call created, checked by device/inode. If the parent was moved or the pathname
replaced and removal cannot be proven, a conflict carries `cleanup.state: unknown`
and the residual temporary basename; another failure reports that uncertainty
explicitly. There is no search or deletion elsewhere. Nothing foreign is deleted.
A cancellation after step7 cannot undo the published change.

### Race guarantees — honestly

- Same process: concurrent `safe_edit` calls on one physical file are
  serialized, so one applies and the other reports `stale`.
- Other processes (an editor, a build, another tool): the recheck narrows the
  window but a plain `rename` is **not** compare-and-swap. A change made between
  the final recheck and the rename can be replaced. A swap of a parent folder
  in that window is likewise not excluded. Pure Node path checks do not pin
  directory ancestors against a concurrent external swap during reads either;
  these helpers are not an OS filesystem sandbox. Use project ownership and
  review for concurrent work. A moved temporary may need manual reconciliation;
  unconfirmed cleanup is never reported as clean.
- The SDK's built-in `edit`/`write` keep their own per-file queue; `safe_edit`
  does not join it (the SDK value import is confined to `sdk/adapter.ts`).
  Within a turn `safe_edit` runs sequentially; another session's built-in
  `edit` of the same file is covered only by the hash recheck.
- Case-insensitive file systems: two spellings of one file are different lock
  keys; the hash recheck still applies.

### Conflict recovery

1. Read the file again (`read`), then `repo_inspect` with `path` for the new
   SHA-256.
2. Rebuild `old` from the current text; widen it until it is unique.
3. Retry once with the new hash. Never overwrite the whole file to get past a
   conflict and never repeat the same call unchanged.

## Enki policy

The tools pass the same runtime gate as every SDK tool; there is no tool-local
authorization.

| Access mode | `repo_inspect` | `safe_edit` |
| --- | --- | --- |
| Только чтение (`read` preset or inherited `read`) | runs | refused, no dialog |
| С подтверждением (`ask`) | runs (classified as `read`) | one permission request `edit` for the exact physical file |
| Полный доступ (`full`) | runs | runs, no prompt |

- `repo_inspect` is classified as permission `read` with target = the
  snapshot file or the project root; `safe_edit` as permission `edit` with the
  physical file. Authored rules (`edit` deny for `src/*`, …) apply as for the
  built-ins; last match wins.
- "Always" stores the existing durable, session-scoped observed grant for
  exactly `safe_edit` on that file. It does not cover other files or the
  built-in `edit`, and a later deny rule still wins.
- A request already waiting when the chat's access changes is re-evaluated once
  by policy (full → runs, read → refused), as for every tool.
- Outside or aliased (symlinked) targets are refused by the gate before any rule
  or prompt, even with full access; the tool refuses them again on execution.
  Their input is never rewritten by the path preparation step, so the
  classified and executed location is the same or the call fails.
- The classification applies only while the **effective** registration of the
  name is Enki's (`sourceInfo.path` of the inline extension, exactly one
  registration). A plugin loaded earlier that reuses `repo_inspect` or
  `safe_edit` wins the SDK name resolution; it is then an unknown tool
  (all-argument identity, asks in ask mode, refused in read mode) and never
  inherits the read-only classification.
- Shared MCP tools see these names as reserved, like other registered tools.

Limitation: the permission dialog title comes from the general gate
(`pi/tool-gate.ts`), which lists only built-in mutating tools; a `safe_edit`
request shows the generic "Агент запрашивает действие" title with the `edit`
permission and the file path.

## Retired legacy helpers

The fourteen legacy files under `integrations/opencode-agent/` (an OpenCode
installer, Python implementations, wrappers, role prompts, tests and incident
replay) were retired from maintained delivery after their SDK replacements and
permission policy passed. Their exact historical source remains at
[commit 67e359994031cbdd3eac080924b22f603bc9597b](https://github.com/VladimirKraswov/enki/tree/67e359994031cbdd3eac080924b22f603bc9597b/integrations/opencode-agent)
and in the coordinator's archived inputs. The interrupted external author pass
was not treated as a complete result; local changes were reviewed and qualified
separately. Do not run the historical `install.py`: it writes to an owner's
OpenCode configuration. Owner-installed OpenCode/Pi CLIs, configurations and data
are untouched by Enki.

| Legacy behavior | Now |
| --- | --- |
| `repo_inspect.py` via `python3` + `rg`, OpenCode wrapper | `repo_inspect` SDK tool, Node walk |
| `file` argument | `path` (shared with Enki path classification); unknown arguments are rejected |
| `./src/x` result paths | `src/x` |
| `git status --short` / `git diff --stat` in the map | **Retired.** Running `git` from an auto-allowed read-only tool can execute programs configured by the repository itself (for example `core.fsmonitor` during `git status`) while the chat is in read mode. Equivalent: the Enki review panel, or `bash` `git status`/`git diff --stat` under the gate. The map keeps the branch from `.git/HEAD`. |
| ripgrep `.gitignore` semantics | documented subset above |
| rg searched invalid UTF-8 lossily | skipped and counted |
| snapshot of any regular file | ignored, generated, private and credential-like files refused |
| `safe_edit.py` via `python3`, OpenCode `context.ask("edit")`, `qwen-review` agent check | `safe_edit` SDK tool; Enki gate (`edit`, read mode refuses) |
| Python `str.count` (non-overlapping) | overlapping occurrences count as ambiguous |
| hardlink refusal, mode preservation, recheck, temp cleanup | kept; plus group/owner check, inode-checked cleanup, path re-resolution, same-process lock |
| `install.py`, `test_install.py`, `fixtures/repo_inspect.pre.ts` | no installer: the tools ship inside the runtime |
| `qwen-coding.md`, `qwen-review.md` | tool descriptions and `promptGuidelines`; Enki access modes replace the reviewer agent's permission block |
| `evals/` incident replay | archived historical evidence ([EVALUATIONS](EVALUATIONS.md)); not replayed or ported |

Historical claims about the 2026-09-27 OpenCode installation in
[AI-ENVIRONMENT](AI-ENVIRONMENT.md) and [VERIFICATION](VERIFICATION.md) remain
historical evidence; they do not describe the current runtime.
