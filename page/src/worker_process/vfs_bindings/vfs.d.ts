// world root:component/root
import type * as VfsHostBridge from './interfaces/vfs-host-bridge.js'; // vfs:host/bridge
import type * as Wasip1VfsHostVirtualFileSystemWasip1Core from './interfaces/wasip1-vfs-host-virtual-file-system-wasip1-core.js'; // wasip1-vfs:host/virtual-file-system-wasip1-core
import type * as Wasip1VfsHostVirtualFileSystemWasip1ThreadsImport from './interfaces/wasip1-vfs-host-virtual-file-system-wasip1-threads-import.js'; // wasip1-vfs:host/virtual-file-system-wasip1-threads-import
import type * as Wasip1VfsHostVirtualFileSystemWasip1ThreadsExport from './interfaces/wasip1-vfs-host-virtual-file-system-wasip1-threads-export.js'; // wasip1-vfs:host/virtual-file-system-wasip1-threads-export
export interface ImportObject {
  'vfs:host/bridge': typeof VfsHostBridge,
  'wasip1-vfs:host/virtual-file-system-wasip1-core': typeof Wasip1VfsHostVirtualFileSystemWasip1Core,
  'wasip1-vfs:host/virtual-file-system-wasip1-threads-import': typeof Wasip1VfsHostVirtualFileSystemWasip1ThreadsImport,
}
export interface Root {
  'wasip1-vfs:host/virtual-file-system-wasip1-threads-export': typeof Wasip1VfsHostVirtualFileSystemWasip1ThreadsExport,
  virtualFileSystemWasip1ThreadsExport: typeof Wasip1VfsHostVirtualFileSystemWasip1ThreadsExport,
  flushToVfs(): void,
  flushFromVfs(): void,
  inputChar(c: number): void,
  interrupt(): void,
  resize(columns: number, lines: number): void,
  init(): void,
  main(): void,
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

