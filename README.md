# Pi-Dyna-Model

A **virtual model extension** for [pi](https://github.com/earendil-works/pi-coding-agent) that plans on a strong model and implements on a cheap one.

Registering the extension adds a model named **`dyna/auto`** to pi. When selected, every request is routed automatically to one of two physical models depending on which *phase* of work the session is in:

| Phase | Model (default) | Purpose |
|---|---|---|
| `plan` | `neural-watt/glm-5.3` (strong) | Reasoning, architecture, test authoring, plan documents, docs |
| `implement` | `neural-watt/glm-5.3-flash` (cheap) | Mechanical source edits, running test suites, compaction summaries |

The result: you pay flagship-tier reasoning for the part of the work where reasoning actually pays, and flash-tier cost for the mechanical long tail — with **one prompt-cache miss per unit of work**, because the phase only flips once per unit.

---

## How it works

### The phase fold

The phase is not stored as a counter or a state machine on disk. It is computed by **folding over the session transcript, in order**, looking at every assistant tool call and its result. The *latest* signal wins:

- A **successful `edit`/`write` of a source file** → phase becomes `implement`.
- A **bash command matching the test-suite pattern** → phase becomes `implement` (the moment the call is made; a red failing run still counts as implementation having begun).
- A **successful `git checkout`/`git switch` to a trunk branch** (the DONE transition) or a **successful new-branch checkout** → phase resets to `plan`.

The transcript is authoritative while it carries signals. For transcripts that were **compacted before any signal occurred** (so the fold finds nothing), the router falls back to persisted state stored on the session branch under `pi.virtual-model-state` — so a mid-implementation compaction doesn't silently reset you to the planning model, and a stored `plan` reset survives later compactions too. State survives forks and `/tree` navigation.

### Conditions under which the model auto-switches

**plan → implement** (any one of these, *successful*):

1. **A source-file edit or write.** Any `edit`/`write` tool call that succeeds on a path that is:
   - *not* a test file: `.spec.ts`/`.test.ts` and friends (`.spec.[cm]?[jt]sx?`, `.test.[cm]?[jt]sx?`, `supabase/tests/`, `__tests__/`), and
   - *not* non-code: `.scratch/`, `kanban/`, `docs/`, or any `*.md` file.
   
   Test authoring and plan/doc writing stay on the planning model; the first *real* source change flips you over.

2. **A test-suite command is issued.** The bash command matches the `testCommand` regex. The default pattern is:

   ```
   (^|[;&|(]\s*)((npx\s+)?vitest|npm\s+(run\s+)?test|supabase\s+db\s+test|npm\s+run\s+check:emit-loss)\b
   ```

   It is **anchored to command starts** (or after `&&`, `;`, `|`, `(`) so probes like `ls vitest.config.*` or prose mentioning "vitest" inside another command (`kanban-md edit 524 -a "note about vitest suite"`) do *not* match. A failing (red) run still counts — issuing the test run is itself the switch into implementation.

**implement → plan** (the DONE transition, *successful* only):

3. **A git return to a trunk branch**, i.e. `git checkout <branch>` or `git switch <branch>` where `<branch>` is one of `resetBranches` (default `main`, `master`). This models "the feature is merged, work is done" — so the *next* issue in the same session plans on the strong model again. `git checkout main-wip` does **not** reset (branch names are matched with a negative lookahead so `main-wip`/`main.dev` don't match `main`).

4. **A git new-branch checkout**, i.e. `git checkout -b …`, `git checkout -B …`, or `git switch -c …` (also inside a compound command like `kanban-md move 507 in-progress --claim storm-dune && git checkout -b feature/507-x`). Starting a new branch means starting a new unit of work, which starts in the planning phase.

All git transitions require the command to have **succeeded** (a failed checkout does not reset the phase).

**No signal at all** (fresh session, or a compacted transcript with no recorded signals) → the session is in the `plan` phase.

### Routing details

- **In-loop requests** (the normal agent loop) are routed by the phase above.
- **Direct/out-of-loop requests** — compaction summaries, extension calls — always route to the *implementation* model at `implementThinking`: they are mechanical by nature.
- **Retries are sticky by construction** — a retry carries the same transcript, so the fold yields the same phase.
- **Thinking effort follows the phase**:
  - `plan` phase → dispatched at your currently-selected thinking level, or `planThinking` if configured.
  - `implement` phase and direct requests → dispatched at `implementThinking`, default `"high"`, so the flash-tier implementation model still self-checks its edits (unbalanced syntax, broken imports, and shallow fix loops are where careless generation actually costs time).
- **Manual override** at any time:
  - `/model <physical-model>` — pi's normal per-request override, or
  - `/dyna plan` or `/dyna implement` — an in-band phase pin that **holds until the next transcript signal** (edit, test run, or git boundary), after which the fold takes over again. The pin is anchored against the signal it was made on, so re-issuing the same signal doesn't immediately expire it; a *new* signal does.

### Virtual model surface

`dyna/auto` registers with:

- thinking levels: `low`, `medium`, `high`, `xhigh`
- context window: 400,000 tokens

---

## Setup

### 1. Install as a pi extension

Clone the repo and point pi at it, either globally or per-project:

```bash
# Global — available in every session
pi extension add /path/to/Pi-Dyna-Model

# or per-project
cd my-project
pi extension add /path/to/Pi-Dyna-Model
```

(Alternatively, add the directory to the `extensions` array in `~/.pi/agent/settings.json` or the project's `.pi/settings.json`.)

The extension is a single TypeScript file (`index.ts`) with peer dependencies on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, both provided by pi itself at runtime — no separate `npm install` is needed to *use* it.

### 2. Select the model

```
/model dyna/auto
```

or set it as your default model in `~/.pi/agent/settings.json`:

```json
{ "defaultModel": "dyna/auto" }
```

### 3. (Optional) Configure

Settings live under a `dynaModel` key. **Project settings (`.pi/settings.json` in the repo) override global settings (`~/.pi/agent/settings.json`)**, merged key-by-key as pi does. Config is **re-read on every routed request** — changes take effect on the next request, no `/reload` needed.

```json
{
	"dynaModel": {
		"plan": "neural-watt/glm-5.3",
		"implement": "neural-watt/glm-5.3-flash",
		"testCommand": "vitest|npm (run )?test|supabase db test|check:emit-loss",
		"resetBranches": ["main", "develop"],
		"planThinking": "high",
		"implementThinking": "high"
	}
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plan` | `"provider/model-id"` | `neural-watt/glm-5.3` | Planning model. Must contain a `/`; invalid values fall back to the default. |
| `implement` | `"provider/model-id"` | `neural-watt/glm-5.3-flash` | Implementation model. Same validation. |
| `testCommand` | regex source (string) | see above | Bash commands matching this flip the session to the implementation phase. Invalid/empty values fall back to the default. |
| `resetBranches` | `string[]` | `["main", "master"]` | Trunk branches whose successful checkout resets to the planning phase. List every branch you merge feature work back into (e.g. `["main", "develop"]`) so repos branching off a non-`main` parent reset at their own merge gate. Names are matched literally; empty/non-string entries are dropped, and an all-invalid list keeps the defaults. |
| `planThinking` | thinking level | *(pass-through)* | Thinking level for the planning phase. Omit to dispatch at your selected level. Invalid values are ignored. |
| `implementThinking` | thinking level | `"high"` | Thinking level for the implementation phase and direct requests. Set `"low"` to trade edit quality for speed. |

Valid thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

### GLM-5.3 thinking levels

GLM-5.3's real ladder is `low` / `high` / `max` — reasoning is always on and cannot be disabled. Pi sends your `thinkingLevelMap` values verbatim as `reasoning_effort`, so the map in `~/.pi/agent/models.json` must expose `"low": "low"` for a `"low"` dispatch to take effect (a `null` entry hides the level, and pi clamps `low`/`medium` selections **up** to `high`). Note `"off"` is not an accepted `reasoning_effort` literal on neuralwatt.

---

## Usage

```
/model dyna/auto          # select the virtual model
/dyna plan                # force the planning phase (holds until the next signal)
/dyna implement           # force the implementation phase (holds until the next signal)
/model neural-watt/glm-5.3  # bypass the router entirely, any time
```

### A typical session

1. `/model dyna/auto` → session starts on the **planning** model (`plan`).
2. You discuss the issue; the agent writes a plan doc (`.scratch/…`) and test files — still **planning**.
3. The agent makes its first real source edit, or runs the test suite → switches to the **implementation** model (`implement`). One cache miss.
4. Fix/test/edit cycles continue on the cheap model, self-checking at `implementThinking: "high"`.
5. Work is merged; the agent runs `git checkout main` → resets to **planning**. The next issue in the same session plans on the strong model again.

---

## Development

```bash
npm install --legacy-peer-deps
npm test        # vitest — unit tests for foldPhase and readConfig
```

The test suite in `tests/trigger.test.ts` covers the fold semantics (successful/failed edits, test-command anchoring, git resets, latest-signal-wins) and config parsing (defaults, project overrides, invalid values).

## License

MIT
