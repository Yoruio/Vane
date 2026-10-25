# Automated test plan

There are currently no tests: no test runner, no test dependencies, no test
files. Every defect in this repository so far has been found by running the
product and reading a database afterwards.

This plan is therefore not a coverage target. It is a list of **failures that
actually happened**, turned into checks that would have caught them, ordered by
how expensive each failure was to find by hand.

## What makes this app hard to test

Three properties shape everything below.

**The model is non-deterministic, even at `temperature: 0`.** Measured: the same
prompt took 96.2s and then 13.4s; five identical picker prompts returned five
different answers. Upstream treats multi-slot non-determinism as inherent, not a
bug. **No test may assert exact model output.** Assertions must be about
structure, invariants and relationships — "every sentence carries a citation",
"brief is shorter than deep", "the version number is unchanged" — never "the
answer equals X".

**The expensive failures are silent.** A crashed extraction looked identical to a
thin page. A page nobody could read became a cited source. An answer that never
streamed looked like a slow model. Tests must assert on *recorded evidence*
(`llm_calls`, `messages`, the research block), not on the absence of an
exception.

**Timing is not measurable in one sample.** Any performance assertion needs
repeats and a wide band, or it will flake. Prefer asserting *counts* (calls,
crashes, growth steps) over durations.

---

## Layer 1 — Unit tests (fast, no network, no model)

Run on every commit. Target: under 10 seconds.

| Case | Bug it would have caught |
|---|---|
| `consumeNdjson` returns the trailing fragment and dispatches only complete lines; a chunk split mid-line does not re-dispatch earlier events | The answer never streamed: the buffer cleared only if nothing threw, so ~155,000 duplicate dispatches |
| `consumeNdjson` skips one unparseable line and keeps going | One bad line aborted the rest of the batch |
| `consumeNdjson` plus an explicit flush emits a final line with no trailing newline | A last event could be dropped |
| `splitScrapedContent` respects `maxChunksPerPage` and the auto ceiling | Chunk ceiling changes silently altering behaviour |
| `trailingRun` detects a long single-character run across chunk boundaries | 26,407 `?` characters streamed over 54 minutes |
| `defaultAnswerStyle` maps speed/balanced/quality to brief/standard/deep | — |
| `WRITER_MAX_TOKENS` has an entry for every `AnswerStyle` | A flat cap truncating quality answers whose prompt demands 2,000 words |
| `slotWarning` fires only when an explicit chunk size does not fit | — |
| Scraper's `ok` is false below `MIN_USEFUL_CONTENT` | researchgate 221, rocketreach 186, wiza 179 characters cited as sources |
| `hasArgs` matches by containment, not equality | Every search unloading and reloading the model, 26s each |
| `parseAndValidate` round-trips every provider config field | `llamacppArgs` silently dropped, so preload answered in 8ms |

**Tooling:** Vitest. Pure functions, no DOM, no server.

---

## Layer 2 — Database and migration tests

Run on every commit. These are cheap and the failure mode is catastrophic.

| Case | Why |
|---|---|
| Fresh database: run all migrations, assert the exact column set of `messages` and `llm_calls` | The combined `0003` baseline must equal the six files it replaced |
| Upgraded database: seed `ran_migrations` with `0000`–`0008`, run migrations, assert `0003` is **skipped** and `0009` **applied** | The runner keys on the numeric *prefix*; a new column in the baseline alone would never reach an existing install |
| Every `.sql` file has a unique numeric prefix | Two files sharing a prefix means one is silently skipped forever |
| Fresh and upgraded databases end with identical column *sets* | Column order may differ; the set may not |
| `beginCall` inserts with `durationMs` null, `completeCall` fills it | In-flight rows are how a running call is drawn |
| A failed run persists `status: 'error'` | A dead run looked identical to a finished one |
| The message row records `provider`, `model`, `mode`, `answerStyle` on both insert and re-run | A re-run may use different settings than the first attempt |
| `writerContext` is non-empty after a search | Without it, rewrite silently has nothing to work from |

**Tooling:** Vitest plus `better-sqlite3` against a temp file. No container needed.

---

## Layer 3 — Provider contract tests (fake model server)

A small HTTP server that speaks the OpenAI-compatible shape and can be scripted
to misbehave. This is where the costly bugs lived and where a real model cannot
be used, because the failures must be *deliberately* produced.

| Scripted response | Assertion |
|---|---|
| `delta.reasoning_content` only, then `delta.content` | Thinking is captured, the answer is not empty, `<think>` is closed |
| Reasoning that never yields content | The call ends with an error, not a silent empty answer |
| 10,000 repetitions of `?` | The repetition guard stops it; the run does not store 26,407 characters |
| HTTP 500 `Unexpected empty grammar stack after accepting piece: ? (30)` | `llm_calls.error` holds it, `scrape.chunksFailed` increments, a page whose every chunk failed is **not** cited |
| 200 with an empty body | Counted as a failure, not as a successful empty extraction |
| Stream that stalls mid-answer | The idle timeout fires and the run is marked failed |
| Tool-call arguments arriving as `""` then JSON | No crash in the tool-call accumulator |
| `/api/v1/health` reporting `--parallel 4` | `isModelLoaded` reports not-ready so the model is reloaded with the pinned value |

**Tooling:** Vitest plus a `node:http` server per test. Deterministic, fast,
no GPU.

---

## Layer 4 — End-to-end (Playwright, deployed build, no live model)

Playwright is already installed in the container. Point the app at the fake
provider from Layer 3 so these are deterministic.

| Case | Bug it would have caught |
|---|---|
| Answer text grows in **≥8 distinct steps** during a run | The answer arriving in one lump when the writer finished |
| Answer-length slider: thumb box equals the active button's box, **and no two labels overlap** | Thumb drift under Brief/Standard, then "Standard" overlapping "Deep" |
| Slider appears in both the collapsed and expanded follow-up input | The style could only be chosen on the first prompt |
| Selecting a style sends `answerStyle` in `POST /api/chat`; `auto` omits the field | A control that paints correctly but changes nothing |
| Submitting while a run is in flight shows the busy toast and keeps the typed text | Submissions silently discarded |
| A finished run's last timeline bar stops growing without a refresh | Polling stopped before the row closed |
| Embeddings collapse to one row that expands | — |
| Reloading mid-run keeps the progress strip | Reconnect dropping state |

**Geometry assertions must compare elements to each other, not only to one
reference.** The thumb-versus-button check passed while the labels overlapped.

---

## Layer 5 — Content integrity (fake provider, scripted corpus)

The failures that no mechanical check caught.

| Case | Bug it would have caught |
|---|---|
| Rewrite preserves version numbers, dates, identifiers and citation markers from the previous answer | v2.11.6 becoming v2.11.4 with different dates and CVEs |
| Rewrite introduces no citation index absent from the original | Fabricated sources |
| `brief` output contains no `##` heading and no bullet list | A style that shortens but keeps the blog scaffolding |
| `deep` is materially longer than `brief` from identical context | The two dials not actually being independent |
| Every sentence in an answer carries a citation marker | Citation discipline silently lost when the prompt changed |
| A page rejected as unreadable never appears as a source | Bot interstitials cited |

**For anything that regenerates content, diff the before and after.** Latency,
streaming and persistence all passed green while the rewrite changed the facts.

---

## Layer 6 — Live-model canary (nightly, non-blocking)

Real GigaBrain, real searches. **Never gates a merge** — it is too slow and too
noisy. It exists to catch environment drift.

- One search per mode with unique message ids; assert **zero** `llm_calls.error`
  rows and a non-empty answer.
- Assert `--parallel 1` in the launch command reported by `/api/v1/health`.
- Record wall clock and per-role totals to a file; alert on a large regression
  against the trailing median, not against a fixed threshold.
- Assert no `empty grammar stack` in the server log for the window.

Unique message ids are not optional: reusing one caused two runs to be summed
and a wrong conclusion reported.

---

## Bootstrapping

```
yarn add -D vitest @vitest/coverage-v8 better-sqlite3 @playwright/test
```

`package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:e2e": "playwright test",
"test:canary": "node scripts/canary.mjs"
```

Layout:

```
src/**/*.test.ts        unit, beside the code
tests/db/               migration and telemetry
tests/provider/         fake model server + contract tests
tests/e2e/              Playwright
tests/fixtures/         recorded NDJSON, stored prompts, scraped pages
scripts/canary.mjs      nightly live run
```

**Fixtures to capture now, while the evidence exists:** a real NDJSON stream
from a search (558 events), the stored extractor prompt that triggered the
grammar crash, the three scraped pages that fell under 400 characters, and a
`writerContext` with its answer for rewrite tests.

## CI

GitHub Actions on push and pull request:

1. `lint` → `test` (layers 1–3) → `build`. Fast, blocking.
2. Layers 4–5 against the built image with the fake provider. Blocking.
3. Layer 6 nightly on a self-hosted runner with GPU access. Reports, never
   blocks.

## What stays manual

- Whether an answer is *good*. Tests can check citations, length and fact
  preservation; they cannot judge usefulness.
- Visual design beyond geometry.
- Anything requiring the real model's judgement, such as whether the picker
  chose sensible sources.

## Honest limitations

- A fake provider tests our handling of model behaviour, not the model. The
  grammar crash reproduces only against real llama.cpp with `--parallel > 1`.
- Layer 6 will flake. Treat a single failure as a prompt to look, not as a
  regression.
- None of this prevents a test that measures the wrong invariant. Three
  separate times this session a green check accompanied a broken feature:
  the thumb aligned while labels overlapped; the rewrite was fast, streamed
  and persisted while changing the facts; a run was declared clean while its
  rows came from two different days. **When a test passes on a feature you have
  not looked at, you have tested the test.**
