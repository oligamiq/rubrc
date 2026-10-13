import { withDeadline } from "./stdlib_cache_browser_support.mjs";

export async function measureEditorInteractions(page, screenshotPrefix) {
  const original = await page.evaluate(() => window.__rubrcLspTest.model.getValue());
  async function paste(text) {
    const element = await page.waitForSelector(".monaco-editor", { visible: true, timeout: 10000 });
    const box = await element.boundingBox();
    if (!box) throw new Error("editor has no visible layout");
    const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
    if (touch) await page.touchscreen.tap(box.x + 30, box.y + 30);
    else await page.mouse.click(box.x + 30, box.y + 30);
    await page.evaluate(() => {
      const api = window.__rubrcLspTest;
      api.editor.focus();
      api.editor.setSelection(api.model.getFullModelRange());
    });
    const inputStarted = performance.now();
    await page.keyboard.insertText(text);
    await page.waitForFunction(value => window.__rubrcLspTest.model.getValue() === value, { timeout: 10000 }, text);
    return inputStarted;
  }
  try {
    const prefix = "fn main() { let _ = std::";
    await paste(`${prefix} }`);
    await page.evaluate(column => {
      const api = window.__rubrcLspTest;
      api.editor.setPosition({ lineNumber: 1, column });
      window.__rubrcPreviousCompletions = new Set((api.lspEvents ?? []).filter(e => e.message?.method === "textDocument/completion").map(e => e.message.id));
    }, prefix.length + 1);
    const completionStart = performance.now();
    await page.evaluate(() => window.__rubrcLspTest.editor.trigger("measurement", "editor.action.triggerSuggest", {}));
    await page.waitForFunction(() => {
      const events = window.__rubrcLspTest.lspEvents ?? [];
      const ids = new Set(events.filter(e => e.message?.method === "textDocument/completion" && !window.__rubrcPreviousCompletions.has(e.message.id)).map(e => e.message.id));
      for (const e of events) {
        if (e.boundary !== "inbound" || !ids.has(e.message?.id) || !e.message.result) continue;
        const result = e.message.result;
        const labels = (Array.isArray(result) ? result : result.items ?? []).map(item => item.label);
        if (labels.some(label => /collections/.test(label)) && document.querySelector(".suggest-widget.visible")) {
          window.__rubrcCompletionLabels = labels;
          return true;
        }
      }
      return false;
    }, { timeout: 60000 });
    const completionMs = performance.now() - completionStart;
    const labels = await page.evaluate(() => window.__rubrcCompletionLabels);
    await page.screenshot({ path: `${screenshotPrefix}-completion.png` });
    await page.keyboard.press("Escape");
    const errorSource = 'fn main() { let value: u32 = "type error"; }';
    const diagnosticStart = await paste(errorSource);
    await page.waitForFunction(() => {
      const api = window.__rubrcLspTest;
      return api.monaco.editor.getModelMarkers({ resource: api.model.uri })
        .some(marker => /mismatch|expected.*u32|expected.*str/i.test(marker.message));
    }, { timeout: 60000 });
    const diagnosticMs = performance.now() - diagnosticStart;
    const diagnostics = await page.evaluate(() => {
      const api = window.__rubrcLspTest;
      return api.monaco.editor.getModelMarkers({ resource: api.model.uri }).map(marker => marker.message);
    });
    await page.screenshot({ path: `${screenshotPrefix}-diagnostic.png` });
    return { completionMs, completionCount: labels.length, completionSample: labels.slice(0, 10),
      diagnosticMs, diagnostics };
  } finally {
    await withDeadline(page.evaluate(text => window.__rubrcLspTest.model.setValue(text), original), 5000, "restore model").catch(() => {});
  }
}
