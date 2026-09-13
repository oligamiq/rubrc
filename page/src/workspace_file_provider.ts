import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  Emitter,
  Event,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import type {
  FileSystemProviderErrorCode as ProviderErrorCode,
  FileType as ProviderFileType,
  IFileChange,
  IFileDeleteOptions,
  IFileOverwriteOptions,
  IFileSystemProviderWithFileReadWriteCapability,
  IFileWriteOptions,
  IStat,
  IWatchOptions,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import {
  type WorkspaceChange,
  WorkspaceFileSystem,
  workspaceFileSystem,
  WorkspaceFsError,
} from "./workspace_fs.ts";
import {
  getActiveRustSrcFsEndpoint,
  RUST_SRC_MOUNT_PATH,
  RustSrcVfsError,
  rustSrcRelativePath,
} from "./rust_src_vfs_rpc.ts";

type FilesService =
  typeof import("@codingame/monaco-vscode-files-service-override");
let filesService: FilesService | undefined;
let uriModule:
  | typeof import("@codingame/monaco-vscode-api/vscode/vs/base/common/uri")
  | undefined;
if (!("Deno" in globalThis)) {
  [filesService, uriModule] = await Promise.all([
    import("@codingame/monaco-vscode-files-service-override"),
    import("@codingame/monaco-vscode-api/vscode/vs/base/common/uri"),
  ]);
}

const FileChangeType = filesService?.FileChangeType ?? {
  UPDATED: 0,
  ADDED: 1,
  DELETED: 2,
};
const FileSystemProviderCapabilities =
  filesService?.FileSystemProviderCapabilities ?? {
    FileReadWrite: 2,
    PathCaseSensitive: 1024,
  };
const FileSystemProviderErrorCode = filesService?.FileSystemProviderErrorCode ??
  {
    FileExists: "EntryExists",
    FileNotFound: "EntryNotFound",
    FileNotADirectory: "EntryNotADirectory",
    FileIsADirectory: "EntryIsADirectory",
    Unavailable: "Unavailable",
    Unknown: "Unknown",
  };
const FileType = filesService?.FileType ?? { File: 1, Directory: 2 };

const isRustSrcAncestor = (path: string): boolean =>
  path !== RUST_SRC_MOUNT_PATH &&
  path !== "/" &&
  RUST_SRC_MOUNT_PATH.startsWith(`${path}/`);

const rustSrcAncestorChild = (path: string): string | undefined => {
  if (!isRustSrcAncestor(path)) return undefined;
  return RUST_SRC_MOUNT_PATH.slice(path.length + 1).split("/")[0];
};

const touchesRustSrcNamespace = (path: string): boolean =>
  rustSrcRelativePath(path) !== undefined || isRustSrcAncestor(path);

const mapError = (error: unknown): never => {
  if (!(error instanceof WorkspaceFsError) && !(error instanceof RustSrcVfsError)) {
    throw error;
  }
  const code = error instanceof RustSrcVfsError
    ? error.code === "NotFound"
      ? FileSystemProviderErrorCode.FileNotFound
      : error.code === "NotMounted"
      ? FileSystemProviderErrorCode.Unavailable
      : FileSystemProviderErrorCode.Unknown
    : error.code === "NotFound"
    ? FileSystemProviderErrorCode.FileNotFound
    : error.code === "Exists"
    ? FileSystemProviderErrorCode.FileExists
    : error.code === "NotDirectory"
    ? FileSystemProviderErrorCode.FileNotADirectory
    : error.code === "IsDirectory"
    ? FileSystemProviderErrorCode.FileIsADirectory
    : error.code === "NotEmpty"
    ? FileSystemProviderErrorCode.Unknown
    : FileSystemProviderErrorCode.Unavailable;
  if (filesService) {
    throw filesService.FileSystemProviderError.create(error.message, code as ProviderErrorCode);
  }
  const providerError = new Error(error.message);
  providerError.name = `${code} (FileSystemError)`;
  throw providerError;
};

export class WasiWorkspaceFileProvider
  implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  private readonly changes = new Emitter<readonly IFileChange[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(private readonly workspace: WorkspaceFileSystem) {
    workspace.onDidChange((change) =>
      this.changes.fire([this.fileChange(change)])
    );
  }

  async stat(resource: URI): Promise<IStat> {
    try {
      const path = this.path(resource);
      const relative = rustSrcRelativePath(path);
      if (relative !== undefined) {
        const endpoint = this.rustSrcEndpoint(path);
        const response = await endpoint({ operation: "stat", path: relative });
        if (response.operation !== "stat") {
          throw new RustSrcVfsError("Invalid", path);
        }
        return {
          type: response.stat.type === "file" ? FileType.File : FileType.Directory,
          size: response.stat.size,
          ctime: response.stat.mtime,
          mtime: response.stat.mtime,
        };
      }
      if (isRustSrcAncestor(path)) {
        try {
          return this.workspaceStat(path);
        } catch (error) {
          if (!(error instanceof WorkspaceFsError) || error.code !== "NotFound") throw error;
          return { type: FileType.Directory, size: 0, ctime: 0, mtime: 0 };
        }
      }
      return this.workspaceStat(path);
    } catch (error) {
      return mapError(error);
    }
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    try {
      const path = this.path(resource);
      const relative = rustSrcRelativePath(path);
      if (relative !== undefined) {
        const response = await this.rustSrcEndpoint(path)({
          operation: "readFile",
          path: relative,
        });
        if (response.operation !== "readFile") {
          throw new RustSrcVfsError("Invalid", path);
        }
        return response.data.slice();
      }
      return this.workspace.readFile(path).slice();
    } catch (error) {
      return mapError(error);
    }
  }

  async readdir(resource: URI): Promise<[string, ProviderFileType][]> {
    try {
      const path = this.path(resource);
      const relative = rustSrcRelativePath(path);
      if (relative !== undefined) {
        const endpoint = this.rustSrcEndpoint(path);
        const response = await endpoint({ operation: "readdir", path: relative });
        if (response.operation !== "readdir") {
          throw new RustSrcVfsError("Invalid", path);
        }
        return await Promise.all(response.entries.map(async (name) => {
          const childRelative = relative === "" ? name : `${relative}/${name}`;
          const child = await endpoint({ operation: "stat", path: childRelative });
          if (child.operation !== "stat") {
            throw new RustSrcVfsError("Invalid", `${path}/${name}`);
          }
          return [
            name,
            child.stat.type === "file" ? FileType.File : FileType.Directory,
          ] as [string, ProviderFileType];
        }));
      }
      if (isRustSrcAncestor(path)) return this.rustSrcAncestorEntries(path);
      return this.workspaceEntries(path);
    } catch (error) {
      return mapError(error);
    }
  }

  async writeFile(
    resource: URI,
    content: Uint8Array,
    options: IFileWriteOptions,
  ): Promise<void> {
    try {
      const path = this.path(resource);
      this.assertMutable(path);
      this.workspace.writeFile(path, content, {
        create: options.create,
        overwrite: options.overwrite,
        notify: true,
      });
    } catch (error) {
      mapError(error);
    }
  }

  async mkdir(resource: URI): Promise<void> {
    try {
      const path = this.path(resource);
      this.assertMutable(path);
      this.workspace.mkdir(path, true);
    } catch (error) {
      mapError(error);
    }
  }

  async delete(resource: URI, options: IFileDeleteOptions): Promise<void> {
    try {
      const path = this.path(resource);
      this.assertMutable(path);
      this.workspace.delete(path, options.recursive, true);
    } catch (error) {
      mapError(error);
    }
  }

  async rename(
    from: URI,
    to: URI,
    options: IFileOverwriteOptions,
  ): Promise<void> {
    try {
      const source = this.path(from);
      const destination = this.path(to);
      this.assertMutable(source);
      this.assertMutable(destination);
      this.workspace.rename(source, destination, options.overwrite, true);
    } catch (error) {
      mapError(error);
    }
  }

  watch(_resource: URI, _options: IWatchOptions): IDisposable {
    return { dispose() {} };
  }

  private rustSrcEndpoint(path: string) {
    const endpoint = getActiveRustSrcFsEndpoint();
    if (endpoint === undefined) throw new RustSrcVfsError("NotMounted", path);
    return endpoint;
  }

  private workspaceStat(path: string): IStat {
    const stat = this.workspace.stat(path);
    return {
      type: stat.type === "file" ? FileType.File : FileType.Directory,
      size: stat.size,
      ctime: stat.ctime,
      mtime: stat.mtime,
    };
  }

  private workspaceEntries(path: string): [string, ProviderFileType][] {
    return this.workspace.readdir(path).map((name) => {
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      return [
        name,
        this.workspace.stat(child).type === "file" ? FileType.File : FileType.Directory,
      ];
    });
  }

  private rustSrcAncestorEntries(path: string): [string, ProviderFileType][] {
    let entries: [string, ProviderFileType][] = [];
    try {
      entries = this.workspaceEntries(path);
    } catch (error) {
      if (!(error instanceof WorkspaceFsError) || error.code !== "NotFound") throw error;
    }
    const mountChild = rustSrcAncestorChild(path);
    if (mountChild !== undefined && !entries.some(([name]) => name === mountChild)) {
      entries.push([mountChild, FileType.Directory]);
    }
    return entries;
  }

  private assertMutable(path: string): void {
    if (touchesRustSrcNamespace(path)) throw new RustSrcVfsError("Invalid", path);
  }

  private path(resource: URI): string {
    if (resource.scheme !== "file" || resource.authority !== "") {
      throw new WorkspaceFsError("InvalidPath", resource.toString());
    }
    return resource.path;
  }

  private fileChange(change: WorkspaceChange): IFileChange {
    return {
      type: change.kind === "added"
        ? FileChangeType.ADDED
        : change.kind === "deleted"
        ? FileChangeType.DELETED
        : FileChangeType.UPDATED,
      resource: uriModule
        ? uriModule.URI.from({ scheme: "file", path: change.path })
        : { scheme: "file", authority: "", path: change.path } as URI,
    };
  }
}

type ProviderGlobal = typeof globalThis & {
  __rubrcWorkspaceFileProvider?: WasiWorkspaceFileProvider;
  __rubrcWorkspaceFileProviderRegistered?: boolean;
};

export function registerWorkspaceFileProvider(): WasiWorkspaceFileProvider {
  const state = globalThis as ProviderGlobal;
  const provider = state.__rubrcWorkspaceFileProvider ??=
    new WasiWorkspaceFileProvider(workspaceFileSystem);
  if (!state.__rubrcWorkspaceFileProviderRegistered) {
    if (!filesService) {
      throw new Error("Workspace file provider registration is unavailable");
    }
    filesService.registerCustomProvider("file", provider);
    state.__rubrcWorkspaceFileProviderRegistered = true;
  }
  return provider;
}
