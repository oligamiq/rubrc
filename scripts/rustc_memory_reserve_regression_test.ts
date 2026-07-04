function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

Deno.test({
  name: "repeated rustc shell runs do not repeatedly exhaust rustc memory reserve",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "scripts/debug_rustc_shell_thread_spawn.ts"],
      env: {
        ...Deno.env.toObject(),
        VFS_DEBUG_SKIP_MEMORY_RESERVE: "1",
        VFS_DEBUG_THREADS: "8",
        VFS_DEBUG_RUNS: "10",
        VFS_DEBUG_TIMEOUT_MS: "90000",
      },
      stdout: "piped",
      stderr: "piped",
    });

    const result = await command.output();
    const output = `${new TextDecoder().decode(result.stdout)}\n${
      new TextDecoder().decode(result.stderr)
    }`;

    if (!result.success) {
      throw new Error(`debug harness failed with status ${result.code}\n${output}`);
    }

    const linkerCount = countMatches(output, /Linking using/g);
    if (linkerCount !== 10) {
      throw new Error(`expected 10 rustc linker runs, got ${linkerCount}\n${output}`);
    }

    if (output.includes("[memory] failed to reserve")) {
      throw new Error(`unexpected memory reserve warning\n${output}`);
    }
  },
});
