# Polished Foreground TTY Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve interactive foreground server stdout logs with a compact, colored, one-line TTY format that keeps date-bearing timestamps.

**Architecture:** Keep the existing logging sink selection and file logging behavior unchanged. Add an internal TTY-only tracing formatter in `fabro-cli` and select it only for stdout server logs when stdout is an interactive terminal.

**Tech Stack:** Rust, `tracing`, `tracing-subscriber`, `console`, Fabro CLI/server logging.

---

## Summary

Add a custom one-line TTY formatter for `fabro server start --foreground` when logs go to stdout and stdout is a terminal. File logs, piped stdout, CI captures, and per-run worker log files keep the current plain tracing format. The TTY timestamp must keep the calendar date.

## Key Changes

- Add an internal `TtyLogFormat` in `lib/crates/fabro-cli/src/logging.rs` for stdout logging only.
- Use `std::io::stdout().is_terminal()` to choose TTY formatting; use `console::colors_enabled()` only to decide whether ANSI color is emitted.
- Format TTY logs as:

  ```text
  2026-05-06 14:12:04.184  INFO   API server started                     bind=/tmp/fabro.sock
  2026-05-06 14:12:13.044  WARN   LLM request failed, retrying           provider=openai attempt=2 error="rate limited"
  2026-05-06 14:12:21.337  ERROR  Worker process exited unexpectedly     run=run_abc123 pid=41822
  2026-05-06 14:12:22.008  DEBUG  fabro_server::server  Spawning worker  run=run_abc123 mode=start
  ```

- Use local wall-clock timestamps formatted as `YYYY-MM-DD HH:MM:SS.mmm`.
- Color TTY output as: timestamp dim, `INFO` green, `WARN` yellow, `ERROR` bold red, `DEBUG` cyan/dim, `TRACE` dim, debug target dim, fields dim.
- Extract tracing `message` as the main message, render all other event fields as `key=value`, and preserve fields rather than hiding diagnostics.
- Hide the target for `INFO`, `WARN`, and `ERROR`; show a dim target for `DEBUG` and `TRACE`.
- Keep file logs on the existing `fmt::layer().with_target(true).with_ansi(false)` behavior.
- Use the TTY formatter for worker stdout only when worker logs are routed to inherited stdout; keep worker per-run `runtime/server.log` plain.

## Interfaces

- Public CLI/API/config: no changes.
- Existing `[server.logging].destination` and `FABRO_LOG_DESTINATION` precedence remains unchanged.
- Observable stdout format changes only for interactive foreground server stdout.
- Update `docs/internal/logging-strategy.md` to state that foreground TTY stdout uses compact colored formatting with date-bearing timestamps, while file and piped logs remain plain.

## Implementation Checklist

- [x] Add a small field visitor in `logging.rs` that captures the `message` field separately and stores all other fields in stable insertion order.
- [x] Add `TtyLogFormat` implementing `tracing_subscriber::fmt::FormatEvent` for the compact one-line format.
- [x] Factor logging initialization so server stdout can choose between the new TTY formatter and the existing plain formatter without changing file sinks.
- [x] Apply the same stdout-vs-file split to worker logging: TTY formatter for server stdout layer only, plain formatter for per-run file layer.
- [x] Keep all file appenders using `BufferedFileAppender` and ANSI disabled.
- [x] Update the logging strategy doc with the new foreground TTY behavior.

## Test Plan

- Add unit tests in `logging.rs` for `TtyLogFormat`:
  - timestamp includes a `YYYY-MM-DD` date.
  - `INFO` hides target, includes message, and includes fields.
  - `DEBUG` includes target.
  - color-enabled output contains ANSI sequences.
  - color-disabled output contains no ANSI sequences.
- Add or adjust integration coverage in `server_start.rs`:
  - Existing piped `foreground_start_writes_tracing_to_stdout_by_default` remains plain and keeps passing.
  - Existing file-destination test proves `<storage>/logs/server.log` stays uncolored and truncation behavior is unchanged.
- Run:
  - `cargo nextest run -p fabro-cli foreground_start_writes_tracing_to_stdout_by_default`
  - `cargo nextest run -p fabro-cli foreground_start_with_file_destination_writes_tracing_to_storage_server_log`
  - `cargo nextest run -p fabro-cli logging`
  - `cargo +nightly-2026-04-14 fmt --check --all`

## Assumptions

- TTY formatting is a presentation-only improvement, not a new configuration surface.
- Piped stdout remains stable to avoid breaking scripts and existing tests.
- One-line logs are preferred over multiline pretty output because server logs can interleave parent and worker events.
