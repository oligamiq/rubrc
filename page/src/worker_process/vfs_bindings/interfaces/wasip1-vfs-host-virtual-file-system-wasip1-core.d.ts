/** @module Interface wasip1-vfs:host/virtual-file-system-wasip1-core **/

export class Wasip1 {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  static environSizesGetImport(environCountPtr: number, environSizePtr: number): number;
  static environGetImport(environPtrPtr: number, environBufPtr: number): number;
  static procExitImport(code: number): void;
  static randomGetImport(bufPtr: number, bufLen: number): number;
  static schedYieldImport(): number;
  static clockTimeGetImport(id: number, precision: bigint, timestampPtr: number): number;
  static clockResGetImport(id: number, timestampPtr: number): number;
  static fdFdstatGetImport(fd: number, fdstatPtr: number): number;
  static fdWriteImport(fd: number, iovsPtr: number, iovsLen: number, writtenPtr: number): number;
  static fdReaddirImport(fd: number, bufPtr: number, bufLen: number, cookie: bigint, bufUsedPtr: number): number;
  static fdCloseImport(fd: number): number;
  static fdPrestatGetImport(fd: number, prestatPtr: number): number;
  static fdPrestatDirNameImport(fd: number, pathPtr: number, pathLen: number): number;
  static fdFilestatGetImport(fd: number, filestatPtr: number): number;
  static fdReadImport(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number;
  static pathOpenImport(fd: number, dirflags: number, pathPtr: number, pathLen: number, oflags: number, fsRightsBase: bigint, fsRightsInheriting: bigint, fdflags: number, fdOutPtr: number): number;
  static pathCreateDirectoryImport(fd: number, pathPtr: number, pathLen: number): number;
  static pathFilestatGetImport(fd: number, lookupflags: number, pathPtr: number, pathLen: number, filestatPtr: number): number;
  static pathRemoveDirectoryImport(fd: number, pathPtr: number, pathLen: number): number;
  static pathUnlinkFileImport(fd: number, pathPtr: number, pathLen: number): number;
}
