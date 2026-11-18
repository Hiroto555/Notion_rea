import { expect, it, vi } from "vitest";
import { finishWorkspaceQuit, workspaceQuitCloseFailure } from "../src/main/workspace-quit";

it("keeps the workspace open when a prepared restart cannot be committed", () => {
  const preventQuit = vi.fn(), reopenWindow = vi.fn(), closeStore = vi.fn();
  expect(finishWorkspaceQuit({commitRestart: () => "blocked", preventQuit, reopenWindow, closeStore})).toBe("held");
  expect(preventQuit).toHaveBeenCalledOnce();
  expect(reopenWindow).toHaveBeenCalledOnce();
  expect(closeStore).not.toHaveBeenCalled();
});
it("closes only after a completed decision or when none was prepared", () => {
  for (const outcome of ["committed", "not-prepared"] as const) {
    const preventQuit = vi.fn(), reopenWindow = vi.fn(), closeStore = vi.fn();
    expect(finishWorkspaceQuit({commitRestart: () => outcome, preventQuit, reopenWindow, closeStore})).toBe("quit");
    expect(closeStore).toHaveBeenCalledOnce();
    expect(preventQuit).not.toHaveBeenCalled();
    expect(reopenWindow).not.toHaveBeenCalled();
  }
});
it("treats an unexpected commit failure as a held quit", () => {
  const preventQuit = vi.fn(), reopenWindow = vi.fn(), closeStore = vi.fn();
  expect(finishWorkspaceQuit({commitRestart: () => {throw new Error("uncertain");}, preventQuit, reopenWindow, closeStore})).toBe("held");
  expect(preventQuit).toHaveBeenCalledOnce();
  expect(closeStore).not.toHaveBeenCalled();
});

it("holds quit and retains accepted-quit resources after SQLite close fails", () => {
  const error = new Error("SQLite close unknown");
  const preventQuit = vi.fn(), reopenWindow = vi.fn(), closeStore = vi.fn(() => {throw error;});
  expect(finishWorkspaceQuit({preventQuit, reopenWindow, closeStore})).toBe("held");
  expect(closeStore).toHaveBeenCalledOnce();expect(preventQuit).toHaveBeenCalledOnce();expect(reopenWindow).toHaveBeenCalledOnce();
  expect(workspaceQuitCloseFailure()).toBe(error);
  expect(finishWorkspaceQuit({preventQuit, reopenWindow, closeStore() {}})).toBe("quit");
  expect(workspaceQuitCloseFailure()).toBeUndefined();
});
