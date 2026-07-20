export type SysrootMetaResponse = {
  has_file: boolean | number;
  name_len?: number;
  data_len?: number;
};

export function sysrootMetaStatus(
  response: SysrootMetaResponse | null | undefined,
): number {
  if (!response) return 0;
  if (response.has_file === true) return 1;
  if (response.has_file === false) return 0;
  return response.has_file;
}
