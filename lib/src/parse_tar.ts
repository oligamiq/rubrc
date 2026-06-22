import type { TarFileItem } from "nanotar";

// https://github.com/unjs/nanotar/blob/c1247bdec97163b487c8ca55003e291dfea755ab/src/parse.ts
// MIT License

// Copyright (c) Pooya Parsa <pooya@pi0.io>

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export async function parseTar(
  readable_stream: ReadableStream<Uint8Array>,
  callback: (file: TarFileItem) => void,
) {
  const reader = readable_stream.getReader();

  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }

  const buffer = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  chunks.length = 0;

  let offset = 0;
  let nextLongName: string | undefined;

  while (true) {
    if (offset === buffer.length) {
      break;
    }
    if (buffer.length - offset < 512) {
      throw new Error("Truncated tar header");
    }

    // File name (offset: 0 - length: 100)
    let name = _readString(buffer, offset, 100);
    if (name.length === 0) {
      break;
    }

    // File mode (offset: 100 - length: 8)
    const mode = _readString(buffer, offset + 100, 8);

    // File uid (offset: 108 - length: 8)
    const uid = _readNumber(buffer, offset + 108, 8);

    // File gid (offset: 116 - length: 8)
    const gid = _readNumber(buffer, offset + 116, 8);

    // File size (offset: 124 - length: 12)
    const size = _readNumber(buffer, offset + 124, 12);

    // File mtime (offset: 136 - length: 12)
    const mtime = _readNumber(buffer, offset + 136, 12);

    // File type (offset: 156 - length: 1)
    const _type = String.fromCharCode(buffer[offset + 156] ?? 0);
    const type = _type === "\0" || _type === "0"
      ? "file"
      : _type === "5"
      ? "directory"
      : _type; // prettier-ignore

    // Ustar prefix (offset: 345 - length: 155)
    const prefix = _readString(buffer, offset + 345, 155);
    if (nextLongName !== undefined) {
      name = nextLongName;
      nextLongName = undefined;
    } else if (prefix.length !== 0) {
      name = `${prefix}/${name}`;
    }

    // Ustar version (offset: 263 - length: 2)
    // Ignore

    // File owner user (offset: 265 - length: 32)
    const user = _readString(buffer, offset + 265, 32);

    // File owner group (offset: 297 - length: 32)
    const group = _readString(buffer, offset + 297, 32);

    // File data (offset: 512 - length: size)
    if (buffer.length - offset < 512 + size) {
      throw new Error(`Truncated tar entry: ${name}`);
    }

    const data = buffer.subarray(offset + 512, offset + 512 + size);

    let adjusted_size = 512 + 512 * Math.trunc(size / 512);
    if (size % 512) {
      adjusted_size += 512;
    }

    if (buffer.length - offset < adjusted_size) {
      throw new Error(`Truncated tar padding: ${name}`);
    }

    if (_type === "L") {
      nextLongName = new TextDecoder().decode(data).replace(/\0.*$/s, "");
      offset += adjusted_size;
      continue;
    }

    if (_type === "x" || _type === "g") {
      offset += adjusted_size;
      continue;
    }

    const file = {
      name,
      type,
      size,
      data,
      get text() {
        return new TextDecoder().decode(this.data);
      },
      attrs: {
        mode,
        uid,
        gid,
        mtime,
        user,
        group,
      },
    };

    callback(file);

    offset += adjusted_size;
  }
}

function _readString(buffer: Uint8Array, offset: number, size: number) {
  const view = buffer.slice(offset, offset + size);
  const i = view.indexOf(0);
  const td = new TextDecoder();
  return td.decode(view.slice(0, i === -1 ? undefined : i));
}

function _readNumber(buffer: Uint8Array, offset: number, size: number) {
  const value = _readString(buffer, offset, size).trim();
  if (value === "") {
    return 0;
  }
  const parsed = Number.parseInt(value, 8);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid tar numeric field: ${value}`);
  }
  return parsed;
}
