export type RustLspStartupActions = {
  prepopulateMain(): Promise<void>;
  startClient(): Promise<void>;
  createMainModel(): void;
};

export async function runRustLspStartup(
  actions: RustLspStartupActions,
  timeoutMs: number,
): Promise<void> {
  await actions.prepopulateMain();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const startupTimeout = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("rust-analyzer startup timed out")),
      timeoutMs,
    );
  });

  try {
    await Promise.race([actions.startClient(), startupTimeout]);
    actions.createMainModel();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
