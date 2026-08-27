export function mergeVersionedPublishDiagnostics<T extends object>(
  existing: T | undefined,
): T & {
  relatedInformation: true;
  versionSupport: true;
} {
  return {
    ...existing,
    relatedInformation: true,
    versionSupport: true,
  } as T & {
    relatedInformation: true;
    versionSupport: true;
  };
}
