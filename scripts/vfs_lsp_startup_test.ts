Deno.test({
  name: "lsp_opt startup properly initializes WASI fd/stdin state",
  async fn() {
    const libSrc = await Deno.readTextFile("crates/vfs/src/lib.rs");
    const cmdSrc = await Deno.readTextFile("crates/vfs/src/command.rs");

    for (const [name, src] of [["lib.rs", libSrc], ["command.rs", cmdSrc]]) {
      // Check for sequential _reset followed by _start followed by _main
      const initPattern =
        /lsp_opt::_reset\(\);\s*(?:crate::)?lsp_opt::_start\(\);\s*(?:crate::)?lsp_opt::_main\(\);/;
      if (!initPattern.test(src)) {
        throw new Error(
          `${name} does not call lsp_opt::_reset(), lsp_opt::_start(), and lsp_opt::_main() in exact sequential order`,
        );
      }
    }
  },
});
