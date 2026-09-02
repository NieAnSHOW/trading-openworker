# Repository Guidelines

## Project Overview

OpenWorker is an open-source, provider-agnostic **AI coworker desktop app**: a Python agent runtime (`coworker` package) behind a Tauri v2 GUI, plus a headless server, TUI, Slack/Telegram connectors, MCP support, automations, and agent teams. Governance is the architecture, not a plugin: **hard floors** (human-only operations), an **earned-autonomy ladder** (approval-gated by default, LLM reviewer in auto-approve mode), and a durable **audit trail**. Never weaken these floors in any change; the agent cannot grant itself permissions and no prompt may talk it past a gate.

## Architecture & Data Flow

Surfaces never drive the agent loop — they consume `Event`s and answer injected approver callbacks.

1. **Entry** — TUI: `coworker/cli.py` → `CoworkerApp` (`coworker/tui/app.py`). Server: `coworker/server/run.py` → `SessionManager` (`coworker/server/manager.py`, ~1150-method facade) wrapped by `create_app` (`coworker/server/app.py`; all FastAPI routes live *inside* `create_app`, no routers). GUI talks REST `/v1/*` + WS `/ws/session/{id}` and `/ws/events`.
2. **Engine assembly** — `SessionManager.get_engine` caches engines per session or calls `build_engine` (`coworker/agent.py`): Agent (persona-driven) → `ToolRegistry` + catalog-expanded tools (`coworker/catalog.py`) + MCP/connector tools → `PermissionEngine` (`coworker/permissions.py`) → `ProviderRouter`.
3. **Turn** — `TurnEngine.run` (`coworker/engine.py`) is an async generator of `Event` (`coworker/events.py`); `_loop` iterates model↔tool until done/interrupt/approval pause.
4. **Model call** — providers are deliberately **blocking**, bridged via `asyncio.to_thread`/thread+queue. `ProviderRouter` (`coworker/providers/router.py`) dispatches on a `provider:model` prefix (`anthropic:claude-opus-5`, bare = default OpenAI), building clients from `SecretStore` profiles. All providers implement `ProviderClient` (`coworker/providers/base.py`); history is canonical OpenAI shape, converted per provider.
5. **Tool execution** — engine authorizes **all** calls first via `_authorize` → `PermissionEngine.evaluate` (+ `risk.py classify`, + LLM `reviewer.py` in auto-approve mode), then executes: low-risk concurrently, writes/shell strictly ordered. `needs_user` decisions emit `PERMISSION_REQUIRED` and await the injected approver (GUI card, Inbox item, or messaging button).
6. **Persistence** — `ConversationStore` (`coworker/conversations.py`): SQLite index + append-only `conversations/<id>.jsonl`. Prompt-suspended turns persist (Inbox, `unattended.py`) and must be reconstructible after restart (`engine.resume()` / durable-resume path).

**Governance stack** (README "Governed by design"): `permissions.py` (modes, allow/deny/ask, protected paths incl. its own db/config/secrets — blocked *in any mode*), `risk.py` (RiskClass taxonomy drives gating), `reviewer.py` (fail-closed, never sees file contents, never overrides `human_only`), `audit.py` (sqlite audit log, secret redaction), `provenance.py` (flags commands running agent-written files), `overrides.py` + `workspace_trust.py` (user-owned, never persona-writable), `readonly.py`. `_GLOBAL_ONLY_FIELDS` in `config.py` forbids workspace configs from widening command allowlists.

## Key Directories

| Path | Purpose |
|---|---|
| `coworker/` | Python runtime: engine, server, tools, providers, personas, skills, memory, connectors, mcp, automation, teams, web search |
| `coworker/server/` | FastAPI app + `SessionManager` facade (the always-on surface the GUI drives) |
| `coworker/providers/` | `ProviderClient` ABC, native providers, registry, `ProviderRouter` |
| `coworker/tools/` | `ToolRegistry` + tool factories (files, git, shell, search, subagent, ask, plan) |
| `coworker/personas/` | YAML-frontmatter persona manifests; `builtin/` ships as package data |
| `coworker/connectors/` | Slack/Telegram adapters, gateway, `send_message` tool defs |
| `coworker/skills/builtin/` | 86 shipped trading/quant skills (package data) — every agent's baseline menu; user/project copies of the same name shadow them |
| `surfaces/gui/` | React 18 + TS + Vite frontend; `src-tauri/` is the Tauri v2 Rust shell |
| `coworker/tools/trading/` | Vendored Vibe-Trading market-data tools — read-only, `classify()` = `READ` (no approval card); `trading` extra supplies pandas for `a_stock_data` |
| `coworker/factors/` | Vendored Vibe-Trading factor engine: frozen Registry (460 alphas: qlib158/gtja191/alpha101/academic) + IC bench/compare runners; `trading` extra (pandas/numpy) required |
| `tests/` | Flat pytest suite (~139 files) + `tests/corpora/` security-eval datasets |
| `scripts/` | Reviewer-eval ship-gate harness + corpus generator/validator (repo-root namespace package imported by tests) |
| `packaging/` | PyInstaller sidecar spec + macOS/Windows build scripts |
| `stt/` | Standalone Rust library (cpal + whisper-rs) for offline dictation, consumed by the GUI shell |
| `ui-mocks/` | Standalone Tailwind HTML design mocks, mirrored by `surfaces/gui` styling |
| `reports/` | Committed dated reviewer-eval ship-gate evidence |
| `coworker/alphazoo.py` | Alpha Zoo service: in-memory bench/compare job store (uuid, 1h TTL, semaphores) behind `/v1/alphazoo/*` routes in `server/app.py`; poll-based, no SSE |
| `docs/` | `config.example.toml` + architecture diagram |

## Development Commands

```bash
# One-time dev env (creates .venv, editable install)
packaging/setup_dev_env.sh          # = python3 -m venv .venv + pip install -e '.[messaging,dev]'

# Run the server (port 8765; per-launch token at <state-dir>/sidecar-8765.token)
.venv/bin/openworker-server --cwd <project> --port 8765

# Run the GUI (vite dev on 1420, strictPort; reads the token from the state dir)
cd surfaces/gui && npm install && npm run dev
npm run tauri dev                   # full desktop shell (spawns the server itself)

# TUI / teams CLI
.venv/bin/openworker                # TUI
.venv/bin/ocw board                 # agent-teams board CLI
```

GUI↔Python contract: `src-tauri/lib.rs` picks a free port, spawns the server sidecar with `COWORKER_API_TOKEN`, and injects `window.__COWORKER_HTTP__/__COWORKER_WS__/__COWORKER_API_TOKEN__` before SPA load (`src/api.ts` falls back to `127.0.0.1:8765` in plain-browser dev).

## Code Conventions & Common Patterns

- **Every module**: `from __future__ import annotations`; dataclasses for value types; `class X(str, Enum)` with lowercase values.
- **Docstrings cite specs** — `OPE-n`, `§n`, dated owner rulings. New governed code carries the same rationale; read the cited section before touching gated behavior.
- **Fail closed**: malformed reviewer output → `unsure` → human; unknown command → approval; unparseable manifest → raise. Best-effort side-effects may swallow exceptions deliberately — don't "fix" those.
- **Async**: engine loop is asyncio; blocking provider/tool calls go through `asyncio.to_thread` or thread+queue. Sync stores guard with `threading.RLock` and sqlite `check_same_thread=False` — never assume single-threaded access.
- **Tools** are plain functions wrapped with aisuite: `ai.tool(func, metadata=ai.ToolMetadata(category=…, risk_level=…))`; `ToolRegistry.register` generates the JSON schema (override via `__coworker_schema__`). Permission checks live in the **engine**, never in the registry.
- **Manager/server mutations return plain dicts** `{ok: …, error: …}`; FastAPI routes are thin wrappers.
- **Config**: layered TOML (built-in < `<state-dir>/config.toml` < `<workspace>/.coworker/config.toml`), `dataclass Config` + `tomllib`; every knob has a code default.
- **Message sidecar contract**: persisted messages carry display-only sidecars (`source`, `_display`, provider `_underscore` extras); `_outbound_messages` (`engine.py`) strips them before wire calls — new sidecars must stay display-only or be stripped.

**Editing hazards**

- `server/manager.py` (~275KB) and `app.py` (~126KB) are mega-files; routes are defined inside `create_app` — read surrounding sections, there are no route tables to grep.
- `TurnEngine` is assembled in **two phases**: reviewer, compaction, attended-flag etc. are set post-construction by the surface; `None` = feature off.
- **Lazy imports are load-bearing** (boto3, `AnthropicBedrock`, connector SDKs imported at call time for optional extras). Do not hoist them to module level.
- `personas/builtin/**` and `coworker/skills/builtin/**` are coupled to `[tool.setuptools.package-data]` and PyInstaller `collect_data_files` — moving layout breaks wheels/DMG.
- `state_dir()` (`$COWORKER_STATE_DIR` ‖ `~/.config/coworker`) is the one shared state location for TUI, server, and GUI.
- SQLite schemas migrate via idempotent `ALTER … except OperationalError` in code — follow that pattern; no migration framework.
- Client-supplied ids (session ids, persona slugs, media names) are validated before becoming filenames — keep that discipline.

## Important Files

- `pyproject.toml` — single source of truth: deps, extras, console scripts, pytest config
- `coworker/engine.py` — `TurnEngine`, the owned agent loop (~2100 lines)
- `coworker/agent.py` — `build_engine()`, the wiring point for everything a turn can do
- `coworker/permissions.py` / `risk.py` / `reviewer.py` / `audit.py` — governance core
- `coworker/server/manager.py`, `coworker/server/app.py` — surface facade + REST/WS
- `coworker/providers/base.py`, `coworker/providers/router.py` — provider abstraction
- `coworker/catalog.py` — vetted capability catalog (persona `tools:` ids → callables)
- `coworker/config.py`, `coworker/secrets.py` — layered config, state dir, API keys
- `surfaces/gui/src-tauri/lib.rs` — sidecar spawn + window-globals injection
- `surfaces/gui/src/api.ts` — frontend endpoint resolution
- `packaging/openworker-server.spec` — PyInstaller freeze of the server
- `tests/conftest.py`, `tests/corpora/LAYERED_CORPORA.md`, `docs/config.example.toml`

## Runtime/Tooling Preferences

- **Python ≥3.10** (local `.venv` is 3.11; CI runs 3.12). Build via setuptools from `pyproject.toml` only — no setup.py.
- **GUI package manager is npm** (Node 20; `package-lock.json` is tracked for CI). `surfaces/gui/pnpm-lock.yaml` is stale and unreferenced — ignore it. Typecheck with `npx tsc --noEmit`.
- **Rust**: Tauri shell + `stt/` (edition 2021, rust-version 1.77).
- Optional extras: `dev`, `messaging` (Slack/Telegram tests need it), `browser` (playwright), `bedrock` (lazy-imported boto3). CI installs `-e '.[messaging,dev,bedrock]'`.
- Model ids are provider-prefixed strings (`anthropic:claude-opus-5`, `openai:gpt-5.6-sol`).
- Experimental connector code is stripped from builds unless `COWORKER_EXPERIMENTAL=1`.

## Testing & QA

- **pytest 8 + pytest-asyncio** (`asyncio_mode = auto`, `pythonpath = ["."]`, `testpaths = ["tests"]` — config in `pyproject.toml`). Run from repo root:
  ```bash
  .venv/bin/pytest tests -q                    # full suite (what CI runs)
  .venv/bin/pytest tests/test_engine.py -q     # single file; name mirrors coworker module
  ```
- **Everything is hermetic**: provider tests use module-local `_FakeClient` SDK fakes; engine/server tests use scripted in-memory `ProviderClient` subclasses; Slack tests drive the real adapter against `FakeSlack` (`coworker/testing/fake_slack/server.py`, via the `fake_slack` fixture); TUI tests use textual's headless `run_test()`. No display, no network. Only live test is opt-in via `COWORKER_LIVE_VISION=1`.
- **conftest** (`tests/conftest.py`, the only one): autouse `_isolated_state_dir` redirects `COWORKER_STATE_DIR` to `tmp_path` — tests never touch real user state.
- **Security corpora** (`tests/corpora/`): legacy `benign/dangerous/injection.jsonl` feed the ship-gate harness (not pytest); 3 layered corpora are **generated** — edit templates in `scripts/build_layered_corpora.py`, never raw JSONL, then regenerate; `decision_matrix.csv` is the golden `PermissionEngine` table (add a row + expected verdict in `test_decision_matrix_golden.py`). Schema/size floors enforced by `tests/test_layered_corpora.py`.
- **Reviewer ship gate** (manual, costs live-model money): `python -m scripts.eval_reviewer --model <provider:model>` (`--stub` for plumbing; zero false-allows required on dangerous/injection corpora). Results land in `reports/`.
- **GUI tests** (separate npm world): `npm test` (vitest, jsdom), `npm run e2e` (Playwright, hermetic with mocked `/v1` + WS), `npm run e2e:live` against a real server.
- No coverage config or pytest markers — a plain `pytest tests -q` must stay green; cross-cutting acceptance lives in `tests/test_ui_refresh_e2e.py` (de-facto merge gate).
