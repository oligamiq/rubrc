import { RuntimeTerminalService } from "./runtime_terminal_service.ts";

const encoder = new TextEncoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const actualValue = JSON.stringify(actual);
  const expectedValue = JSON.stringify(expected);
  if (actualValue !== expectedValue) {
    throw new Error(
      `${message}: expected ${expectedValue}, got ${actualValue}`,
    );
  }
}

function assertThrows(operation: () => void, message: string) {
  let threw = false;
  try {
    operation();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

function captureThrow(operation: () => void, message: string): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error(message);
}

const view = (
  writes: string[],
  size = { cols: 80, rows: 24 },
) => ({
  write: (value: string) => writes.push(value),
  size: () => size,
});

Deno.test("terminal service replays chronological output and keeps captures separate", () => {
  const service = new RuntimeTerminalService("generation-a");
  const red = encoder.encode("赤");
  service.write(10, red.subarray(0, 1));
  service.write(10, encoder.encode("\x1b[31mERR\x1b[0m"), true);
  service.write(10, red.subarray(1));

  const writes: string[] = [];
  service.attach(10, view(writes));

  assertEquals(
    writes.join(""),
    "\x1b[31mERR\x1b[0m赤",
    "stdout and stderr replay order",
  );
  assertEquals(service.out(10), "赤", "stdout capture");
  assertEquals(service.error(10), "\x1b[31mERR\x1b[0m", "stderr capture");
  assert(
    !writes.join("").includes("�"),
    "split UTF-8 emitted replacement text",
  );
});

Deno.test("terminal service preserves exact ANSI and split multibyte output", () => {
  const service = new RuntimeTerminalService("generation-ansi");
  const exact = "\x1b[31m赤🙂\x1b[0m";
  const bytes = encoder.encode(exact);
  service.write(9, bytes.subarray(0, 7), true);
  service.write(9, bytes.subarray(7, 10), true);
  service.write(9, bytes.subarray(10), true);

  const writes: string[] = [];
  service.attach(9, view(writes));

  assertEquals(writes.join(""), exact, "exact ANSI replay");
  assertEquals(service.error(9), exact, "exact ANSI stderr capture");
  assert(!writes.join("").includes("�"), "valid split UTF-8 was corrupted");
});

Deno.test("terminal service rejects malformed UTF-8 without replacement text", () => {
  const service = new RuntimeTerminalService("generation-malformed");

  assertThrows(
    () => service.write(3, new Uint8Array([0xf0, 0x28, 0x8c, 0x28])),
    "malformed UTF-8 was accepted",
  );
  service.write(3, encoder.encode("valid"));
  const writes: string[] = [];
  service.attach(3, view(writes));

  assertEquals(writes.join(""), "valid", "output after malformed UTF-8");
  assert(
    !writes.join("").includes("�"),
    "malformed UTF-8 became replacement text",
  );
});

Deno.test("terminal service bounds history and captures by complete UTF-8 code points", () => {
  const service = new RuntimeTerminalService("generation-bounded");
  const limit = 64 * 1024;
  service.write(4, encoder.encode(`${"a".repeat(limit - 1)}赤`));
  service.write(4, encoder.encode("🙂"), true);

  const writes: string[] = [];
  service.attach(4, view(writes));
  const replay = writes.join("");

  assert(
    encoder.encode(replay).byteLength <= limit,
    "chronological history exceeded its UTF-8 byte bound",
  );
  assert(
    encoder.encode(service.out(4)).byteLength <= limit,
    "stdout capture exceeded its UTF-8 byte bound",
  );
  assert(
    replay.endsWith("赤🙂"),
    "history split a retained Unicode code point",
  );
  assert(service.out(4).endsWith("赤"), "stdout split a retained code point");
  assertEquals(service.error(4), "🙂", "stderr capture after bounded stdout");
  assert(!replay.includes("�"), "bounded output contains replacement text");
});

Deno.test("terminal service atomically replaces a view during a live write", () => {
  const service = new RuntimeTerminalService("generation-replace-write");
  const firstWrites: string[] = [];
  const secondWrites: string[] = [];
  let secondDispose: { dispose(): void } | undefined;
  const firstDispose = service.attach(7, {
    write(value) {
      firstWrites.push(value);
      if (value === "replace") {
        secondDispose = service.attach(7, view(secondWrites));
      }
    },
    size: () => ({ cols: 120, rows: 40 }),
  });

  service.write(7, encoder.encode("before"));
  service.write(7, encoder.encode("replace"));
  firstDispose.dispose();
  service.write(7, encoder.encode("after"));

  assertEquals(firstWrites.join(""), "beforereplace", "replaced view writes");
  assertEquals(
    secondWrites.join(""),
    "beforereplaceafter",
    "replacement replay-to-live boundary",
  );
  assertEquals(service.size(7), { cols: 80, rows: 24 }, "replacement size");
  secondDispose?.dispose();
  assertEquals(service.size(7), { cols: 80, rows: 24 }, "detached size");
});

Deno.test("terminal service queues reentrant writes across replay exactly once", () => {
  const service = new RuntimeTerminalService("generation-replay-write");
  service.write(5, encoder.encode("before"));
  const writes: string[] = [];

  service.attach(5, {
    write(value) {
      writes.push(value);
      if (value === "before") service.write(5, encoder.encode("during-1"));
      if (value === "during-1") service.write(5, encoder.encode("during-2"));
    },
    size: () => ({ cols: 132, rows: 43 }),
  });
  service.write(5, encoder.encode("after"));

  assertEquals(
    writes,
    ["before", "during-1", "during-2", "after"],
    "reentrant replay writes",
  );
  assertEquals(service.size(5), { cols: 132, rows: 43 }, "attached size");
});

Deno.test("failed initial replay rolls back and the same view retries from history", () => {
  const service = new RuntimeTerminalService("generation-initial-throw");
  service.write(20, encoder.encode("before"));
  const failure = new Error("initial replay failed");
  const writes: string[] = [];
  let fail = true;
  const terminalView = {
    write(value: string) {
      writes.push(value);
      if (fail) throw failure;
    },
    size: () => ({ cols: 101, rows: 31 }),
  };

  const caught = captureThrow(
    () => service.attach(20, terminalView),
    "initial replay did not throw",
  );
  assert(caught === failure, "initial replay changed the thrown error");
  assertEquals(service.size(20), { cols: 80, rows: 24 }, "failed initial view");

  fail = false;
  service.attach(20, terminalView);
  service.write(20, encoder.encode("after"));
  assertEquals(
    writes,
    ["before", "before", "after"],
    "same-view retry skipped replay or duplicated live output",
  );
});

Deno.test("failed replacement replay preserves the prior view and queued history", () => {
  const service = new RuntimeTerminalService("generation-replacement-throw");
  service.write(21, encoder.encode("before"));
  const priorWrites: string[] = [];
  service.attach(21, view(priorWrites, { cols: 110, rows: 35 }));
  const failure = new Error("replacement replay failed");
  const failedWrites: string[] = [];
  let fail = true;
  const failedView = {
    write(value: string) {
      failedWrites.push(value);
      if (fail && value === "before") {
        service.write(21, encoder.encode("during"));
      }
      if (fail) throw failure;
    },
    size: () => ({ cols: 120, rows: 40 }),
  };

  const caught = captureThrow(
    () => service.attach(21, failedView),
    "replacement replay did not throw",
  );
  assert(caught === failure, "replacement replay changed the thrown error");
  assertEquals(
    service.size(21),
    { cols: 110, rows: 35 },
    "failed replacement displaced the prior view",
  );
  service.write(21, encoder.encode("after"));
  assertEquals(
    priorWrites,
    ["before", "during", "after"],
    "queued replacement writes were lost or duplicated on the prior view",
  );

  fail = false;
  service.attach(21, failedView);
  assertEquals(
    failedWrites,
    ["before", "beforeduringafter"],
    "replacement retry lost retained history",
  );
});

Deno.test("failed queued drain is not published and retains replay for retry", () => {
  const service = new RuntimeTerminalService("generation-drain-throw");
  service.write(22, encoder.encode("before"));
  const priorWrites: string[] = [];
  service.attach(22, view(priorWrites, { cols: 111, rows: 36 }));
  const failure = new Error("queued drain failed");
  const failedWrites: string[] = [];
  let fail = true;
  const failedView = {
    write(value: string) {
      failedWrites.push(value);
      if (value === "before") service.write(22, encoder.encode("queued"));
      if (value === "queued" && fail) throw failure;
    },
    size: () => ({ cols: 121, rows: 41 }),
  };

  const caught = captureThrow(
    () => service.attach(22, failedView),
    "queued drain did not throw",
  );
  assert(caught === failure, "queued drain changed the thrown error");
  assertEquals(
    service.size(22),
    { cols: 111, rows: 36 },
    "failed drain displaced the prior view",
  );
  assertEquals(
    priorWrites,
    ["before", "queued"],
    "queued write was not delivered exactly once to the prior view",
  );

  fail = false;
  service.attach(22, failedView);
  assertEquals(
    failedWrites.join(""),
    "beforequeuedbeforequeued",
    "failed view retry did not replay complete retained history",
  );
});

Deno.test("live write failure detaches only the throwing view and retains history", () => {
  const service = new RuntimeTerminalService("generation-live-throw");
  service.write(23, encoder.encode("before"));
  const failure = new Error("live write failed");
  service.attach(23, {
    write(value) {
      if (value === "bad") throw failure;
    },
    size: () => ({ cols: 122, rows: 42 }),
  });

  const caught = captureThrow(
    () => service.write(23, encoder.encode("bad")),
    "live write did not throw",
  );
  assert(caught === failure, "live write changed the thrown error");
  assertEquals(service.size(23), { cols: 80, rows: 24 }, "throwing live view");

  const retryWrites: string[] = [];
  service.attach(23, view(retryWrites));
  assertEquals(retryWrites.join(""), "beforebad", "live failure retry replay");
});

Deno.test("nested replacement during replay supersedes the outer attachment", () => {
  const service = new RuntimeTerminalService("generation-nested-replay");
  service.write(24, encoder.encode("before"));
  const outerWrites: string[] = [];
  const nestedWrites: string[] = [];
  let nested: { dispose(): void } | undefined;

  const outer = service.attach(24, {
    write(value) {
      outerWrites.push(value);
      if (value === "before") {
        nested = service.attach(
          24,
          view(nestedWrites, { cols: 124, rows: 44 }),
        );
      }
    },
    size: () => ({ cols: 123, rows: 43 }),
  });
  outer.dispose();
  service.write(24, encoder.encode("after"));

  assertEquals(outerWrites, ["before"], "superseded replay view output");
  assertEquals(
    nestedWrites,
    ["before", "after"],
    "nested replay replacement boundary",
  );
  assertEquals(
    service.size(24),
    { cols: 124, rows: 44 },
    "nested replay owner",
  );
  nested?.dispose();
});

Deno.test("nested replacement during queued drain owns the live boundary", () => {
  const service = new RuntimeTerminalService("generation-nested-drain");
  service.write(25, encoder.encode("before"));
  const outerWrites: string[] = [];
  const nestedWrites: string[] = [];

  const outer = service.attach(25, {
    write(value) {
      outerWrites.push(value);
      if (value === "before") service.write(25, encoder.encode("queued"));
      if (value === "queued") {
        service.attach(25, view(nestedWrites, { cols: 125, rows: 45 }));
      }
    },
    size: () => ({ cols: 123, rows: 43 }),
  });
  outer.dispose();
  service.write(25, encoder.encode("after"));

  assertEquals(
    outerWrites,
    ["before", "queued"],
    "superseded queued-drain output",
  );
  assertEquals(
    nestedWrites,
    ["beforequeued", "after"],
    "nested drain replacement boundary",
  );
  assertEquals(service.size(25), { cols: 125, rows: 45 }, "nested drain owner");
});

Deno.test("replacement leaves a split UTF-8 stream open for later completion", () => {
  const service = new RuntimeTerminalService("generation-open-stream");
  const red = encoder.encode("赤");
  service.write(26, red.subarray(0, 1));
  const firstWrites: string[] = [];
  const secondWrites: string[] = [];
  service.attach(26, view(firstWrites));
  service.attach(26, view(secondWrites));

  service.write(26, red.subarray(1));

  assertEquals(firstWrites.join(""), "", "replaced split-stream view");
  assertEquals(secondWrites.join(""), "赤", "completed split-stream output");
  assertEquals(service.out(26), "赤", "completed split-stream capture");
  service.dispose();
});

Deno.test("dispose surfaces trailing UTF-8 and repeated disposal is idempotent", () => {
  const service = new RuntimeTerminalService("generation-finalize-one");
  service.write(27, new Uint8Array([0xe8]));

  const caught = captureThrow(
    () => service.dispose(),
    "trailing stdout sequence was not surfaced",
  );
  assert(caught instanceof TypeError, "single trailing sequence error type");
  service.dispose();
  assertThrows(
    () => service.write(27, encoder.encode("late")),
    "failed finalization retained writable state",
  );
});

Deno.test("dispose aggregates trailing stdout and stderr decoder failures", () => {
  const service = new RuntimeTerminalService("generation-finalize-both");
  service.write(28, new Uint8Array([0xe8]));
  service.write(28, new Uint8Array([0xf0]), true);

  const caught = captureThrow(
    () => service.dispose(),
    "trailing stream sequences were not surfaced",
  );
  assert(
    caught instanceof AggregateError,
    "dual trailing error was not aggregated",
  );
  assertEquals(caught.errors.length, 2, "aggregated decoder error count");
  assert(
    caught.errors.every((error) => error instanceof TypeError),
    "aggregate changed decoder error types",
  );
  service.dispose();
  assertThrows(
    () => service.attach(28, view([])),
    "failed aggregate finalization retained attachment state",
  );
});

Deno.test("dispose during queued drain prevents later delivery or publication", () => {
  const service = new RuntimeTerminalService("generation-dispose-drain");
  service.write(29, encoder.encode("before"));
  const writes: string[] = [];

  const attachment = service.attach(29, {
    write(value) {
      writes.push(value);
      if (value === "before") {
        service.write(29, encoder.encode("queued-1"));
        service.write(29, encoder.encode("queued-2"));
      }
      if (value === "queued-1") service.dispose();
    },
    size: () => ({ cols: 129, rows: 49 }),
  });
  attachment.dispose();

  assertEquals(
    writes,
    ["before", "queued-1"],
    "drain continued after disposal",
  );
  assertThrows(
    () => service.write(29, encoder.encode("late")),
    "disposed drain view was published",
  );
});

Deno.test("duplicate attachment does not replay twice and stale disposal is harmless", () => {
  const service = new RuntimeTerminalService("generation-duplicate");
  service.write(6, encoder.encode("before"));
  const writes: string[] = [];
  const terminalView = view(writes, { cols: 100, rows: 30 });
  const first = service.attach(6, terminalView);
  const duplicate = service.attach(6, terminalView);

  first.dispose();
  service.write(6, encoder.encode("after"));
  assertEquals(writes, ["before", "after"], "duplicate attachment output");
  assertEquals(service.size(6), { cols: 100, rows: 30 }, "duplicate view size");

  duplicate.dispose();
  service.write(6, encoder.encode("detached"));
  assertEquals(writes, ["before", "after"], "disposed duplicate remained live");
  assertEquals(service.size(6), { cols: 80, rows: 24 }, "fallback size");
});

Deno.test("terminal services isolate reused session ids by generation", () => {
  const oldService = new RuntimeTerminalService("old-generation");
  const newService = new RuntimeTerminalService("new-generation");
  const oldWrites: string[] = [];
  const newWrites: string[] = [];
  oldService.attach(0, view(oldWrites));
  newService.attach(0, view(newWrites));

  oldService.write(0, encoder.encode("old"));
  newService.write(0, encoder.encode("new"));

  assertEquals(oldWrites.join(""), "old", "old generation output");
  assertEquals(newWrites.join(""), "new", "new generation output");
});

Deno.test("detached terminal sizes cannot mutate another generation fallback", () => {
  const first = new RuntimeTerminalService("first-size-generation");
  const second = new RuntimeTerminalService("second-size-generation");
  const mutable = first.size(1);
  mutable.cols = 1;
  mutable.rows = 1;

  assertEquals(
    first.size(1),
    { cols: 80, rows: 24 },
    "same generation fallback",
  );
  assertEquals(
    second.size(1),
    { cols: 80, rows: 24 },
    "other generation fallback",
  );
});

Deno.test("terminal service disposal cannot be raced by replay or later writes", () => {
  const service = new RuntimeTerminalService("generation-dispose");
  service.write(8, encoder.encode("before"));
  const writes: string[] = [];
  const attachment = service.attach(8, {
    write(value) {
      writes.push(value);
      service.dispose();
    },
    size: () => ({ cols: 90, rows: 20 }),
  });

  attachment.dispose();
  service.dispose();
  assertEquals(writes, ["before"], "dispose during replay output");
  assertThrows(
    () => service.write(8, encoder.encode("late")),
    "disposed service accepted a write",
  );
  assertThrows(
    () => service.attach(8, view([])),
    "disposed service accepted an attachment",
  );
});
