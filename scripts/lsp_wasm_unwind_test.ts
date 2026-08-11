function readUleb(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;

  while (offset < bytes.length && shift <= 28) {
    const byte = bytes[offset++];
    if (shift === 28 && (byte & 0xf0) !== 0) {
      throw new Error("target_features unsigned LEB128 value exceeds u32");
    }
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }

  throw new Error("invalid target_features unsigned LEB128 value");
}

function enabledTargetFeatures(sections: ArrayBuffer[]): string[] {
  const decoder = new TextDecoder();
  const enabled: string[] = [];

  for (const section of sections) {
    const bytes = new Uint8Array(section);
    let offset = 0;
    let count;
    [count, offset] = readUleb(bytes, offset);

    for (let index = 0; index < count; index++) {
      if (offset >= bytes.length) {
        throw new Error("truncated target_features prefix");
      }
      const prefix = bytes[offset++];
      let nameLength;
      [nameLength, offset] = readUleb(bytes, offset);
      const end = offset + nameLength;
      if (end > bytes.length) {
        throw new Error("truncated target_features name");
      }
      const name = decoder.decode(bytes.subarray(offset, end));
      offset = end;
      if (prefix === "+".charCodeAt(0)) enabled.push(name);
    }

    if (offset !== bytes.length) {
      throw new Error("unexpected trailing target_features data");
    }
  }

  return enabled;
}

Deno.test(
  "rust-analyzer salsa cancellation requires unwind in the embedded LSP Wasm",
  async () => {
    const bytes = await Deno.readFile(
      new URL("../crates/vfs/lsp_opt.wasm", import.meta.url),
    );
    const module = await WebAssembly.compile(bytes);

    const cppExceptionImport = WebAssembly.Module.imports(module).find(
      ({ module, name }) => module === "env" && name === "__cpp_exception",
    );
    if (cppExceptionImport) {
      throw new Error(
        "embedded LSP Wasm must not import env::__cpp_exception",
      );
    }

    const targetFeatureSections = WebAssembly.Module.customSections(
      module,
      "target_features",
    );
    if (targetFeatureSections.length !== 1) {
      throw new Error(
        `embedded LSP Wasm must contain exactly one target_features section, found ${targetFeatureSections.length}`,
      );
    }
    const features = enabledTargetFeatures(targetFeatureSections);
    if (!features.includes("exception-handling")) {
      throw new Error(
        "rust-analyzer salsa cancellation requires unwind: target_features must enable exception-handling",
      );
    }
  },
);
