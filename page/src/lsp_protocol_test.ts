import {
  encodeLspMessage,
  isLspSession,
  LSP_SESSION_ID,
  LspFrameDecoder,
  toLspBytes,
} from "./lsp_protocol.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("LSP session accepts signed and unsigned Wasm representations", () => {
  assert(isLspSession(-1), "signed -1 must route to LSP");
  assert(isLspSession(LSP_SESSION_ID), "u32::MAX must route to LSP");
  assert(!isLspSession(0), "terminal session 0 must not route to LSP");
});

Deno.test("LSP bytes accept typed and numeric arrays only", () => {
  const source = new Uint8Array([1, 2, 255]);
  const typed = toLspBytes(source);
  const numeric = toLspBytes([1, 2, 255]);
  assert(typed !== source, "typed input must be copied");
  assert(typed.join(",") === "1,2,255", "typed bytes changed");
  assert(numeric.join(",") === "1,2,255", "numeric bytes changed");
  for (const invalid of [{ 0: 1 }, [256], [-1], [1.5], [Number.NaN]]) {
    let threw = false;
    try {
      toLspBytes(invalid);
    } catch {
      threw = true;
    }
    assert(threw, `expected rejection for ${JSON.stringify(invalid)}`);
  }
});

Deno.test("LSP framing uses UTF-8 byte length", () => {
  const frame = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: "日本語" });
  const text = new TextDecoder().decode(frame);
  const [header, body] = text.split("\r\n\r\n");
  const declared = Number(header.match(/Content-Length: (\d+)/)?.[1]);
  assert(
    declared === new TextEncoder().encode(body).length,
    "wrong byte length",
  );
});

Deno.test("LSP decoder handles split and coalesced frames exactly once", () => {
  const first = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: {} });
  const second = encodeLspMessage({ jsonrpc: "2.0", method: "ready" });
  const decoder = new LspFrameDecoder();
  assert(decoder.push(first.slice(0, 7)).length === 0, "partial header parsed");
  const joined = new Uint8Array(first.length - 7 + second.length);
  joined.set(first.slice(7));
  joined.set(second, first.length - 7);
  const messages = decoder.push(joined) as Array<
    { id?: number; method?: string }
  >;
  assert(messages.length === 2, `expected 2 messages, got ${messages.length}`);
  assert(messages[0].id === 1 && messages[1].method === "ready", "wrong order");
  assert(decoder.push([]).length === 0, "messages emitted twice");
});

Deno.test("LSP decoder rejects malformed streams", () => {
  for (
    const bytes of [
      new TextEncoder().encode("Other: 1\r\n\r\n{}"),
      new TextEncoder().encode("Content-Length: 2\r\n\r\n{x"),
    ]
  ) {
    let threw = false;
    try {
      new LspFrameDecoder().push(bytes);
    } catch {
      threw = true;
    }
    assert(threw, "malformed frame must throw");
  }
});
