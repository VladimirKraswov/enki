# Reproducible task evaluation (M39)

This is a test harness, not another production agent loop. It submits one task
to an agent loop, waits under a deadline, checks the actual outcome, records the
result and removes its own temporary project. It does not resume owner chats or
change installed agents/settings. Local GPU inference requires explicit opt-in
through the local adapter below. No history, screenshots, secrets or private
project code is sent.

Execution adapters (`--agents`, comma-separated):

* `pi-sdk` — **default**. The exact Pi SDK that Enki bundles: the package from
  the reviewed agent lock (`src-tauri/resources/agent`, version checked against
  `scripts/runtime/sdk-contract.mjs`), started through that package's own CLI
  entry with the current Node. It measures the product's agent loop and tools
  policy for fixture tools; it does not include Enki's runtime daemon, queues,
  permissions UI or Hub reservation. Install it with
  `npm ci --prefix src-tauri/resources/agent --ignore-scripts`.
* `opencode`, `pi` — **retired** external-CLI baselines: the runner refuses them
  (`EVAL_ENGINE_RETIRED`) and never launches an independently installed CLI.
  Their historical 2026-10-08 reports and event streams stay readable
  (`parseAgentEvents`); installed CLIs on the machine are left untouched.

## Offline contract checks

Node 24+ and the repository dependencies are required:

```sh
npm ci
npm run eval:check          # fixture self-check + adapter contract tests
npx vitest run test/evaluations.test.ts
```

Nine code/recovery tasks have broken starting implementations and independent
assertions outside the agent-visible filesystem. The offline replay checks that
each baseline fails and its reference implementation passes. Three browser tasks
use a synthetic discount form: normal save, rejected input followed by correction,
and a viewport/scroll change requiring fresh observation. CI tests the form's
contract using jsdom; live browser trials require real Playwright Chromium.
The CI workflow has no live provider credentials or model calls.

## Live paired trials (explicit opt-in)

Install the pinned SDK (above). Supply `DEEPSEEK_API_KEY` in the parent
environment, or explicitly pass `--key-file /private/path/to/auth.json` (the
historical OpenCode `auth.json` shape; only `deepseek.key` is read).
Never commit the key file. The harness reads only its DeepSeek credential; it
does not import global agent configuration. Start with a smoke test:

The historical live executions (2026-10-08 reports) used the external CLIs on
macOS. The `pi-sdk` adapter has not yet had a live run; Windows/Linux live
execution remains unverified and CI runs only the engine-independent contracts.

```sh
npm run eval:live -- --cases zero-value --repeats 1 --output .local/evaluations/smoke
```

Two repeats (the AB/BA alternation applies to memory/navigation modes; the
historical cross-engine comparison is no longer repeatable live):

```sh
npm run eval:live -- --repeats 2 --timeout 120 --total-timeout 1800 \
  --playwright-module /absolute/path/to/playwright/index.mjs \
  --browser-executable /absolute/path/to/chromium \
  --output .local/evaluations/paired
```

Playwright can be a separate existing installation. Only the executable is
reused: a new temporary browser profile is created and removed for each trial.
There is no connection to Enki's live browser. The fixture has no network origin
and all page requests are blocked. These trials use reference-based fast actions;
they do not establish mouse-emulation or packaged UI acceptance.

The default model is the official `deepseek-flash`. Only `medium` and `off` are
accepted by this first cloud adapter. A loopback gateway normalizes both agents'
requests to identical model/effort/output settings. DeepSeek maps requested
Medium to High; the report records both rather than inventing a distinct Medium
setting. See [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).

For the separately authorized local Qwen Flash Next qualification, use
`--provider local-qwen --base-url http://127.0.0.1:18019/v1`. This adapter accepts
only a credential-free HTTP loopback `/v1` URL, rejects redirects and cloud key
files, checks that `qwen38-flash-next` and the requested Medium effort are
advertised, and records a wrong served model as a failure. No DeepSeek credential
is read in local mode. Both agents receive the same Medium request, thinking
template and production sampling (temperature 1, top-p 0.95, top-k 20); the 4096
output-token and fixture request/token limits remain unchanged. The model's
advertised context is recorded; these small tasks do not qualify a full 262K
conversation. Local upstream timeout is 240s; use `--timeout 300` for the whole
agent trial, preserving the bounded total deadline and every failed outcome.
The gateway reads cache hits from DeepSeek's `prompt_cache_hit_tokens` or the
OpenAI `prompt_tokens_details.cached_tokens` and records how many responses
actually supplied cache detail. An absent detail is not proof that caching was
disabled; total prompt/output usage remains separate from this partial counter.

```sh
npm run eval:live -- --provider local-qwen \
  --base-url http://127.0.0.1:18019/v1 --cases zero-value --repeats 1 \
  --timeout 300 --output .local/evaluations/local-protocol
```

Long matrices can continue into a fresh report with `--trial-offset N`, preserving
the original cases/agents/modes/repeats and AB/BA order. N is the number of already
attempted plan entries, including failures. There is no result import, overwrite
or automatic retry: retain the earlier report, list both sets of source revisions,
and disclose any separately repeated trial interrupted by the total deadline.
Each continuation has its own bounded time/resource budget and records its exact
remaining plan. Never select an offset to remove failed outcomes from a comparison.
Tool diagnostics retain only counts under a fixed error-code vocabulary; unknown
errors become `TOOL_FAILED`. Filesystem paths, error messages, argument payloads
and model reasoning are not included in these counters.

Every adapter has only scoped fixture tools: list/read/write for code tasks or
snapshot/action for browser tasks. The OpenCode baseline receives them through
stdio MCP; `pi-sdk` and the Pi baseline use an explicit extension
(`scripts/evaluations/pi-extension.ts`) against the same backend. Built-in shell/network/file
tools, skill discovery, owner instructions and global extensions are disabled.
The real provider key remains in the parent gateway, not agent config/argv.
Disposable HOME/XDG/Pi paths isolate engine storage. This is a bounded synthetic
evaluation environment, not a security sandbox for executing hostile code:
grading adds Node filesystem/process permissions and a deadline, but arbitrary
untrusted repositories require a separate OS/container sandbox.

## Limits, evidence and interpretation

Defaults: 18 requests / 60K reported tokens per trial, 4096 output tokens per
request, 400 requests / 1M tokens per run, 120 seconds per agent and 30 minutes
per run. `--total-tokens`, `--total-requests`, `--timeout`, `--total-timeout` accept
bounded overrides. Resource admission is checked between responses; one admitted
response can overshoot a token budget. Provider retries also go through the
gateway limits. SIGINT/SIGTERM stop owned processes and clean up temporary files
and the browser. Never kill a separately managed server.

Internal concurrent CLI requests (such as title and answer) are serialized at
the gateway so admission observes the previous response's usage. An exhausted
evaluation budget returns permanent HTTP 403 rather than a retryable rate limit.

`report.json` and `report.md` are written after every trial; choose a new output
directory for each run. They contain fixture/tool SHA256 revisions, CLI versions,
model/requested/effective effort, skill revisions (empty when disabled), verified
completion time, provider usage/cache counts, agent-reported usage, tool errors,
stale-action refusals and owner interventions (zero for this unattended runner).
Raw reasoning, prompts, tool outputs, endpoints, temporary absolute paths and
credentials are not retained. Synthetic candidate modules are saved separately
with SHA256 for later inspection; they must never be executed as trusted scripts.
Schema 2 records elapsed time for every trial and time to verified result only
for passes (null for failures), plus Node/platform/browser versions and the model
identifier returned by the provider when available. Historical schema 1's
`verifiedSeconds` field represents elapsed time even for a failed outcome.
Unknown/partial usage remains explicit. Provider totals
include all requests admitted for that CLI, including internal title requests;
they can differ from the agent's visible step totals.

PASS requires independent outcome assertions and a successful completed agent
run without model/budget errors. A timeout, missing dependency, refused budget,
provider error or wrong result remains a failure. Nonzero runner exit means
failed/incomplete evidence, not permission to erase/retry it until green.
The initial suite covers deliberately small tasks; it cannot establish local
Qwen throughput, complex-project quality or skill effectiveness. Add harder
versioned tasks and repeat the same checks before promoting M40/M41 retrieval.

Historical accepted-fix replay (three offline incident cases recorded on
2026-09-27) is archived evidence, not a current gate. Its case IDs, repositories,
revisions and recorded results are preserved in the immutable
[original sources](https://github.com/VladimirKraswov/enki/tree/67e359994031cbdd3eac080924b22f603bc9597b/integrations/opencode-agent/evals).
It is separate from cloud-safe synthetic fixtures and must never send owner
project sources to a cloud model implicitly. Current project helpers are the
bundled SDK tools documented in [PROJECT-TOOLS.md](PROJECT-TOOLS.md).


## M41 memory comparison

`--memory off` is the unchanged default. `tools` exposes a bounded optional search;
`context` prepares synthetic reference facts before the agent starts. `compare`
runs all three modes for each fixture/agent, reversing mode and agent order on
repeat2. Preparation/backend setup time is charged. Each trial has a distinct
mode-specific candidate filename. Python3 is required for memory modes; they
use production Hub retrieval in a disposable SQLite database. No solutions,
owner memory, vault credentials or private sessions enter this comparison.

```sh
npm run eval:live -- --memory compare --cases zero-value,idempotent-usage,stale-edit \
  --repeats 2 --output .local/evaluations/memory-comparison
```

[Actual 36-trial result](evaluations/2026-10-08/retrieval/REPORT.md): no stable
speed/quality benefit, so app automatic context preparation stays unimplemented.
The eval adapter and native MCP differ in transport; compare trends, not a
claim of native latency. Native SDK/Pi/OpenCode acceptance is separate.

## M44 miniature projects (suite 2.0.2, report schema 3)

The suite now has 16 tasks: the original 12 plus three synthetic multi-module
projects and a two-product browser workflow with validation and stale-state
recovery. They are miniature projects (five files each), not large-repository
benchmarks. The three domains exercise checkout arithmetic/validation/idempotence,
durable outbox delivery/uncertainty and engine/server/session routing/generation.

Each project has protected README/architecture/entrypoint files, editable domain
modules, a bounded `check` tool with public smoke assertions, and additional
held-out grading outside the agent-visible files. Protected files are checked
again during grading. Both engines receive the same file/check capability policy;
there is no arbitrary shell, installed app, owner checkout or live database.
Each project trial retains all five candidate files with SHA256 (not merely its
entrypoint). Public check success is not a substitute for held-out acceptance.

```sh
npm run eval:live -- --cases project-checkout,project-outbox,project-session-router,browser-workflow \
  --repeats 2 --timeout 180 --total-timeout 1800 \
  --playwright-module /absolute/path/to/playwright/index.mjs \
  --browser-executable /absolute/path/to/chromium \
  --output .local/evaluations/projects
```

Schema 3 retains full elapsed-to-grading and successful verified time separately,
plus setup, CLI execution and grading phases. Tool durations/check durations and
provider request first-content/elapsed timings are numeric only; they are not
summed into elapsed (overlap/other setup may exist). First-content timing is
observed at the evaluation gateway, includes visible reasoning/tool proposals,
and does not claim isolated model TTFT/prefill. Internal title calls remain in
provider request/usage totals. Unreported usage/response timestamps remain unknown.

Compare agents on identical new tasks/repetitions. Do not compare their absolute
medians with M39's single-function fixtures and claim a regression or acceleration.
The browser workflow uses real isolated Chromium and semantic refs, not installed
Enki mouse-emulation acceptance. No production model or owner project is tested.

## M45 optional project map (suite 2.1.0)

Use `--cases project-checkout,project-outbox,project-session-router --navigation compare --repeats 2` for a paired off/tools comparison with AB/BA ordering. Tool mode calls the same read-only production map core against the synthetic project. It neither injects context nor changes task/assertion budgets. Every report distinguishes navigation mode and records map calls. Source revisions, per-file candidates and failed outcomes remain preserved. See [map boundaries](PROJECT-NAVIGATION.md).
