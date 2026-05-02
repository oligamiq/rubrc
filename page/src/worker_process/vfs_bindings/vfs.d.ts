// world root:component/root
export interface FileEntry {
  path: string,
  content: Uint8Array,
}
export type CommandRequest = CommandRequestHandled | CommandRequestDownload | CommandRequestExecFile | CommandRequestNotFound;
export interface CommandRequestHandled {
  tag: 'handled',
}
export interface CommandRequestDownload {
  tag: 'download',
  val: string,
}
export interface CommandRequestExecFile {
  tag: 'exec-file',
  val: [string, Array<string>],
}
export interface CommandRequestNotFound {
  tag: 'not-found',
  val: string,
}
import type * as Wasip1VfsHostVirtualFileSystemWasip1Core from './interfaces/wasip1-vfs-host-virtual-file-system-wasip1-core.js'; // wasip1-vfs:host/virtual-file-system-wasip1-core
export interface ImportObject {
  'wasip1-vfs:host/virtual-file-system-wasip1-core': typeof Wasip1VfsHostVirtualFileSystemWasip1Core,
}
export interface Root {
  flushToVfs(files: Array<FileEntry>): void,
  flushFromVfs(): Array<FileEntry>,
  runCommand(args: Array<string>): CommandRequest,
  readFromVfs(path: string): Uint8Array,
  init(): void,
  main(): void,
  export type Result<T, E> = { tag: 'ok', val: T } | { tag: 'err', val: E };
}

/**
* Instantiates this component with the provided imports and
* returns a map of all the exports of the component.
*
* This function is intended to be similar to the
* `WebAssembly.Instantiate` constructor. The second `imports`
* argument is the "import object" for wasm, except here it
* uses component-model-layer types instead of core wasm
* integers/numbers/etc.
*
* The first argument to this function, `getCoreModule`, is
* used to compile core wasm modules within the component.
* Components are composed of core wasm modules and this callback
* will be invoked per core wasm module. The caller of this
* function is responsible for reading the core wasm module
* identified by `path` and returning its compiled
* `WebAssembly.Module` object. This would use the
* `WebAssembly.Module` constructor on the web, for example.
*/
export function instantiate(
getCoreModule: (path: string) => WebAssembly.Module,
imports: ImportObject,
instantiateCore?: (module: WebAssembly.Module, imports: Record<string, any>) => WebAssembly.Instance
): Root;
export function instantiate(
getCoreModule: (path: string) => WebAssembly.Module | Promise<WebAssembly.Module>,
imports: ImportObject,
instantiateCore?: (module: WebAssembly.Module, imports: Record<string, any>) => WebAssembly.Instance | Promise<WebAssembly.Instance>
): Root | Promise<Root>;

