/** @module Interface vfs:host/bridge **/

export class Downloader {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  static downloadFileStart(namePtr: number, nameLen: number): void;
  static downloadFileChunk(dataPtr: number, dataLen: number): void;
  static downloadFileEnd(): void;
  static sysrootStartFetch(triplePtr: number, tripleLen: number): void;
  static sysrootGetNextFileMeta(nameLenPtr: number, dataLenPtr: number): number;
  static sysrootReadFileName(namePtr: number): void;
  static sysrootReadFileChunk(dataPtr: number, chunkLen: number): void;
}
