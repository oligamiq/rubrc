/// <reference lib="deno.ns" />

import { parseTar } from "./parse_tar.ts";

function tarHeader(
  name: string,
  size: number,
  typeflag = "0",
  prefix = "",
): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(
    new TextEncoder().encode(size.toString(8).padStart(11, "0") + "\0"),
    124,
  );
  header[156] = typeflag.charCodeAt(0);
  header.set(new TextEncoder().encode(prefix), 345);
  return header;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

Deno.test("parseTar rejects truncated file content", async () => {
  const stream = streamOf(tarHeader("libstd.rlib", 1));

  let threw = false;
  try {
    await parseTar(stream, () => {});
  } catch (error) {
    threw = error instanceof Error &&
      error.message.includes("Truncated tar entry");
  }

  if (!threw) {
    throw new Error("expected parseTar to reject truncated file content");
  }
});

Deno.test("parseTar preserves filenames that fill the 100-byte name field", async () => {
  const name = "a".repeat(100);
  const names: string[] = [];
  await parseTar(streamOf(tarHeader(name, 0), new Uint8Array(1024)), (file) => {
    names.push(file.name);
  });

  if (names[0] !== name) {
    throw new Error(
      `expected ${name.length} byte name, got ${names[0]?.length}`,
    );
  }
});

Deno.test("parseTar handles null-padded directory size as zero", async () => {
  const header = tarHeader(".", 0, "5");
  header.fill(0, 124, 136);
  const files: string[] = [];

  await parseTar(streamOf(header, new Uint8Array(1024)), (file) => {
    files.push(file.name);
  });

  if (files[0] !== ".") {
    throw new Error(`expected root directory entry, got ${files[0]}`);
  }
});

Deno.test("parseTar joins ustar prefix and name fields", async () => {
  const names: string[] = [];
  await parseTar(
    streamOf(
      tarHeader("file.rlib", 0, "0", "self-contained"),
      new Uint8Array(1024),
    ),
    (file) => names.push(file.name),
  );

  if (names[0] !== "self-contained/file.rlib") {
    throw new Error(`unexpected prefixed name: ${names[0]}`);
  }
});

Deno.test("parseTar applies GNU LongLink names to the following entry", async () => {
  const longName = `${"a".repeat(120)}.rlib`;
  const longNameBytes = new TextEncoder().encode(`${longName}\0`);
  const longNameBlock = new Uint8Array(512);
  longNameBlock.set(longNameBytes);
  const names: string[] = [];

  await parseTar(
    streamOf(
      tarHeader("././@LongLink", longNameBytes.length, "L"),
      longNameBlock,
      tarHeader("truncated", 0),
      new Uint8Array(1024),
    ),
    (file) => names.push(file.name),
  );

  if (names.length !== 1 || names[0] !== longName) {
    throw new Error(`unexpected LongLink names: ${names.join(",")}`);
  }
});
