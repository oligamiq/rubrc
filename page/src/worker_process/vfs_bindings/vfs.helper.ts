/**
 * Minimal Helper for vfs
 * 
 * No VFS exports detected. Provide your own module loading/coordination.
 */

export async function loadVfsModule(wasmPath: string): Promise<WebAssembly.Instance> {
  const response = await fetch(wasmPath);
  const buffer = await response.arrayBuffer();
  const module = await WebAssembly.instantiate(buffer);
  return module.instance;
}
