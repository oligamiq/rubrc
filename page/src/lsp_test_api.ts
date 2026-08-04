import type * as Monaco from "monaco-editor";
import {
  type DiagnosticsPublicationTestState,
  observeDiagnosticsPublication,
  recordLspTestEvent,
} from "./lsp_diagnostics_observer";

type TestApi = DiagnosticsPublicationTestState & {
  mainDidOpenComplete?: boolean;
  requestSyntaxTree?: (uri: string) => Promise<string>;
  ready: boolean;
  monaco?: typeof Monaco;
  vfsWrites: Array<{ path: string; content: string }>;
};

type SyntaxTreeRequestClient = {
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>;
};

type SyntaxTreeRequestState = Pick<TestApi, "requestSyntaxTree">;

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

const enabled = import.meta.env?.VITE_RUBRC_LSP_TEST === "1";

export function handlePublishedDiagnostics<
  TUri extends { toString(): string },
  TDiagnostics,
  TResult,
>(
  uri: TUri,
  diagnostics: TDiagnostics,
  next: (uri: TUri, diagnostics: TDiagnostics) => TResult,
): TResult {
  let state: TestApi | undefined;
  if (enabled) {
    window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
    state = window.__rubrcLspTest;
  }
  return observeDiagnosticsPublication(state, uri, diagnostics, next);
}

export function recordLspMessage(
  boundary: "inbound" | "outbound" | "outbound-complete",
  message: unknown,
): void {
  if (!enabled || typeof message !== "object" || message === null) return;
  const method = "method" in message ? message.method : undefined;
  if (
    (boundary === "inbound" && method !== "textDocument/publishDiagnostics") ||
    (boundary !== "inbound" && method !== "textDocument/didChange")
  ) {
    return;
  }
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  recordLspTestEvent(window.__rubrcLspTest, {
    boundary,
    message,
  });
}

export function recordLspProgress(value: unknown): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  recordLspTestEvent(window.__rubrcLspTest, {
    boundary: "progress",
    value,
  });
}

export function recordLspConnectionEvent(
  boundary: "connection-error" | "connection-close" | "outbound-error",
  error?: unknown,
): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  recordLspTestEvent(window.__rubrcLspTest, {
    boundary,
    error: error instanceof Error ? error.message : String(error ?? ""),
  });
}

export function exposeMonaco(monaco: typeof Monaco): void {
  if (!enabled) return;
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  window.__rubrcLspTest.monaco = monaco;
}

export function installSyntaxTreeRequest(
  state: SyntaxTreeRequestState,
  client: SyntaxTreeRequestClient,
): { dispose(): void } {
  const requestSyntaxTree = (uri: string) =>
    client.sendRequest<string>("rust-analyzer/viewSyntaxTree", {
      textDocument: { uri },
    });
  state.requestSyntaxTree = requestSyntaxTree;
  return {
    dispose: () => {
      if (state.requestSyntaxTree === requestSyntaxTree) {
        delete state.requestSyntaxTree;
      }
    },
  };
}

export function exposeSyntaxTreeRequest(
  client: SyntaxTreeRequestClient,
): { dispose(): void } {
  if (!enabled) return { dispose() {} };
  window.__rubrcLspTest ??= { ready: false, vfsWrites: [] };
  return installSyntaxTreeRequest(window.__rubrcLspTest, client);
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
