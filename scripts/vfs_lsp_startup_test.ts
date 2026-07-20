Deno.test({
  name: "lsp_opt startup properly initializes WASI fd/stdin state",
  async fn() {
    const libSrc = await Deno.readTextFile("crates/vfs/src/lib.rs");
    const cmdSrc = await Deno.readTextFile("crates/vfs/src/command.rs");

    for (const [name, src] of [["lib.rs", libSrc], ["command.rs", cmdSrc]]) {
      if (src.includes("lsp_opt::_start()")) {
        throw new Error(`${name} incorrectly invokes lsp_opt::_start(), which fails to properly initialize persistent WASI environments.`);
      }

      // Check for sequential _reset followed by _main
      const initPattern = /lsp_opt::_reset\(\);\s*(?:crate::)?lsp_opt::_main\(\);/;
      if (!initPattern.test(src)) {
        throw new Error(`${name} does not call lsp_opt::_reset() immediately before lsp_opt::_main()`);
      }
    }
  }
});
