export type SysrootArchiveMetaResponse = {
  has_archive: boolean | number;
  data_len?: number;
};

export function sysrootArchiveMetaStatus(
  response: SysrootArchiveMetaResponse | null | undefined,
): number {
  if (!response) return 0;
  if (response.has_archive === true) return 1;
  if (response.has_archive === false) return 0;
  return response.has_archive;
}

export function validateSysrootChunkLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `invalid sysroot chunk length ${String(
        value,
      )}; expected a non-negative safe integer`,
    );
  }
  return value;
}

export function takeExactSysrootChunk(
  data: Uint8Array,
  requestedLength: unknown,
): { chunk: Uint8Array; remaining: Uint8Array } {
  const length = validateSysrootChunkLength(requestedLength);
  if (data.length < length) {
    throw new Error(
      `sysroot chunk requested ${length} bytes with only ${data.length} available`,
    );
  }
  return {
    chunk: data.subarray(0, length),
    remaining: length === 0 ? data : data.subarray(length),
  };
}

export function validateExactSysrootChunk(
  data: Uint8Array,
  requestedLength: unknown,
): Uint8Array {
  const length = validateSysrootChunkLength(requestedLength);
  if (data.byteLength !== length) {
    throw new Error(
      `sysroot chunk returned ${data.byteLength} bytes for a ${length}-byte request`,
    );
  }
  return data;
}
