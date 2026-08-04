const rustAnalyzerRoot = "/tmp/opencode/rust-analyzer-metadata-trace";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function enumDiscriminants(
  source: string,
  enumName: string,
): Map<string, number> {
  const match = source.match(
    new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`),
  );
  assert(match, `${enumName} is missing`);
  return new Map(
    Array.from(
      match[1].matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\d+)/g),
      (entry) => [entry[1], Number(entry[2])],
    ),
  );
}

function maskSourceTrivia(source: string): string {
  const masked = source.split("");
  const blank = (index: number) => {
    if (masked[index] !== "\n") masked[index] = " ";
  };

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      let depth = 1;
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        blank(index);
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (source[index] === '"') {
      blank(index);
      index += 1;
      while (index < source.length) {
        blank(index);
        if (source[index] === "\\") {
          index += 1;
          if (index < source.length) blank(index);
        } else if (source[index] === '"') {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (
      source[index] === "'" &&
      (source[index + 2] === "'" ||
        (source[index + 1] === "\\" && source[index + 3] === "'"))
    ) {
      const end = source[index + 1] === "\\" ? index + 3 : index + 2;
      while (index <= end) {
        blank(index);
        index += 1;
      }
      index -= 1;
    }
  }
  return masked.join("");
}

function functionSource(source: string, signature: string): string {
  const code = maskSourceTrivia(source);
  const start = code.indexOf(signature);
  assert(start >= 0, `${signature} is missing`);
  const bodyStart = code.indexOf("{", start);
  assert(bodyStart >= 0, `${signature} has no body`);
  let depth = 0;
  for (let index = bodyStart; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${signature} has an unterminated body`);
}

function assertInOrder(source: string, needles: string[], scope: string): void {
  let position = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, position + 1);
    assert(next > position, `${scope} is missing ordered marker ${needle}`);
    position = next + needle.length - 1;
  }
}

function directTraceArguments(source: string): string[] {
  const calls: string[] = [];
  const code = maskSourceTrivia(source);
  const pattern = /(?<![A-Za-z0-9_])(?<!fn )trace_boundary\s*\(/g;
  for (const match of code.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    for (let index = start; index < code.length; index += 1) {
      if (code[index] === "(") depth += 1;
      if (code[index] === ")") depth -= 1;
      if (depth === 0) {
        calls.push(code.slice(start, index));
        break;
      }
    }
  }
  return calls;
}

function assertTraceStageCount(
  source: string,
  stage: string,
  count: number,
): void {
  const actual =
    directTraceArguments(source).filter((argumentsSource) =>
      argumentsSource.includes(`WasiBoundaryStage::${stage}`)
    ).length;
  assert(
    actual === count,
    `expected ${count} ${stage} traces, received ${actual}`,
  );
}

function assertTraceArguments(
  source: string,
  expected: string,
  scope: string,
): void {
  const normalize = (value: string) =>
    value.replaceAll(/\s+/g, " ").replace(/,\s*$/, "").trim();
  const expectedNormalized = normalize(expected);
  assert(
    directTraceArguments(source).some((actual) =>
      normalize(actual) === expectedNormalized
    ),
    `${scope} is missing trace arguments ${expectedNormalized}`,
  );
}

function assertInlineJoinPropagation(
  loadInline: string,
  handles: string[],
): void {
  const scope = functionSource(loadInline, "let join = thread::scope");
  const scopeCode = maskSourceTrivia(scope);
  let previousJoin = -1;
  for (const handle of handles) {
    const marker = `let ${handle} = {`;
    const joinPosition = scopeCode.search(
      new RegExp(`\\blet\\s+${handle}\\s*=\\s*\\{`),
    );
    assert(
      joinPosition > previousJoin,
      `inline joins are not globally ordered at ${handle}`,
    );
    previousJoin = joinPosition;

    const joinBlock = functionSource(scope, marker);
    const joinMatch = functionSource(joinBlock, `match ${handle}.join()`);
    const joinMatchCode = maskSourceTrivia(joinMatch);
    const errorMarker = "Err(error) =>";
    const errorStart = joinMatchCode.indexOf(errorMarker);
    assert(errorStart >= 0, `${handle} join has no Err(error) arm`);
    assert(
      /^\s*{/.test(joinMatchCode.slice(errorStart + errorMarker.length)),
      `${handle} join error arm is not an immediate braced block`,
    );
    const errorArm = functionSource(joinMatch, "Err(error) =>");
    const errorArmCode = maskSourceTrivia(errorArm);
    const errorBody = errorArmCode.slice(errorArmCode.indexOf("{") + 1, -1);
    assert(
      /return\s+Err\(error\);?\s*$/.test(errorBody),
      `${handle} join error does not immediately return Err(error)`,
    );
  }

  const outerJoinMatch = functionSource(loadInline, "match join");
  const panicArm = maskSourceTrivia(outerJoinMatch).match(
    /\bErr\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*=>\s*std::panic::resume_unwind\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
  );
  assert(
    panicArm !== null && panicArm[1] === panicArm[2],
    "thread::scope panic result no longer resumes the original unwind",
  );
}

function assertRejects(run: () => void, message: string): void {
  try {
    run();
  } catch {
    return;
  }
  throw new Error(message);
}

function assertPayloadFreeTraceCalls(source: string, path: string): void {
  for (const argumentsSource of directTraceArguments(source)) {
    for (
      const forbidden of ["args", "envs", "stdout", "stderr", "json", "req_str"]
    ) {
      assert(
        !argumentsSource.toLowerCase().includes(forbidden),
        `${path} boundary call includes forbidden payload ${forbidden}`,
      );
    }
  }
}

function assertDirectCallsAreWasiGated(source: string, path: string): void {
  const lines = source.split("\n");
  const codeLines = maskSourceTrivia(source).split("\n");
  for (let index = 0; index < codeLines.length; index += 1) {
    if (!codeLines[index].includes("trace_boundary(")) continue;
    let previous = index - 1;
    while (previous >= 0 && codeLines[previous].trim() === "") previous -= 1;
    assert(
      previous >= 0 && lines[previous].trim() === '#[cfg(target_os = "wasi")]',
      `${path}:${index + 1} boundary call is not directly WASI-gated`,
    );
  }
}

Deno.test("rust-analyzer emits correlated payload-free WASI boundary stages", async () => {
  const [wasiCargo, cargoWorkspace, workspace, vfs] = await Promise.all([
    Deno.readTextFile(`${rustAnalyzerRoot}/crates/toolchain/src/wasi_cargo.rs`),
    Deno.readTextFile(
      `${rustAnalyzerRoot}/crates/project-model/src/cargo_workspace.rs`,
    ),
    Deno.readTextFile(
      `${rustAnalyzerRoot}/crates/project-model/src/workspace.rs`,
    ),
    Deno.readTextFile("crates/vfs/src/lib.rs"),
  ]);

  const expectedStages = new Map([
    ["FfiEnter", 1],
    ["FfiReturn", 2],
    ["BuffersBorrowed", 3],
    ["BuffersCopyEnter", 4],
    ["BuffersCopied", 5],
    ["BuffersFreeEnter", 6],
    ["BuffersFreed", 7],
    ["InvokeReturn", 8],
    ["MetadataInvokeEnter", 9],
    ["MetadataInvokeReturn", 10],
    ["MetadataUtf8Enter", 11],
    ["MetadataUtf8Return", 12],
    ["MetadataParseEnter", 13],
    ["MetadataParseReturn", 14],
    ["MetadataFinished", 15],
    ["WorkspaceCargoSpawnEnter", 16],
    ["WorkspaceCargoSpawnReturn", 17],
    ["WorkspaceCargoJoinEnter", 18],
    ["WorkspaceCargoJoinReturn", 19],
    ["WorkspaceCargoJoinError", 20],
    ["WorkspaceCargoMapReturn", 21],
    ["WorkspaceLoadReturn", 22],
    ["ScopeUnwind", 23],
    ["WorkspaceInlineTaskEnter", 24],
    ["WorkspaceInlineTaskReturn", 25],
    ["WorkspaceInlineJoinEnter", 26],
    ["WorkspaceInlineJoinReturn", 27],
    ["WorkspaceInlineJoinError", 28],
    ["WorkspaceInlineLoadReturn", 29],
  ]);
  const raStages = enumDiscriminants(wasiCargo, "WasiBoundaryStage");
  const hostStages = enumDiscriminants(vfs, "RaBoundaryStage");
  assert(raStages.size === 29, `rust-analyzer has ${raStages.size} stages`);
  assert(hostStages.size === 29, `VFS has ${hostStages.size} stages`);
  for (const [name, value] of expectedStages) {
    assert(
      raStages.get(name) === value,
      `rust-analyzer ${name} must be ${value}`,
    );
    assert(hostStages.get(name) === value, `VFS ${name} must be ${value}`);
  }

  assert(
    /#\[link\(wasm_import_module\s*=\s*"__wasip1_vfs-host"\)\][\s\S]*?unsafe extern "C"[\s\S]*?fn host_trace_boundary\(\s*trace_id: u32,\s*stage: u32,\s*value_1: u32,\s*value_2: u32,?\s*\) -> u32;/m
      .test(wasiCargo),
    "host_trace_boundary is not explicitly imported from __wasip1_vfs-host",
  );
  assert(
    /struct CargoRequest\s*\{[\s\S]*?trace_id:\s*u32,/.test(wasiCargo),
    "CargoRequest omits trace_id",
  );
  assert(
    /pub fn invoke_cargo\(cmd: &Command\)[\s\S]*?next_trace_id\(\)[\s\S]*?invoke_cargo_with_trace_id\(cmd, trace_id\)/
      .test(
        wasiCargo,
      ),
    "invoke_cargo is not a trace-ID compatibility wrapper",
  );
  assert(
    wasiCargo.includes("pub fn invoke_cargo_with_trace_id("),
    "invoke_cargo_with_trace_id is missing",
  );
  assert(
    wasiCargo.includes("u32::try_from(len).unwrap_or(u32::MAX)"),
    "observed lengths do not use checked u32 saturation",
  );

  const invoke = functionSource(
    wasiCargo,
    "pub fn invoke_cargo_with_trace_id(",
  );
  assertInOrder(
    invoke,
    [
      "WasiBoundaryStage::FfiEnter",
      "host_run_cargo(",
      "WasiBoundaryStage::FfiReturn",
      "if res != 0",
      "WasiBoundaryStage::BuffersBorrowed",
      "WasiBoundaryStage::BuffersCopyEnter",
      ".to_vec()",
      "WasiBoundaryStage::BuffersCopied",
      "WasiBoundaryStage::BuffersFreeEnter",
      "host_free_memory(",
      "WasiBoundaryStage::BuffersFreed",
      "WasiBoundaryStage::BuffersCopyEnter",
      ".to_vec()",
      "WasiBoundaryStage::BuffersCopied",
      "WasiBoundaryStage::BuffersFreeEnter",
      "host_free_memory(",
      "WasiBoundaryStage::BuffersFreed",
      "WasiBoundaryStage::InvokeReturn",
      "ffi_scope.complete()",
      "Ok(WasiCargoOutput",
    ],
    "invoke_cargo_with_trace_id",
  );
  for (
    const stage of [
      "BuffersCopyEnter",
      "BuffersCopied",
      "BuffersFreeEnter",
      "BuffersFreed",
    ]
  ) {
    assertTraceStageCount(invoke, stage, 2);
  }
  assertTraceStageCount(invoke, "InvokeReturn", 2);
  assert(
    /Drop for WasiBoundaryScope[\s\S]*?WasiBoundaryStage::ScopeUnwind[\s\S]*?self\.origin as u32/
      .test(
        wasiCargo,
      ),
    "unwind records do not carry their originating enter stage in value_1",
  );
  assert(
    /fn complete\(&mut self\)[\s\S]*?self\.completed = true/.test(wasiCargo),
    "the unwind scope cannot be completed before normal return",
  );

  assert(
    /fn exec_with_trace_id\([\s\S]*?trace_id:\s*u32/.test(cargoWorkspace),
    "FetchMetadata::exec_with_trace_id is missing",
  );
  assertInOrder(
    cargoWorkspace,
    [
      "WasiBoundaryStage::MetadataInvokeEnter",
      "invoke_cargo_with_trace_id(&command.cargo_command(), trace_id)",
      "WasiBoundaryStage::MetadataInvokeReturn",
      "WasiBoundaryStage::MetadataUtf8Enter",
      "from_utf8(&output_stdout)",
      ".find(|line| line.starts_with('{'))",
      "WasiBoundaryStage::MetadataUtf8Return",
      "WasiBoundaryStage::MetadataParseEnter",
      "MetadataCommand::parse(stdout)",
      "WasiBoundaryStage::MetadataParseReturn",
      'progress("cargo metadata: finished".to_owned())',
      "WasiBoundaryStage::MetadataFinished",
    ],
    "FetchMetadata metadata lifecycle",
  );

  assert(
    /ProjectWorkspace::load_inner\([\s\S]*?trace_id/.test(workspace),
    "ProjectWorkspace::load does not reserve and pass a trace ID",
  );
  assertInOrder(
    workspace,
    [
      "WasiBoundaryStage::WorkspaceCargoSpawnEnter",
      '.name("ProjectWorkspace::cargo_metadata".to_owned())',
      "fetch_metadata.exec_with_trace_id(false, progress, trace_id)",
      "WasiBoundaryStage::WorkspaceCargoSpawnReturn",
      "WasiBoundaryStage::WorkspaceCargoJoinEnter",
      "cargo_metadata.join()",
      "WasiBoundaryStage::WorkspaceCargoJoinReturn",
      "WasiBoundaryStage::WorkspaceCargoJoinError",
      "WasiBoundaryStage::WorkspaceCargoMapReturn",
      "WasiBoundaryStage::WorkspaceLoadReturn",
    ],
    "ProjectWorkspace Cargo lifecycle",
  );

  assert(
    wasiCargo.startsWith('#[cfg(target_os = "wasi")]'),
    "wasi_cargo trace API is not WASI-gated",
  );
  assertDirectCallsAreWasiGated(cargoWorkspace, "cargo_workspace.rs");
  assertDirectCallsAreWasiGated(workspace, "workspace.rs");
  assertPayloadFreeTraceCalls(wasiCargo, "wasi_cargo.rs");
  assertPayloadFreeTraceCalls(cargoWorkspace, "cargo_workspace.rs");
  assertPayloadFreeTraceCalls(workspace, "workspace.rs");
});

Deno.test("host Cargo errors emit a terminal return and preserve the exact error", async () => {
  const wasiCargo = await Deno.readTextFile(
    `${rustAnalyzerRoot}/crates/toolchain/src/wasi_cargo.rs`,
  );
  const invoke = functionSource(
    wasiCargo,
    "pub fn invoke_cargo_with_trace_id(",
  );
  const hostError = functionSource(invoke, "if res != 0");

  assertInOrder(
    hostError,
    [
      "trace_boundary(trace_id, WasiBoundaryStage::InvokeReturn, res, 0)",
      "ffi_scope.complete()",
      'return Err(io::Error::new(io::ErrorKind::Other, "host_run_cargo failed"))',
    ],
    "host_run_cargo error return",
  );
});

Deno.test("linked projects bracket each inline workspace task and join", async () => {
  const workspace = await Deno.readTextFile(
    `${rustAnalyzerRoot}/crates/project-model/src/workspace.rs`,
  );
  const loadInline = functionSource(workspace, "pub fn load_inline(");
  const tasks = [
    {
      id: "rustc_cfg_trace_id",
      handle: "rustc_cfg",
      kind: 1,
      operation: "rustc_cfg::get(",
      observation: "1",
    },
    {
      id: "data_layout_trace_id",
      handle: "data_layout",
      kind: 2,
      operation: "target_data::get(",
      observation: "u32::from(result.is_ok())",
    },
    {
      id: "loaded_sysroot_trace_id",
      handle: "loaded_sysroot",
      kind: 3,
      operation: "sysroot.load_workspace(",
      observation: "u32::from(result.is_some())",
    },
  ];

  assert(
    loadInline.match(/next_trace_id\(\)/g)?.length === 3,
    "load_inline must reserve exactly one unique ID per scoped task",
  );
  for (const task of tasks) {
    assert(
      loadInline.includes(`let ${task.id} = next_trace_id();`),
      `${task.handle} does not reserve its own trace ID`,
    );
    const closure = functionSource(
      loadInline,
      `let ${task.handle} = s.spawn`,
    );
    assert(
      /s\.spawn\s*\(\s*move\s*\|\|\s*\{/.test(maskSourceTrivia(closure)),
      `${task.handle} scoped task does not move-capture its trace ID`,
    );
    assertTraceArguments(
      closure,
      `${task.id}, WasiBoundaryStage::WorkspaceInlineTaskEnter, ${task.kind}, 0`,
      `${task.handle} task enter`,
    );
    assertTraceArguments(
      closure,
      `${task.id}, WasiBoundaryStage::WorkspaceInlineTaskReturn, ${task.kind}, ${task.observation}`,
      `${task.handle} task return`,
    );
    assertInOrder(
      maskSourceTrivia(closure)
        .replaceAll(/\s+/g, " ")
        .replaceAll("( ", "("),
      [
        "WasiBoundaryStage::WorkspaceInlineTaskEnter",
        `WasiBoundaryScope::new(${task.id}, WasiBoundaryStage::WorkspaceInlineTaskEnter`,
        task.operation,
        "WasiBoundaryStage::WorkspaceInlineTaskReturn",
        "task_scope.complete()",
        "result",
      ],
      `${task.handle} task lifecycle`,
    );

    const join = functionSource(loadInline, `let ${task.handle} = {`);
    assertTraceArguments(
      join,
      `${task.id}, WasiBoundaryStage::WorkspaceInlineJoinEnter, ${task.kind}, 0`,
      `${task.handle} join enter`,
    );
    assertTraceArguments(
      join,
      `${task.id}, WasiBoundaryStage::WorkspaceInlineJoinReturn, ${task.kind}, 1`,
      `${task.handle} join return`,
    );
    assertTraceArguments(
      join,
      `${task.id}, WasiBoundaryStage::WorkspaceInlineJoinError, ${task.kind}, 0`,
      `${task.handle} join error`,
    );
    assertInOrder(
      maskSourceTrivia(join),
      [
        "WasiBoundaryStage::WorkspaceInlineJoinEnter",
        `${task.handle}.join()`,
        "WasiBoundaryStage::WorkspaceInlineJoinReturn",
        "WasiBoundaryStage::WorkspaceInlineJoinError",
      ],
      `${task.handle} join lifecycle`,
    );
  }
  assertInlineJoinPropagation(
    loadInline,
    tasks.map((task) => task.handle),
  );
  for (
    const [stage, count] of [
      ["WorkspaceInlineTaskEnter", 3],
      ["WorkspaceInlineTaskReturn", 3],
      ["WorkspaceInlineJoinEnter", 3],
      ["WorkspaceInlineJoinReturn", 3],
      ["WorkspaceInlineJoinError", 3],
      ["WorkspaceInlineLoadReturn", 1],
    ] as const
  ) {
    assertTraceStageCount(loadInline, stage, count);
  }

  assertTraceArguments(
    loadInline,
    "0, WasiBoundaryStage::WorkspaceInlineLoadReturn, 0, 1",
    "inline workspace load return",
  );
  assertInOrder(
    maskSourceTrivia(loadInline),
    ["WasiBoundaryStage::WorkspaceInlineLoadReturn", "ProjectWorkspace {"],
    "inline workspace successful return",
  );
  assert(
    !loadInline.includes("thread_local!") &&
      !loadInline.includes("parent_trace"),
    "load_inline must not add parent correlation yet",
  );
});

Deno.test("inline join propagation assertions reject structural regressions", async () => {
  const workspace = await Deno.readTextFile(
    `${rustAnalyzerRoot}/crates/project-model/src/workspace.rs`,
  );
  const loadInline = functionSource(workspace, "pub fn load_inline(");
  const handles = ["rustc_cfg", "data_layout", "loaded_sysroot"];
  const scope = functionSource(loadInline, "let join = thread::scope");
  for (
    const [first, second] of [
      ["rustc_cfg", "data_layout"],
      ["data_layout", "loaded_sysroot"],
    ]
  ) {
    const firstJoin = functionSource(scope, `let ${first} = {`);
    const secondJoin = functionSource(scope, `let ${second} = {`);
    const reorderedScope = scope
      .replace(firstJoin, "__FIRST_JOIN__")
      .replace(secondJoin, firstJoin)
      .replace("__FIRST_JOIN__", secondJoin);
    const reordered = loadInline.replace(scope, reorderedScope);
    assertRejects(
      () => assertInlineJoinPropagation(reordered, handles),
      `the contract accepted reordered ${first}/${second} joins`,
    );
  }

  for (const handle of handles) {
    const joinBlock = functionSource(scope, `let ${handle} = {`);
    const joinMatch = functionSource(joinBlock, `match ${handle}.join()`);
    const errorArm = functionSource(joinMatch, "Err(error) =>");
    const commentedReturn = errorArm.replace(
      "return Err(error);",
      "// return Err(error);",
    );
    const missingErrorReturn = loadInline.replace(errorArm, commentedReturn);
    assertRejects(
      () => assertInlineJoinPropagation(missingErrorReturn, handles),
      `the contract accepted ${handle} error propagation in a comment`,
    );
  }

  for (const handle of handles) {
    const joinBlock = functionSource(scope, `let ${handle} = {`);
    const joinMatch = functionSource(joinBlock, `match ${handle}.join()`);
    const errorArm = functionSource(joinMatch, "Err(error) =>");
    const bracelessError = loadInline.replace(
      errorArm,
      "Err(error) => return Err(error),",
    );
    assertRejects(
      () => assertInlineJoinPropagation(bracelessError, handles),
      `the contract accepted a brace-less ${handle} error arm by scanning unrelated braces`,
    );
  }

  const missingResumeUnwind = loadInline.replace(
    "std::panic::resume_unwind(e)",
    'panic!("changed propagation")',
  );
  assertRejects(
    () => assertInlineJoinPropagation(missingResumeUnwind, handles),
    "the contract accepted removal of resume_unwind",
  );
});
