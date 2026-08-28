import { rustWasmReleaseArchiveUrl } from "../lib/src/rust_wasm_release.ts";
import {
  prepareCachedArchive,
  type SysrootCacheSource,
  validateRustSrcArchive,
} from "./sysroot_cache.ts";

type PreparedArchive = {
  archive: Uint8Array;
  source: SysrootCacheSource;
  cacheArchive: string;
  url: string;
};

export type ReleasedRustSrcArchiveDeps = {
  prepare(options: {
    triple: string;
    cacheDir?: string;
    url: string;
  }): Promise<PreparedArchive>;
  validate(archive: Uint8Array): Promise<boolean>;
  remove(path: string): Promise<void>;
};

export type ReleasedRustSrcArchiveOptions = {
  cacheDir?: string;
  deps?: ReleasedRustSrcArchiveDeps;
};

const defaultDeps: ReleasedRustSrcArchiveDeps = {
  prepare: (options) => prepareCachedArchive(options),
  validate: validateRustSrcArchive,
  remove: async (path) => {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
};

export async function prepareReleasedRustSrcArchive(
  options: ReleasedRustSrcArchiveOptions = {},
): Promise<Omit<PreparedArchive, "url">> {
  const deps = options.deps ?? defaultDeps;
  const prepared = await deps.prepare({
    triple: "rust-src",
    cacheDir: options.cacheDir,
    url: rustWasmReleaseArchiveUrl("rust-src"),
  });
  if (!(await deps.validate(prepared.archive))) {
    await deps.remove(prepared.cacheArchive);
    throw new Error("released rust-src archive is invalid");
  }
  return {
    archive: prepared.archive,
    cacheArchive: prepared.cacheArchive,
    source: prepared.source,
  };
}
