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

const mapError = (error: unknown): never => {
  if (!(error instanceof WorkspaceFsError)) throw error;
  const code = error.code === "NotFound"
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
    throw filesService.FileSystemProviderError.create(
      error.message,
      code as ProviderErrorCode,
    );
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
      const stat = this.workspace.stat(this.path(resource));
      return {
        type: stat.type === "file" ? FileType.File : FileType.Directory,
        size: stat.size,
        ctime: stat.ctime,
        mtime: stat.mtime,
      };
    } catch (error) {
      return mapError(error);
    }
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    try {
      return this.workspace.readFile(this.path(resource));
    } catch (error) {
      return mapError(error);
    }
  }

  async readdir(resource: URI): Promise<[string, ProviderFileType][]> {
    try {
      const path = this.path(resource);
      return this.workspace.readdir(path).map((name) => {
        const child = path === "/" ? `/${name}` : `${path}/${name}`;
        return [
          name,
          this.workspace.stat(child).type === "file"
            ? FileType.File
            : FileType.Directory,
        ];
      });
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
      this.workspace.writeFile(this.path(resource), content, {
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
      this.workspace.mkdir(this.path(resource), true);
    } catch (error) {
      mapError(error);
    }
  }

  async delete(resource: URI, options: IFileDeleteOptions): Promise<void> {
    try {
      this.workspace.delete(this.path(resource), options.recursive, true);
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
      this.workspace.rename(
        this.path(from),
        this.path(to),
        options.overwrite,
        true,
      );
    } catch (error) {
      mapError(error);
    }
  }

  watch(_resource: URI, _options: IWatchOptions): IDisposable {
    return { dispose() {} };
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
