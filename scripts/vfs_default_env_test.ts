const source = Deno.readTextFileSync(
  new URL("../crates/vfs/src/lib.rs", import.meta.url),
);
const uncommentedSource = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

Deno.test("WebShell Cargo defaults target the distributed wasm32-wasip1 sysroot", () => {
  const targetDefinition =
    /const\s+CARGO_BUILD_TARGET_ENV\s*:\s*&str\s*=\s*"CARGO_BUILD_TARGET=wasm32-wasip1"\s*;/;
  if (!targetDefinition.test(uncommentedSource)) {
    throw new Error("missing shared wasm32-wasip1 Cargo target definition");
  }

  const dynamicDefaults = uncommentedSource.match(
    /VIRTUAL_SHELL_ENV[\s\S]*?env: vec!\[([\s\S]*?)\][\s\S]*?\}\);/,
  )?.[1];
  if (!dynamicDefaults || !/\bCARGO_BUILD_TARGET_ENV\b/.test(dynamicDefaults)) {
    throw new Error("VIRTUAL_SHELL_ENV must include the shared Cargo target");
  }

  const embeddedDefaults = uncommentedSource.match(
    /const VIRTUAL_ENV[\s\S]*?environ: &\[([\s\S]*?)\],\s*\};/,
  )?.[1];
  if (
    !embeddedDefaults || !/\bCARGO_BUILD_TARGET_ENV\b/.test(embeddedDefaults)
  ) {
    throw new Error(
      "plug filesystem environ defaults must include the shared Cargo target",
    );
  }
});
