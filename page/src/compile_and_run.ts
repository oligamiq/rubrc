export type InputStringEndpoint = (args: {
  sessionId: number;
  data: string;
}) => Promise<void>;

export type TerminalWriteEndpoint = (args: {
  sessionId: number;
  data: Uint8Array;
}) => Promise<void>;

export interface RuntimeCommandAdapter {
  run(triple?: string): Promise<void>;
  download(file: string): Promise<void>;
}

export const compile_and_run = (
  service: RuntimeCommandAdapter,
  triple?: string,
): Promise<void> => service.run(triple);

export const download = (
  service: RuntimeCommandAdapter,
  file: string,
): Promise<void> => service.download(file);

export const commandText = (args: readonly string[]): string =>
  `${args.join(" ")}\r`;

export const cargoRunArgs = (triple?: string): readonly string[] =>
  triple === undefined
    ? ["cargo", "run"]
    : ["cargo", "run", "--target", triple];

export const downloadArgs = (file: string): readonly string[] => [
  "download",
  file,
];

export const notReadyOutput = (): Uint8Array =>
  new TextEncoder().encode("this is not done yet\r\n");
