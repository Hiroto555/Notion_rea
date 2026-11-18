import type { Locator, Page } from "@playwright/test";

// Navigation helpers for the UI 1/3/4 chrome. They only operate on Page and
// Locator values supplied by the caller; they never launch a window, install a
// test hook, call a product API or force application state through evaluate.
//
// Everything below is idempotent: a disclosure is opened only while closed and
// the original button/summary click remains the user-facing path.

async function detailsOpen(details: Locator): Promise<boolean> {
  return (await details.getAttribute("open")) !== null;
}

async function openDetails(details: Locator): Promise<void> {
  if (!(await detailsOpen(details)))
    await details.locator(":scope > summary").first().click();
}

/** The normal Page editor. Record editors are deliberately outside this scope. */
export function documentEditor(page: Page): Locator {
  return page.locator(".document-content .editor-root").first();
}

/**
 * Capacity/maintenance moved from the inspector to the always-reachable
 * workspace "保存と復旧" disclosure. The inner maintenance details keeps its
 * own open state and is opened only when it is still closed.
 */
export async function openWorkspaceMaintenance(page: Page): Promise<Locator> {
  const tools = page.locator(".workspace-tools").first();
  if (!(await detailsOpen(tools)))
    await tools
      .locator(":scope > summary")
      .filter({ hasText: "保存と復旧" })
      .click();
  const section = tools.locator(".workspace-maintenance").first();
  await openDetails(section.locator("details").first());
  return section;
}

/** The topbar ページ情報 toggle starts closed; open it only when needed. */
export async function openInspector(page: Page): Promise<Locator> {
  const inspector = page.locator(".inspector").first();
  if (!(await inspector.isVisible())) {
    await page.getByLabel("ページ情報", { exact: true }).click();
    await inspector.waitFor({ state: "visible" });
  }
  return inspector;
}

/** The always-available 編集 menu for this specific editor instance. */
export async function openEditorEdit(root: Locator): Promise<Locator> {
  const edit = root.locator(".editor-edit").first();
  await openDetails(edit);
  return edit;
}

/**
 * Run an existing command button inside the 編集 menu. Commands close the
 * menu, so every call re-opens it; keyboard shortcuts are not substituted and
 * the button route stays covered.
 */
export async function clickEditorEditButton(
  root: Locator,
  name: string,
): Promise<void> {
  const edit = await openEditorEdit(root);
  const button = edit.getByRole("button", { name, exact: true });
  if (await button.count()) await button.first().click();
  else await edit.getByTitle(name, { exact: true }).click();
}

/**
 * Link entry: a non-empty text selection exposes the selection toolbar, while
 * a bare cursor uses the 編集 menu. Both are scoped so the hidden duplicate in
 * the other surface is never clicked and another editor is left untouched.
 */
export async function clickPageLink(root: Locator): Promise<void> {
  const toolbar = root.locator(".editor-selection-toolbar");
  if (await toolbar.isVisible()) {
    await toolbar.getByTitle("ページへのリンク", { exact: true }).click();
    return;
  }
  const edit = await openEditorEdit(root);
  await edit.getByTitle("ページへのリンク", { exact: true }).click();
}
