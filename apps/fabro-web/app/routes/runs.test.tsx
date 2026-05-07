import { describe, expect, test } from "bun:test";
import type { BoardColumn, RunListItem } from "@qltysh/fabro-api-client";

import {
  buildBoardColumns,
  runsQuickStartCommands,
  shouldRefreshBoardForEvent,
} from "./runs";

function boardRun(id: string, column: BoardColumn, questionText?: string): RunListItem {
  return {
    run_id: id,
    goal: `Run ${id}`,
    title: `Run ${id}`,
    created_at: "2026-04-19T12:00:00Z",
    status: column,
    labels: {},
    repository: { name: "repo" },
    column,
    ...(questionText ? { question: { text: questionText } } : {}),
  };
}

describe("runs route board mapping", () => {
  test("keeps blocked runs in the blocked lane and preserves question text", () => {
    const columns = buildBoardColumns({
      columns: [
        { id: "queued", name: "Queued" },
        { id: "initializing", name: "Initializing" },
        { id: "running", name: "Running" },
        { id: "blocked", name: "Blocked" },
        { id: "succeeded", name: "Succeeded" },
        { id: "failed", name: "Failed" },
      ],
      data: [
        boardRun("paused-run", "running"),
        boardRun("blocked-run", "blocked", "Older unresolved question?"),
      ],
      meta: { has_more: false },
    });

    expect(columns.find((column) => column.id === "running")?.items.map((item) => item.id)).toContain("paused-run");
    expect(columns.find((column) => column.id === "blocked")?.items.map((item) => item.id)).toContain("blocked-run");
    expect(columns.find((column) => column.id === "blocked")?.items[0]?.question).toBe("Older unresolved question?");
  });

  test("renders an archived column when the response includes one", () => {
    const columns = buildBoardColumns({
      columns: [
        { id: "queued", name: "Queued" },
        { id: "initializing", name: "Initializing" },
        { id: "running", name: "Running" },
        { id: "blocked", name: "Blocked" },
        { id: "succeeded", name: "Succeeded" },
        { id: "failed", name: "Failed" },
        { id: "archived", name: "Archived" },
      ],
      data: [
        boardRun("succeeded-run", "succeeded"),
        boardRun("archived-run", "archived"),
      ],
      meta: { has_more: false },
    });

    expect(columns.map((column) => column.id)).toEqual([
      "queued",
      "initializing",
      "running",
      "blocked",
      "succeeded",
      "failed",
      "archived",
    ]);
    expect(
      columns.find((column) => column.id === "archived")?.items.map((item) => item.id),
    ).toEqual(["archived-run"]);
    expect(
      columns.find((column) => column.id === "succeeded")?.items.map((item) => item.id),
    ).toEqual(["succeeded-run"]);
  });

  test("omits the archived column when the response does not include it", () => {
    const columns = buildBoardColumns({
      columns: [
        { id: "queued", name: "Queued" },
        { id: "initializing", name: "Initializing" },
        { id: "running", name: "Running" },
        { id: "blocked", name: "Blocked" },
        { id: "succeeded", name: "Succeeded" },
        { id: "failed", name: "Failed" },
      ],
      data: [boardRun("succeeded-run", "succeeded")],
      meta: { has_more: false },
    });

    expect(columns.some((column) => column.id === "archived")).toBe(false);
  });

  test("refreshes for blocked status and interview events", () => {
    expect(shouldRefreshBoardForEvent("run.queued")).toBe(true);
    expect(shouldRefreshBoardForEvent("run.blocked")).toBe(true);
    expect(shouldRefreshBoardForEvent("run.unblocked")).toBe(true);
    expect(shouldRefreshBoardForEvent("run.archived")).toBe(true);
    expect(shouldRefreshBoardForEvent("run.unarchived")).toBe(true);
    expect(shouldRefreshBoardForEvent("interview.started")).toBe(true);
    expect(shouldRefreshBoardForEvent("interview.completed")).toBe(true);
    expect(shouldRefreshBoardForEvent("run.created")).toBe(false);
  });

  test("includes the configured server argument for GitHub-auth quick starts", () => {
    expect(runsQuickStartCommands(true, "http://127.0.0.1:32276")).toEqual([
      "fabro auth login --server http://127.0.0.1:32276",
      "fabro repo init",
      "fabro run hello",
    ]);
  });

  test("does not show a placeholder server when system info is unavailable", () => {
    expect(runsQuickStartCommands(true)).toEqual([
      "fabro repo init",
      "fabro run hello",
    ]);
  });
});
