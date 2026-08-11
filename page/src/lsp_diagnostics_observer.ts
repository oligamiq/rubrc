export type DiagnosticsPublicationTestState = {
  lspEvents?: unknown[];
  mainDiagnosticsPublicationCount?: number;
};

export function recordLspTestEvent<TEvent>(
  state: DiagnosticsPublicationTestState | undefined,
  event: TEvent,
): void {
  if (!state) return;
  state.lspEvents ??= [];
  state.lspEvents.push(event);
}

export function observeDiagnosticsPublication<
  TUri extends { toString(): string },
  TDiagnostics,
  TResult,
>(
  state: DiagnosticsPublicationTestState | undefined,
  uri: TUri,
  diagnostics: TDiagnostics,
  next: (uri: TUri, diagnostics: TDiagnostics) => TResult,
): TResult {
  if (state && uri.toString() === "file:///src/main.rs") {
    state.mainDiagnosticsPublicationCount =
      (state.mainDiagnosticsPublicationCount ?? 0) + 1;
  }
  return next(uri, diagnostics);
}
