# Behavioral parity ledger

Current cross-module status: [P0–P13 roadmap](roadmap.md), audited 2026-10-01. The P0 observations below are historical evidence, not a new original-product run.

## Reference

- Product: OpenClaw
- Version: `2026.9.6`
- Version source: <https://github.com/openclaw/openclaw/releases/tag/v2026.9.6>
- Local observation: official `openclaw@2026.9.6` ran in an isolated state directory with Node 24.16.0. CLI reported `OpenClaw 2026.9.6 (eb377ac)`.

Both products were compared with the same local Chat Completions fixture (`scripts/p0-model-fixture.mjs`) to control model output. Mirror was also checked with the configured real provider. Fixture observations establish application behavior for specified responses, not real-model quality or provider compatibility.

The linked official documentation is live and may change independently of the pinned release. Its statements are design references, not proof of exact behavior in 2026.9.6.

## Our implementation — current checkpoint

| Capability | Implementation status | Evidence |
|---|---|---|
| Local Gateway with browser and CLI clients | Implemented with our protocol subset | WebSocket integration, browser walkthrough, CLI cross-client regression |
| Persisted sessions and runs | SQLite, per-turn rows, retained partial output | Database reopen and actual SIGKILL/restart test |
| Per-session queue and fresh context | Context is built at dequeue time | Controlled two-turn regression |
| Cancellation, timeout, idempotency | Implemented | Coordinator regressions |
| Reconnect and session display isolation | Snapshot recovery, run versions, generation filtering | Browser switch/stop/reload plus state regressions |
| Compatible model provider | Standard multi-round tool loop implemented; ordinary chat is locally configured as `plain` (one tool round), while `/research2` and `/team` force standard mode | Mock protocol regressions and live browser tool runs |
| OpenClaw protocol and UI parity | Not established | P0 original UI comparison found concrete differences |
| Tools | Bounded workspace read/list/write, public HTTPS fetch and opt-in approved JavaScript execution (disabled by default; not an OS/network sandbox); not original parity | Earlier read/search live checks; new file/code direct smoke and build, public fetch not yet live verified |
| Tool approvals | Requested/approved/rejected states and browser controls implemented | Unit, recovery and live-browser checks |
| Session memory | Source-linked extractive snapshots and model-derived summaries with fallback; not original parity | Controlled end-to-end regression and one live provider recall check |
| Skills, cross-session Memory | Research Skills implemented; cross-session Memory remains open | HotpotQA Skill checks and memory evaluation |

These checks validate our behavior, not equality with OpenClaw. An earlier provider returned an empty HTTP 200 body for standard `tool` result messages; our `plain` compatibility mode succeeded once by labeling the tool result as data in a user message. This is a provider-specific workaround, not an OpenClaw parity claim.

## Phase 0 scenarios

The two status columns answer different questions. “Mirror” is our own implementation and local evidence; “OpenClaw” is the pinned original. The fixture does not prove identical model behavior. A unit test alone does not complete an entire browser scenario.

| ID | Scenario | Mirror status and evidence | OpenClaw 2026.9.6 |
|---|---|---|---|
| P0-1 | Start Gateway and connect Control UI | Gateway/UI connection, reconnection, SQLite snapshot recovery observed | Gateway/UI connection and restart observed; protocol not compared byte-for-byte |
| P0-2 | Two-turn conversation with a random marker | Fixture and real provider returned the prior marker in turn two | Fixture returned the prior marker in turn two |
| P0-3 | `/new` then query the marker from the prior session | Parent retained, `parentId` child created, child has no old marker | Parent remains visible; `/new` creates a child; child has no old marker |
| P0-4 | `/reset` in the current session | Generation increments, title retained, old history hidden, no old marker | Title retained, old conversation cleared, reset notice shown, no old marker |
| P0-5 | Read `agent_demo.txt` and answer its code | One `read_file`, recorded result, final `Cedar-731`; real provider also completed once | One `read`, file content `Cedar-731`, final `Cedar-731` |
| P0-6 | Stop a slow stream, restart Gateway | Browser stop/reload and one combined stop/SIGKILL/restart Gateway test retained partial output | Browser stop, restart and reconnect retained partial output; status presentation differs |
| P0-7 | A1 and A2 in one session, B1 in another | Gateway test shows A2 after A1, B1 finishes while A1 runs; active A2 is persisted on the same Run and is idempotent. Fixture UI check: `P0-A1` → `P0-A2` finishes as one Run with output `A2 完成` | UI shows A2 after A1, B1 finishes while A1 runs; active send button says “引导当前运行” |

These are passing observations only for the exact points above. P0 is not complete overall: Gateway protocol, tool events, and some status presentation still differ. OpenClaw injects into an active runtime; Chat Completions cannot accept an in-flight prompt, so Mirror aborts the active model request and restarts the same persisted Run with the original input plus all accepted guidance.

## Browser and CLI on one Gateway

The pinned OpenClaw package describes Web UI and CLI as Gateway clients. Mirror now has a local CLI over its existing WebSocket RPCs. A controlled regression created a session through the CLI, sent a message, read the same persisted Run and events, then created a child session and reset it. Another regression showed that a non-interactive CLI leaves `read_file` requested until an explicit deny; the tool did not execute. This verifies Mirror's two-client routing only. The CLI does not implement OpenClaw's v4 handshake, authentication, session-key grammar or full RPC schema, so an original OpenClaw client cannot yet be pointed at Mirror.

## Deferred: direct active-run injection

The current `chat.steer` behavior is a Chat Completions adapter: it persists the guidance, stops the current request, and starts the same Run again. It does **not** inject a message into the existing model request. Direct injection requires a bidirectional Agent runtime or a provider control channel that supports steering an active generation. This item is intentionally left for the user to implement later; do not count it as completed parity work.

## Sources and known expectations

- The pinned original UI shows `/new` creating a child session while leaving the parent visible; `/reset` resets in place; `/stop` aborts a run. The live command docs may change: <https://docs.openclaw.ai/tools/slash-commands>
- Agent runs are serialized per session: <https://docs.openclaw.ai/agent-loop>
- The Gateway is the control plane for clients, sessions, chat, and events: <https://docs.openclaw.ai/gateway/protocol>

## Evidence record

For every scenario, capture: OpenClaw version, surface, exact input, observed UI/session state, relevant event or log, and status (`observed`, `not observed`, or `unavailable`). No business dataset is needed; session isolation can use a random marker generated for the run. The fixture is deterministic and contains no secret. The latest audit reran `pnpm verify`: 106/106 controlled engineering checks passed, including Gateway, approvals, memory, research recovery, rate limits, safety controls, CLI and Multi-Agent. The current report is `.data/verification/latest.json`; it records execution times, source hash and case results. This rerun did not call a real model or repeat the original-product comparison. The safety controls are Mirror behavior, not verified OpenClaw parity.
