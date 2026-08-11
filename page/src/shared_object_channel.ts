export function closeUnderlyingChannel(sharedObj: unknown) {
  const obj = sharedObj as { bc?: { close(): void } };
  obj?.bc?.close();
}
