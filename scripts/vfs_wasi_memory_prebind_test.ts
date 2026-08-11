const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("prebindWasiMemory binds the exact memory without starting execution", async () => {
  const helperUrl = new URL(
    "../page/src/worker_process/prebind_wasi_memory.ts",
    import.meta.url,
  );
  let helper: {
    prebindWasiMemory: (
      animal: {
        initialize_only(instance: {
          exports: { memory: WebAssembly.Memory };
        }): void;
      },
      memory: WebAssembly.Memory,
    ) => void;
  };
  try {
    helper = await import(helperUrl.href);
  } catch (error) {
    throw new Error(`prebind helper is missing: ${error}`);
  }

  const memory = new WebAssembly.Memory({ initial: 1 });
  let initializedWith:
    | { exports: { memory: WebAssembly.Memory } }
    | undefined;
  let currentInstance:
    | { exports: { memory: WebAssembly.Memory } }
    | undefined;
  let initializeCalls = 0;
  let startCalls = 0;
  const animal = {
    initialize_only(instance: {
      exports: { memory: WebAssembly.Memory };
    }) {
      initializeCalls += 1;
      initializedWith = instance;
      currentInstance = instance;
    },
    start(instance: { exports: { memory: WebAssembly.Memory } }) {
      startCalls += 1;
      currentInstance = instance;
    },
  };

  helper.prebindWasiMemory(animal, memory);

  assert(initializeCalls === 1, "animal was not initialized exactly once");
  assert(
    initializedWith?.exports.memory === memory,
    "helper did not bind the exact shared core memory",
  );
  assert(
    Object.keys(initializedWith?.exports ?? {}).join(",") === "memory",
    "prebind stub exposes more than the shared core memory",
  );
  assert(startCalls === 0, "prebind started Wasm execution");

  const root = { exports: { memory } };
  animal.start(root);
  assert(startCalls === 1, "normal start was not called exactly once");
  assert(currentInstance === root, "normal start did not replace the stub");
});

Deno.test("the browser VFS caller prebinds memory before custom_instantiate", async () => {
  const callers = [
    "page/src/worker_process/util_cmd.ts",
  ];
  const rootDir = new URL("../", import.meta.url);

  for (const path of callers) {
    const source = await Deno.readTextFile(new URL(path, rootDir));
    const helperImports = [...source.matchAll(
      /import\s*\{\s*prebindWasiMemory\s*\}\s*from\s*["'][^"']+["']\s*;/g,
    )];
    const binds = [...source.matchAll(
      /prebindWasiMemory\s*\(\s*animal\s*,\s*sharedMemory\s*\.\s*memory\s*\)\s*;/g,
    )];
    const instantiations = [...source.matchAll(
      /const\s+\w+\s*=\s*await\s+custom_instantiate\s*\(/g,
    )];
    const starts = [...source.matchAll(
      /animal\s*\.\s*start\s*\(\s*\w+(?:\s+as\s+any)?\s*\)\s*;/g,
    )];

    assert(helperImports.length === 1, `${path} must import the helper once`);
    assert(binds.length === 1, `${path} must prebind shared memory once`);
    assert(
      instantiations.length === 1,
      `${path} must instantiate the VFS core once`,
    );
    assert(starts.length === 1, `${path} must start the animal once`);
    assert(
      binds[0].index! < instantiations[0].index!,
      `${path} does not prebind before custom_instantiate`,
    );
    assert(
      instantiations[0].index! < starts[0].index!,
      `${path} does not replace the stub with animal.start afterward`,
    );
  }
});
