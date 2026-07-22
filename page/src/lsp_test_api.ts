import type * as Monaco from "monaco-editor";

type TestApi = {
  mainDidOpenComplete?: boolean;
  ready: boolean;
  monaco?: typeof Monaco;
  vfsWrites: Array<{ path: string; content: string }>;
};

export function recordDidOpenComplete(uri: string): void {
  if (!enabled || uri !== "file:///src/main.rs") return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.mainDidOpenComplete = true;
}

declare global {
  interface Window {
    __rubrcLspTest?: TestApi;
  }
}

const enabled = import.meta.env.VITE_RUBRC_LSP_TEST === "1";

export function exposeMonaco(monaco: typeof Monaco): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.monaco = monaco;
}

export function markLspReady(): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.ready = true;
}

export function recordVfsWrite(path: string, content: string): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.vfsWrites.push({ path, content });
}
