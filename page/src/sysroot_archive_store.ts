import {
  type ArchiveBytesOptions,
  loadSysrootArchiveBytes,
  maintainRustSrcArchiveCache,
  parseSysrootArchiveEntriesFromBytes,
  type SysrootArchiveEntry,
} from "./sysroot_archive.ts";
import { takeExactSysrootChunk } from "./sysroot_protocol.ts";
import { populateWebRustSrc } from "./web_sysroot.ts";
import { workspaceFileSystem } from "./workspace_fs.ts";

export type SysrootArchiveProgress = {
  triple: string;
  state: "fetching" | "ready" | "reading" | "complete" | "failed";
  loaded?: number;
  total?: number;
  error?: string;
};

type SysrootArchiveStoreDependencies = {
  loadBytes?: (
    triple: string,
    options?: ArchiveBytesOptions,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  parseEntries?: (
    archiveBytes: Uint8Array<ArrayBuffer>,
  ) => Promise<SysrootArchiveEntry[]>;
  maintainRustSrcCache?: () => void;
};

type ActiveArchive = {
  triple: string;
  data: Uint8Array;
  loaded: number;
  total: number;
};

type SysrootArchiveCallbackMessage = {
  name: string;
  args?: Record<string, unknown>;
};

const errorMessage = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown sysroot archive error";
  }
};

export class SysrootArchiveStore {
  readonly #loadBytes: NonNullable<
    SysrootArchiveStoreDependencies["loadBytes"]
  >;
  readonly #parseEntries: NonNullable<
    SysrootArchiveStoreDependencies["parseEntries"]
  >;
  readonly #maintainRustSrcCache: NonNullable<
    SysrootArchiveStoreDependencies["maintainRustSrcCache"]
  >;
  readonly #loads = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  readonly #archives = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly #listeners = new Set<(progress: SysrootArchiveProgress) => void>();
  readonly #disposeController = new AbortController();
  #active: ActiveArchive | null = null;
  #disposed = false;

  constructor(dependencies: SysrootArchiveStoreDependencies = {}) {
    this.#loadBytes = dependencies.loadBytes ?? loadSysrootArchiveBytes;
    this.#parseEntries =
      dependencies.parseEntries ?? parseSysrootArchiveEntriesFromBytes;
    this.#maintainRustSrcCache =
      dependencies.maintainRustSrcCache ?? maintainRustSrcArchiveCache;
  }

  prefetch(triples: readonly string[], signal: AbortSignal): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new Error("Sysroot archive store disposed"));
    }
    try {
      signal.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.all(
      triples.map((triple) => this.#prefetchOne(triple, signal)),
    ).then(() => undefined);
  }

  beginRead(triple: string): void {
    this.#throwIfDisposed();
    const archive = this.#archives.get(triple);
    if (archive === undefined) {
      throw new Error(`sysroot archive ${triple} is not ready`);
    }
    this.#active = {
      triple,
      data: archive,
      loaded: 0,
      total: archive.byteLength,
    };
    this.#emit({
      triple,
      state: "reading",
      loaded: 0,
      total: archive.byteLength,
    });
  }

  archiveLength(): number | null {
    return this.#active?.total ?? null;
  }

  readChunk(length: number): Uint8Array {
    this.#throwIfDisposed();
    const active = this.#active;
    if (active === null) {
      throw new Error("No current sysroot archive to read data from");
    }
    const { chunk, remaining } = takeExactSysrootChunk(active.data, length);
    const loaded = active.loaded + chunk.byteLength;
    if (remaining.byteLength === 0) {
      this.#active = null;
      this.#emit({
        triple: active.triple,
        state: "complete",
        loaded,
        total: active.total,
      });
    } else {
      active.data = remaining;
      active.loaded = loaded;
      this.#emit({
        triple: active.triple,
        state: "reading",
        loaded,
        total: active.total,
      });
    }
    return chunk;
  }

  subscribe(listener: (progress: SysrootArchiveProgress) => void): () => void {
    this.#throwIfDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  waitForReadCompletion(triple: string, signal: AbortSignal): Promise<void> {
    this.#throwIfDisposed();
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = this.subscribe((progress) => {
        if (progress.triple !== triple) return;
        if (progress.state === "complete") settle(resolve);
        if (progress.state === "failed") {
          settle(() =>
            reject(new Error(progress.error ?? "sysroot read failed")),
          );
        }
      });
      const onAbort = () => settle(() => reject(signal.reason));
      const settle = (complete: () => void) => {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        complete();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeController.abort(new Error("Sysroot archive store disposed"));
    this.#loads.clear();
    this.#archives.clear();
    this.#active = null;
    this.#listeners.clear();
  }

  #prefetchOne(
    triple: string,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const existing = this.#loads.get(triple);
    if (existing !== undefined) return existing;

    const controller = new AbortController();
    const relayAbort = (source: AbortSignal) => {
      if (!controller.signal.aborted) controller.abort(source.reason);
    };
    const abortFromSignal = () => relayAbort(signal);
    const abortFromDispose = () => relayAbort(this.#disposeController.signal);
    signal.addEventListener("abort", abortFromSignal, { once: true });
    this.#disposeController.signal.addEventListener("abort", abortFromDispose, {
      once: true,
    });

    this.#emit({ triple, state: "fetching" });
    let loading!: Promise<Uint8Array<ArrayBuffer>>;
    loading = (async () => {
      controller.signal.throwIfAborted();
      const archiveBytes = await this.#loadBytes(triple, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (triple === "rust-src") {
        const entries = await this.#parseEntries(archiveBytes);
        controller.signal.throwIfAborted();
        const decoder = new TextDecoder();
        const hasCoreRoot = entries.some(
          (entry) =>
            !entry.isDirectory &&
            entry.data.byteLength > 0 &&
            decoder.decode(entry.name) === "core/src/lib.rs",
        );
        if (!hasCoreRoot) {
          throw new Error("rust-src archive is missing core/src/lib.rs");
        }
        populateWebRustSrc(workspaceFileSystem.sysrootContents, entries);
        this.#maintainRustSrcCache();
      }
      this.#archives.set(triple, archiveBytes);
      this.#emit({
        triple,
        state: "ready",
        loaded: archiveBytes.byteLength,
        total: archiveBytes.byteLength,
      });
      return archiveBytes;
    })()
      .catch((error) => {
        if (this.#loads.get(triple) === loading) this.#loads.delete(triple);
        this.#archives.delete(triple);
        this.#emit({ triple, state: "failed", error: errorMessage(error) });
        throw error;
      })
      .finally(() => {
        signal.removeEventListener("abort", abortFromSignal);
        this.#disposeController.signal.removeEventListener(
          "abort",
          abortFromDispose,
        );
      });
    this.#loads.set(triple, loading);
    return loading;
  }

  #emit(progress: SysrootArchiveProgress): void {
    for (const listener of this.#listeners) {
      try {
        listener(progress);
      } catch (error) {
        console.error("Sysroot archive progress listener failed", error);
      }
    }
  }

  #throwIfDisposed(): void {
    if (this.#disposed) throw new Error("Sysroot archive store disposed");
  }
}

export function createSysrootArchiveCallbackAdapter(
  archiveStore: Pick<
    SysrootArchiveStore,
    "beginRead" | "archiveLength" | "readChunk"
  >,
): (message: SysrootArchiveCallbackMessage) => unknown {
  let sysrootError: string | null = null;
  return (message) => {
    if (message.name === "sysrootStartFetch") {
      const triple = message.args?.triple as string;
      sysrootError = null;
      try {
        archiveStore.beginRead(triple);
        return {};
      } catch (error) {
        sysrootError = errorMessage(error);
        return { error: sysrootError };
      }
    }
    if (message.name === "sysrootArchiveGetMeta") {
      if (sysrootError !== null) {
        return { has_archive: -1, data_len: 0, error: sysrootError };
      }
      const archiveLength = archiveStore.archiveLength();
      return archiveLength === null
        ? { has_archive: false, data_len: 0 }
        : { has_archive: true, data_len: archiveLength };
    }
    if (message.name === "sysrootReadArchiveChunk") {
      const chunk = archiveStore.readChunk(message.args?.chunk_len as number);
      return { chunk: Array.from(chunk) };
    }
    return undefined;
  };
}
