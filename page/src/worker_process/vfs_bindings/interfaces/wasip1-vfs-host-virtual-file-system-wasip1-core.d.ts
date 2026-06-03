/** @module Interface wasip1-vfs:host/virtual-file-system-wasip1-core **/

export class Wasip1 {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  static randomGetImport(bufPtr: number, bufLen: number): number;
  static schedYieldImport(): number;
  static clockTimeGetImport(id: number, precision: bigint, timestampPtr: number): number;
  static clockResGetImport(id: number, timestampPtr: number): number;
  static fdWriteImport(fd: number, iovsPtr: number, iovsLen: number, writtenPtr: number): number;
  static fdReadImport(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number;
}
