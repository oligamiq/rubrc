import { appendBounded } from "./terminal_channel_lifecycle.ts";

export type RuntimeGeneration = string;

export interface Disposable {
  dispose(): void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalView {
  write(value: string): void;
  size(): TerminalSize;
}

export interface RuntimeTerminalService {
  readonly generation: RuntimeGeneration;
  write(sessionId: number, data: Uint8Array, error?: boolean): void;
  attach(sessionId: number, view: TerminalView): Disposable;
  size(sessionId: number): TerminalSize;
  out(sessionId: number): string;
  error(sessionId: number): string;
  dispose(): void;
}

interface Attachment {
  attachment: symbol;
  view: TerminalView;
}

interface PendingAttachment extends Attachment {
  pending: string[];
}

interface TerminalSession {
  outDecoder: TextDecoder;
  errorDecoder: TextDecoder;
  history: string;
  historyBytes: number;
  out: string;
  outBytes: number;
  error: string;
  errorBytes: number;
  view?: Attachment;
  attaching?: PendingAttachment;
}

const OUTPUT_LIMIT = 64 * 1024;

export class RuntimeTerminalService implements RuntimeTerminalService {
  private readonly sessions = new Map<number, TerminalSession>();
  private active = true;

  constructor(readonly generation: RuntimeGeneration) {}

  write(sessionId: number, data: Uint8Array, error = false): void {
    this.assertActive();
    const session = this.session(sessionId);
    const decoder = error ? session.errorDecoder : session.outDecoder;
    const value = decoder.decode(data, { stream: true });
    if (value.length === 0) return;

    const history = appendBounded(
      session.history,
      session.historyBytes,
      value,
      OUTPUT_LIMIT,
    );
    session.history = history.value;
    session.historyBytes = history.bytes;

    const capture = appendBounded(
      error ? session.error : session.out,
      error ? session.errorBytes : session.outBytes,
      value,
      OUTPUT_LIMIT,
    );
    if (error) {
      session.error = capture.value;
      session.errorBytes = capture.bytes;
    } else {
      session.out = capture.value;
      session.outBytes = capture.bytes;
    }

    session.attaching?.pending.push(value);
    const current = session.view;
    try {
      current?.view.write(value);
    } catch (error) {
      if (session.view?.attachment === current?.attachment) {
        session.view = undefined;
      }
      throw error;
    }
  }

  attach(sessionId: number, view: TerminalView): Disposable {
    this.assertActive();
    const session = this.session(sessionId);
    const attachment = Symbol(`${this.generation}:${sessionId}`);

    if (session.attaching?.view === view) {
      session.attaching.attachment = attachment;
      return this.disposable(session, attachment);
    }
    if (session.view?.view === view) {
      session.attaching = undefined;
      session.view = { attachment, view };
      return this.disposable(session, attachment);
    }

    const pending: PendingAttachment = { attachment, view, pending: [] };
    session.attaching = pending;
    try {
      view.write(session.history);
      while (
        this.active &&
        this.sessions.get(sessionId) === session &&
        session.attaching === pending &&
        pending.pending.length > 0
      ) {
        view.write(pending.pending[0]);
        if (session.attaching === pending) pending.pending.shift();
      }
      if (
        this.active &&
        this.sessions.get(sessionId) === session &&
        session.attaching === pending
      ) {
        session.view = { attachment: pending.attachment, view };
        session.attaching = undefined;
      }
    } catch (error) {
      if (session.attaching === pending) session.attaching = undefined;
      throw error;
    }
    return this.disposable(session, attachment);
  }

  size(sessionId: number): TerminalSize {
    this.assertActive();
    return (
      this.sessions.get(sessionId)?.view?.view.size() ?? { cols: 80, rows: 24 }
    );
  }

  out(sessionId: number): string {
    this.assertActive();
    return this.sessions.get(sessionId)?.out ?? "";
  }

  error(sessionId: number): string {
    this.assertActive();
    return this.sessions.get(sessionId)?.error ?? "";
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();

    const errors: unknown[] = [];
    for (const session of sessions) {
      for (const decoder of [session.outDecoder, session.errorDecoder]) {
        try {
          decoder.decode();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "runtime terminal UTF-8 finalization failed",
      );
    }
  }

  private disposable(
    session: TerminalSession,
    attachment: symbol,
  ): Disposable {
    return {
      dispose: () => {
        if (session.attaching?.attachment === attachment) {
          session.attaching = undefined;
        }
        if (session.view?.attachment === attachment) session.view = undefined;
      },
    };
  }

  private session(sessionId: number): TerminalSession {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = {
        outDecoder: new TextDecoder("utf-8", { fatal: true }),
        errorDecoder: new TextDecoder("utf-8", { fatal: true }),
        history: "",
        historyBytes: 0,
        out: "",
        outBytes: 0,
        error: "",
        errorBytes: 0,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private assertActive(): void {
    if (!this.active) throw new Error("runtime terminal service is disposed");
  }
}
