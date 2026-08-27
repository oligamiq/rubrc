import {
  acquireSharedChannel,
  acquireTerminalCapture,
  appendBounded,
  createChannelOwner,
  createTerminalGenerationRouter,
  createTerminalSessionChannels,
  observeAsyncFailure,
} from "./terminal_channel_lifecycle.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const channel = (closed: string[], name: string) => ({
  bc: { close: () => closed.push(name) },
});

Deno.test("shared terminal endpoint closes on last release and remounts fresh", () => {
  const closed: string[] = [];
  let creations = 0;
  const create = () => channel(closed, `terminal-${++creations}`);

  const first = acquireSharedChannel("generation-terminal", create);
  const second = acquireSharedChannel("generation-terminal", create);
  assert(creations === 1, `shared endpoint created ${creations} times`);
  first.release();
  assert(closed.length === 0, "shared endpoint closed while still leased");
  second.release();
  assert(
    closed.join(",") === "terminal-1",
    `last release did not close endpoint: ${closed}`,
  );

  const remount = acquireSharedChannel("generation-terminal", create);
  assert(creations === 2, "remount reused a closed generation endpoint");
  remount.release();
  assert(
    closed.join(",") === "terminal-1,terminal-2",
    `remounted endpoint was not closed: ${closed}`,
  );
});

Deno.test("shared channel leases retain their concrete channel type", () => {
  const lease = acquireSharedChannel("typed-generation-channel", () => ({
    generation: "typed-generation",
    bc: { close() {} },
  }));

  assert(
    lease.channel.generation === "typed-generation",
    "typed shared channel value changed",
  );
  lease.release();
});

Deno.test("terminal session channels roll back partial construction", () => {
  const closed: string[] = [];
  let creations = 0;
  let caught: unknown;
  try {
    createTerminalSessionChannels(
      {
        resize: "resize",
        inputChar: "char",
        inputString: "string",
        lsp: "lsp",
        interrupt: "interrupt",
        createSession: "session",
      },
      (id) => {
        if (++creations === 3) throw new Error("channel creation failed");
        return channel(closed, id);
      },
    );
  } catch (error) {
    caught = error;
  }

  assert(caught instanceof Error, "partial channel construction resolved");
  assert(
    closed.join() === "resize,char",
    `partial channels were not rolled back: ${closed}`,
  );
});

Deno.test("channel owner attempts every close when one channel throws", () => {
  const closed: string[] = [];
  const failure = new Error("first close failed");
  const owner = createChannelOwner([
    {
      bc: {
        close: () => {
          throw failure;
        },
      },
    },
    channel(closed, "second"),
    channel(closed, "third"),
  ]);
  let caught: unknown;

  try {
    owner.dispose();
  } catch (error) {
    caught = error;
  }

  assert(caught === failure, "single channel close failure changed");
  assert(closed.join() === "second,third", `later channels leaked: ${closed}`);
});

Deno.test("component channel owner closes every session channel once", () => {
  const closed: string[] = [];
  const owner = createChannelOwner([
    channel(closed, "size"),
    channel(closed, "resize"),
    channel(closed, "input-char"),
    channel(closed, "input-string"),
    channel(closed, "lsp"),
    channel(closed, "interrupt"),
    channel(closed, "create-session"),
  ]);

  owner.dispose();
  owner.dispose();
  assert(
    closed.join(",") ===
      "size,resize,input-char,input-string,lsp,interrupt,create-session",
    `component leaked or double-closed channels: ${closed}`,
  );
});

Deno.test("terminal session channel set owns exact refs including lazy session creation", () => {
  const closed: string[] = [];
  const created: string[] = [];
  const channels = createTerminalSessionChannels(
    {
      resize: "resize",
      inputChar: "input-char",
      inputString: "input-string",
      lsp: "lsp",
      interrupt: "interrupt",
      createSession: "create-session",
    },
    (id) => {
      created.push(id);
      return channel(closed, id);
    },
  );

  assert(
    created.join(",") === "resize,input-char,input-string,lsp,interrupt",
    `wrong eager terminal channels: ${created}`,
  );
  const firstSessionRef = channels.createSession();
  const secondSessionRef = channels.createSession();
  assert(firstSessionRef === secondSessionRef, "session ref was duplicated");
  assert(
    created.join(",") ===
      "resize,input-char,input-string,lsp,interrupt,create-session",
    `missing lazy session channel: ${created}`,
  );
  channels.dispose();
  assert(
    closed.join(",") === created.join(","),
    `terminal channel set leaked refs: ${closed}`,
  );
});

Deno.test("terminal capture is bounded and resets after its generation releases", () => {
  const first = acquireTerminalCapture("generation-capture", 8);
  const second = acquireTerminalCapture("generation-capture", 8);
  first.capture.appendOut("123456");
  second.capture.appendOut("7890");
  assert(
    first.capture.out() === "34567890",
    `capture was not bounded: ${first.capture.out()}`,
  );
  first.release();
  assert(
    second.capture.out() === "34567890",
    "capture reset before final release",
  );
  second.release();

  const remount = acquireTerminalCapture("generation-capture", 8);
  assert(remount.capture.out() === "", "remount inherited stdout capture");
  assert(remount.capture.error() === "", "remount inherited stderr capture");
  remount.release();
});

Deno.test("terminal capture is bounded by UTF-8 bytes without split characters", () => {
  const terminal = acquireTerminalCapture("utf8-capture", 4);
  terminal.capture.appendOut("ab🚀");
  const output = terminal.capture.out();
  assert(
    new TextEncoder().encode(output).byteLength <= 4,
    `capture exceeded byte limit: ${output}`,
  );
  assert(output === "🚀", `capture split or retained excess bytes: ${output}`);
  terminal.release();
});

Deno.test("bounded terminal text trims complete code points from oversized values", () => {
  const bounded = appendBounded("", 0, "ab赤🙂", 7);
  assert(bounded.value === "赤🙂", `wrong bounded suffix: ${bounded.value}`);
  assert(bounded.bytes === 7, `wrong bounded byte count: ${bounded.bytes}`);
});

Deno.test("terminal generation router isolates reused session ids", () => {
  const writes: string[] = [];
  const router = createTerminalGenerationRouter<string, string>(
    (target, data) => writes.push(`${target}:${data}`),
  );
  const oldTarget = "old-terminal";
  const newTarget = "new-terminal";
  router.register("old-generation", 0, oldTarget);
  router.register("new-generation", 0, newTarget);

  router.write("old-generation", 0, "old-output");
  router.unregister("old-generation", 0, oldTarget);
  router.write("old-generation", 0, "late-old-output");
  router.write("new-generation", 0, "new-output");

  assert(
    writes.join(",") === "old-terminal:old-output,new-terminal:new-output",
    `terminal generations crossed: ${writes}`,
  );
});

Deno.test("terminal captures isolate sessions in the same generation", () => {
  const first = acquireTerminalCapture("generation-capture:0", 8);
  const second = acquireTerminalCapture("generation-capture:1", 8);
  first.capture.appendOut("main");
  second.capture.appendOut("child");
  assert(first.capture.out() === "main", "child output polluted main capture");
  assert(
    second.capture.out() === "child",
    "main output polluted child capture",
  );
  first.release();
  second.release();
});

Deno.test("async terminal forwarding rejection is observed", async () => {
  const failure = new Error("LSP channel closed");
  const observed: unknown[] = [];
  observeAsyncFailure(Promise.reject(failure), (error) => observed.push(error));
  await Promise.resolve();
  await Promise.resolve();
  assert(observed[0] === failure, "forwarding rejection was not observed");
});
