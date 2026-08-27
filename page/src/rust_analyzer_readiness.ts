export type AnalyzerRequestClient = {
  sendRequest<R>(method: string, params: unknown): Promise<R>;
};

export type MonacoRangeLike = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

type ReadinessTiming = {
  now?: () => number;
  sleep?: () => Promise<void>;
  timeoutMs?: number;
};

type ReadinessModel = {
  getVersionId(): number;
  getFullModelRange(): MonacoRangeLike;
};

const POLL_INTERVAL_MS = 250;
const CRATE_GRAPH_POLL_INTERVAL_MS = 5_000;
const PHASE_TIMEOUT_MS = 300_000;
const CONTENT_MODIFIED = -32801;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isContentModified = (error: unknown) =>
  isObject(error) && error.code === CONTENT_MODIFIED;

const dotStatements = (dot: string) => {
  const statements: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < dot.length; index++) {
    const character = dot[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ";") {
      statements.push(dot.slice(start, index));
      start = index + 1;
    }
  }
  statements.push(dot.slice(start));
  return statements;
};

const dotAttributeGroups = (statement: string) => {
  let declaration = statement.trim();
  const graphStart = declaration.lastIndexOf("{");
  if (graphStart >= 0) declaration = declaration.slice(graphStart + 1).trim();
  const nodeId = declaration.match(
    /^(?:[A-Za-z_][\w]*|"(?:\\.|[^"\\])*")/,
  );
  if (!nodeId) return undefined;
  if (["node", "edge", "graph", "digraph", "strict"].includes(nodeId[0])) {
    return undefined;
  }

  const groups: string[] = [];
  let index = nodeId[0].length;
  while (index < declaration.length) {
    while (/\s/.test(declaration[index] ?? "")) index++;
    if (declaration[index] !== "[") return undefined;
    const start = ++index;
    let quoted = false;
    let escaped = false;
    for (; index < declaration.length; index++) {
      const character = declaration[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "]") break;
    }
    if (index >= declaration.length) return undefined;
    groups.push(declaration.slice(start, index));
    index++;
  }
  return groups;
};

const quotedDotAttribute = (groups: string[], wanted: string) => {
  for (const group of groups) {
    let index = 0;
    while (index < group.length) {
      while (/[,;\s]/.test(group[index] ?? "")) index++;
      const key = group.slice(index).match(/^[A-Za-z_][\w]*/)?.[0];
      if (!key) break;
      index += key.length;
      while (/\s/.test(group[index] ?? "")) index++;
      if (group[index++] !== "=") break;
      while (/\s/.test(group[index] ?? "")) index++;

      let value = "";
      let quoted = false;
      if (group[index] === '"') {
        quoted = true;
        index++;
        while (index < group.length) {
          const character = group[index++];
          if (character === "\\" && index < group.length) {
            value += character + group[index++];
          } else if (character === '"') {
            break;
          } else {
            value += character;
          }
        }
      } else {
        const end = group.slice(index).search(/[,;\s]/);
        const length = end < 0 ? group.length - index : end;
        value = group.slice(index, index + length);
        index += length;
      }
      if (key === wanted && quoted) return value;
    }
  }
  return undefined;
};

const nodeLabels = (dot: string) => {
  const labels = new Set<string>();
  for (const statement of dotStatements(dot)) {
    const groups = dotAttributeGroups(statement);
    if (!groups) continue;
    const label = quotedDotAttribute(groups, "label");
    if (!label) continue;
    labels.add(
      label.replace(
        /\\(["\\nrt])/g,
        (_match, escaped: string) =>
          escaped === "n"
            ? "\n"
            : escaped === "r"
            ? "\r"
            : escaped === "t"
            ? "\t"
            : escaped,
      ),
    );
  }
  return labels;
};

const crateGraphIsReady = (dot: unknown) => {
  if (typeof dot !== "string") return false;
  const labels = nodeLabels(dot);
  return labels.has("rubrc_main") && labels.has("core");
};

export class RustAnalyzerReadiness {
  private readonly now: () => number;
  private readonly sleep: () => Promise<void>;
  private readonly graphSleep: () => Promise<void>;
  private readonly timeoutMs: number;
  private crateGraphReady = false;
  private diagnosticsVersion: number | undefined;
  private semanticDeadline = 0;
  private generation = 0;
  private disposed = false;
  private readonly disposeController = new AbortController();

  constructor(
    private readonly client: AnalyzerRequestClient,
    private readonly uri: string,
    timing: ReadinessTiming = {},
  ) {
    this.now = timing.now ?? performance.now.bind(performance);
    this.sleep = timing.sleep ??
      (() =>
        new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)));
    this.graphSleep = timing.sleep ??
      (() =>
        new Promise<void>((resolve) =>
          setTimeout(resolve, CRATE_GRAPH_POLL_INTERVAL_MS)
        ));
    this.timeoutMs = timing.timeoutMs ?? PHASE_TIMEOUT_MS;
  }

  observeMessage(message: unknown): void {
    if (!this.crateGraphReady || !isObject(message)) return;
    if (message.method !== "textDocument/publishDiagnostics") return;
    const params = message.params;
    if (!isObject(params) || params.uri !== this.uri) return;
    if (typeof params.version !== "number") return;
    if (
      this.diagnosticsVersion === undefined ||
      params.version >= this.diagnosticsVersion
    ) {
      this.diagnosticsVersion = params.version;
    }
  }

  noteDocumentChanged(_version: number): void {
    this.diagnosticsVersion = undefined;
    this.generation++;
    this.semanticDeadline = this.now() + this.timeoutMs;
  }

  async waitForCrateGraph(signal: AbortSignal): Promise<void> {
    const deadline = this.now() + this.timeoutMs;
    while (true) {
      this.checkActive(signal);
      if (this.now() >= deadline) {
        throw new Error(
          `rust-analyzer crate graph timed out after ${this.timeoutMs}ms`,
        );
      }
      let dot: unknown;
      try {
        dot = await this.awaitPhaseOperation(
          this.client.sendRequest<unknown>(
            "rust-analyzer/viewCrateGraph",
            { full: true },
          ),
          signal,
          () => deadline,
          "rust-analyzer crate graph",
        );
      } catch (error) {
        if (!isContentModified(error)) throw error;
        await this.awaitPhaseOperation(
          this.graphSleep(),
          signal,
          () => deadline,
          "rust-analyzer crate graph",
        );
        continue;
      }
      this.checkActive(signal);
      if (crateGraphIsReady(dot)) {
        this.crateGraphReady = true;
        this.diagnosticsVersion = undefined;
        return;
      }
      await this.awaitPhaseOperation(
        this.graphSleep(),
        signal,
        () => deadline,
        "rust-analyzer crate graph",
      );
    }
  }

  async waitForSemanticReadiness(
    model: ReadinessModel,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.crateGraphReady) {
      throw new Error("rust-analyzer crate graph is not ready");
    }
    this.semanticDeadline = this.now() + this.timeoutMs;

    while (true) {
      const generationBeforeSleep = this.generation;
      await this.awaitPhaseOperation(
        this.sleep(),
        signal,
        () => this.semanticDeadline,
        "rust-analyzer semantic readiness",
      );
      this.checkActive(signal);
      if (this.now() >= this.semanticDeadline) {
        throw new Error(
          `rust-analyzer semantic readiness timed out after ${this.timeoutMs}ms`,
        );
      }
      if (generationBeforeSleep !== this.generation) continue;

      const version = model.getVersionId();
      if (this.diagnosticsVersion !== version) continue;
      const generation = this.generation;
      const range = model.getFullModelRange();

      try {
        await this.awaitPhaseOperation(
          this.client.sendRequest<unknown>("textDocument/inlayHint", {
            textDocument: { uri: this.uri },
            range: {
              start: {
                line: range.startLineNumber - 1,
                character: range.startColumn - 1,
              },
              end: {
                line: range.endLineNumber - 1,
                character: range.endColumn - 1,
              },
            },
          }),
          signal,
          () => this.semanticDeadline,
          "rust-analyzer semantic readiness",
        );
      } catch (error) {
        if (isContentModified(error)) continue;
        throw error;
      }

      if (
        generation === this.generation &&
        version === model.getVersionId() &&
        this.diagnosticsVersion === version
      ) {
        return;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.diagnosticsVersion = undefined;
    this.disposeController.abort(
      new Error("rust-analyzer readiness is disposed"),
    );
  }

  private checkActive(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("rust-analyzer readiness is disposed");
  }

  private async awaitPhaseOperation<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    deadline: () => number,
    phase: string,
  ): Promise<T> {
    this.checkActive(signal);
    if (this.now() >= deadline()) {
      throw new Error(`${phase} timed out after ${this.timeoutMs}ms`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    let onDispose!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      onDispose = () => reject(this.disposeController.signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      this.disposeController.signal.addEventListener("abort", onDispose, {
        once: true,
      });
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      const schedule = () => {
        const remaining = deadline() - this.now();
        if (remaining <= 0) {
          reject(new Error(`${phase} timed out after ${this.timeoutMs}ms`));
          return;
        }
        timer = setTimeout(() => {
          if (this.now() >= deadline()) {
            reject(new Error(`${phase} timed out after ${this.timeoutMs}ms`));
          } else {
            schedule();
          }
        }, remaining);
      };
      schedule();
    });

    try {
      const value = await Promise.race([operation, cancelled, timedOut]);
      this.checkActive(signal);
      if (this.now() >= deadline()) {
        throw new Error(`${phase} timed out after ${this.timeoutMs}ms`);
      }
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.disposeController.signal.removeEventListener("abort", onDispose);
    }
  }
}
