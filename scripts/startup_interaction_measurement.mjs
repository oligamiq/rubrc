import { withDeadline } from "./stdlib_cache_browser_support.mjs";

export async function measureEditorInteractions(page, screenshotPrefix) {
  const original = await page.evaluate(() => window.__rubrcLspTest.model.getValue());
  const input = await page.createCDPSession();
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
    await input.send("Input.insertText", { text });
    await page.waitForFunction(value => window.__rubrcLspTest.model.getValue() === value, { timeout: 10000 }, text);
    return inputStarted;
  }
  try {
    const prefix = "fn main() { let _ = std::";
    await paste(`${prefix} }`);
    await page.evaluate(column => {
      const api = window.__rubrcLspTest;
      api.editor.setPosition({ lineNumber: 1, column });
    }, prefix.length + 1);
    const completionStart = performance.now();
    await page.evaluate(() => window.__rubrcLspTest.editor.trigger("measurement", "editor.action.triggerSuggest", {}));
    await page.waitForFunction(() => {
      const labels = [...document.querySelectorAll(".suggest-widget.visible .monaco-list-row")].map(row => row.textContent ?? "");
      if (!labels.some(label => /\b(alloc|any|arch|array|collections|env|time)\b/.test(label))) return false;
      window.__rubrcCompletionLabels = labels;
      return true;
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
    await withDeadline(input.detach(), 3000, "detach input session").catch(() => {});
  }
}
