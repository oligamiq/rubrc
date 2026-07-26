import {
  Directory,
  File,
  type Inode,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { default_value } from "./config.ts";

export type WorkspaceChange = {
  kind: "added" | "updated" | "deleted";
  path: string;
};

export class WorkspaceFsError extends Error {
  constructor(
    readonly code:
      | "InvalidPath"
      | "NotFound"
      | "Exists"
      | "NotDirectory"
      | "IsDirectory"
      | "NotEmpty",
    path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

export type WorkspaceWriteOptions = {
  create: boolean;
  overwrite: boolean;
  notify: boolean;
};
type Metadata = { ctime: number; mtime: number };

const bytes = (text: string) => new TextEncoder().encode(text);

export class WorkspaceFileSystem {
  readonly rootContents: Map<string, Inode>;
  readonly rootDirectory: Directory;
  readonly sysrootContents = new Map<string, Inode>();
  readonly preopen: PreopenDirectory;
  private readonly listeners = new Set<(change: WorkspaceChange) => void>();
  private readonly metadata = new WeakMap<Inode, Metadata>();

  constructor(mainSource: string) {
    const src = new Directory(
      new Map([["main.rs", new File(bytes(mainSource))]]),
    );
    this.rootContents = new Map<string, Inode>([
      ["sysroot", new Directory(this.sysrootContents)],
      ["src", src],
      [
        "Cargo.toml",
        new File(
          bytes(
            `[package]\nname = "main"\nversion = "0.1.0"\nedition = "2021"\n`,
          ),
        ),
      ],
      [
        ".cargo",
        new Directory(new Map([["config.toml", new File(new Uint8Array())]])),
      ],
      [
        "rust-project.json",
        new File(bytes(JSON.stringify({
          sysroot_src: "/sysroot/lib/rustlib/src/rust/library",
          crates: [{ root_module: "/src/main.rs", edition: "2021", deps: [] }],
        }))),
      ],
    ]);
    this.preopen = new PreopenDirectory("/", this.rootContents);
    this.rootDirectory = this.preopen.dir;
  }

  onDidChange(
    listener: (change: WorkspaceChange) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  lookup(path: string): Inode {
    let inode: Inode = this.rootDirectory;
    for (const part of this.parts(path)) {
      if (!(inode instanceof Directory)) {
        throw new WorkspaceFsError("NotDirectory", path);
      }
      const next = inode.contents.get(part);
      if (!next) throw new WorkspaceFsError("NotFound", path);
      inode = next;
    }
    return inode;
  }

  stat(
    path: string,
  ): {
    type: "file" | "directory";
    size: number;
    ctime: number;
    mtime: number;
  } {
    const inode = this.lookup(path);
    const now = Date.now();
    const metadata = this.metadata.get(inode) ?? { ctime: now, mtime: now };
    this.metadata.set(inode, metadata);
    return {
      type: inode instanceof Directory ? "directory" : "file",
      size: inode instanceof File ? inode.data.byteLength : 0,
      ...metadata,
    };
  }

  readFile(path: string): Uint8Array {
    const inode = this.lookup(path);
    if (!(inode instanceof File)) {
      throw new WorkspaceFsError("IsDirectory", path);
    }
    return inode.data;
  }

  readdir(path: string): string[] {
    const inode = this.lookup(path);
    if (!(inode instanceof Directory)) {
      throw new WorkspaceFsError("NotDirectory", path);
    }
    return [...inode.contents.keys()];
  }

  writeFile(
    path: string,
    content: Uint8Array,
    options: WorkspaceWriteOptions,
  ): void {
    const { parent, name } = this.parent(path);
    const current = parent.contents.get(name);
    if (!current && !options.create) {
      throw new WorkspaceFsError("NotFound", path);
    }
    if (current && !options.overwrite) {
      throw new WorkspaceFsError("Exists", path);
    }
    if (current instanceof Directory) {
      throw new WorkspaceFsError("IsDirectory", path);
    }
    const file = current instanceof File ? current : new File(new Uint8Array());
    file.data = content.slice();
    parent.contents.set(name, file);
    const old = this.metadata.get(file);
    this.metadata.set(file, {
      ctime: old?.ctime ?? Date.now(),
      mtime: Date.now(),
    });
    if (options.notify) {
      this.emit({ kind: current ? "updated" : "added", path });
    }
  }

  mkdir(path: string, notify: boolean): void {
    const { parent, name } = this.parent(path);
    if (parent.contents.has(name)) throw new WorkspaceFsError("Exists", path);
    parent.contents.set(name, new Directory(new Map()));
    if (notify) this.emit({ kind: "added", path });
  }

  delete(path: string, recursive: boolean, notify: boolean): void {
    const { parent, name } = this.parent(path);
    const inode = parent.contents.get(name);
    if (!inode) throw new WorkspaceFsError("NotFound", path);
    if (inode instanceof Directory && inode.contents.size > 0 && !recursive) {
      throw new WorkspaceFsError("NotEmpty", path);
    }
    parent.contents.delete(name);
    if (notify) this.emit({ kind: "deleted", path });
  }

  rename(from: string, to: string, overwrite: boolean, notify: boolean): void {
    const sourcePath = `/${this.parts(from).join("/")}`;
    const destinationPath = `/${this.parts(to).join("/")}`;
    if (sourcePath === "/" || destinationPath === "/") {
      throw new WorkspaceFsError("InvalidPath", sourcePath === "/" ? from : to);
    }
    if (sourcePath === destinationPath) return;
    if (destinationPath.startsWith(`${sourcePath}/`)) {
      throw new WorkspaceFsError("InvalidPath", to);
    }
    const source = this.parent(sourcePath);
    const inode = source.parent.contents.get(source.name);
    if (!inode) throw new WorkspaceFsError("NotFound", sourcePath);
    const destination = this.parent(destinationPath);
    const existing = destination.parent.contents.get(destination.name);
    if (existing && !overwrite) {
      throw new WorkspaceFsError("Exists", destinationPath);
    }
    if (existing instanceof Directory && !(inode instanceof Directory)) {
      throw new WorkspaceFsError("IsDirectory", destinationPath);
    }
    if (
      existing && !(existing instanceof Directory) && inode instanceof Directory
    ) {
      throw new WorkspaceFsError("NotDirectory", destinationPath);
    }
    if (existing instanceof Directory && existing.contents.size > 0) {
      throw new WorkspaceFsError("NotEmpty", destinationPath);
    }
    destination.parent.contents.set(destination.name, inode);
    source.parent.contents.delete(source.name);
    if (notify) {
      this.emit({ kind: "deleted", path: sourcePath });
      this.emit({ kind: "added", path: destinationPath });
    }
  }

  private parts(path: string): string[] {
    if (
      !path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      /^\/[A-Za-z]:\//.test(path)
    ) {
      throw new WorkspaceFsError("InvalidPath", path);
    }
    const parts = path.split("/").filter(Boolean);
    if (parts.includes("..")) throw new WorkspaceFsError("InvalidPath", path);
    return parts.filter((part) => part !== ".");
  }

  private parent(path: string): { parent: Directory; name: string } {
    const parts = this.parts(path);
    const name = parts.pop();
    if (!name) throw new WorkspaceFsError("InvalidPath", path);
    let parent = this.rootDirectory;
    for (const part of parts) {
      const inode = parent.contents.get(part);
      if (!(inode instanceof Directory)) {
        throw new WorkspaceFsError(inode ? "NotDirectory" : "NotFound", path);
      }
      parent = inode;
    }
    return { parent, name };
  }

  private emit(change: WorkspaceChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

type WorkspaceGlobal = typeof globalThis & {
  __rubrcWorkspaceFileSystem?: WorkspaceFileSystem;
};
const workspaceGlobal = globalThis as WorkspaceGlobal;
export const workspaceFileSystem = workspaceGlobal
  .__rubrcWorkspaceFileSystem ??= new WorkspaceFileSystem(default_value);
