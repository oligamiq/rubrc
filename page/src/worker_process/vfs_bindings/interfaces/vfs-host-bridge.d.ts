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

export class Http {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  static requestStart(methodPtr: number, methodLen: number, urlPtr: number, urlLen: number, headersPtr: number, headersLen: number, bodyPtr: number, bodyLen: number, outRequestId: number, outStatus: number, outHeadersLen: number, outBodyLen: number, outErrorLen: number): number;
  static responseReadHeaders(requestId: number, dataPtr: number, dataLen: number): number;
  static responseReadBody(requestId: number, dataPtr: number, dataLen: number): number;
  static responseReadError(requestId: number, dataPtr: number, dataLen: number): number;
  static responseEnd(requestId: number): number;
}

export class Terminal {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  static terminalWrite(sessionId: number, dataPtr: number, dataLen: number): void;
}
