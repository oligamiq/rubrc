export type SemanticProviderCancellationToken = {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => unknown): { dispose(): unknown };
};

type GateState = "closed" | "open" | "disposed";

export class SemanticProviderGate {
  private state: GateState = "closed";
  private readonly settled: Promise<void>;
  private settle!: () => void;

  constructor() {
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  open(): void {
    if (this.state !== "closed") return;
    this.state = "open";
    this.settle();
  }

  dispose(): void {
    if (this.state !== "closed") return;
    this.state = "disposed";
    this.settle();
  }

  private currentState(): GateState {
    return this.state;
  }

  async wait(token: SemanticProviderCancellationToken): Promise<boolean> {
    if (this.state === "open") return !token.isCancellationRequested;
    if (this.state === "disposed" || token.isCancellationRequested) {
      return false;
    }

    let cancellation: { dispose(): unknown } | undefined;
    const cancelled = new Promise<void>((resolve) => {
      cancellation = token.onCancellationRequested(resolve);
    });
    try {
      await Promise.race([this.settled, cancelled]);
      return this.currentState() === "open" && !token.isCancellationRequested;
    } finally {
      cancellation?.dispose();
    }
  }
}
