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

  let buffer = new Uint8Array(0);
  let done = false;

  const check_stream = async () => {
    const { done: _done, value } = await reader.read();

    if (value) {
      const new_buffer = new Uint8Array(buffer.length + value.length);

      new_buffer.set(buffer);
      new_buffer.set(value, buffer.length);

      buffer = new_buffer;
    }

    done = _done;
  };

  while (true) {
    while (buffer.length < 512 && !done) {
      await check_stream();
    }

    // File name (offset: 0 - length: 100)
    const name = _readString(buffer, 0, 100);
    if (name.length === 0) {
      break;
    }

    // File mode (offset: 100 - length: 8)
    const mode = _readString(buffer, 100, 8);

    // File uid (offset: 108 - length: 8)
    const uid = Number.parseInt(_readString(buffer, 108, 8));

    // File gid (offset: 116 - length: 8)
    const gid = Number.parseInt(_readString(buffer, 116, 8));

    // File size (offset: 124 - length: 12)
    const size = _readNumber(buffer, 124, 12);

    // File mtime (offset: 136 - length: 12)
    const mtime = _readNumber(buffer, 136, 12);

    // File type (offset: 156 - length: 1)
    const _type = _readNumber(buffer, 156, 1);
    const type = _type === 0 ? "file" : _type === 5 ? "directory" : _type; // prettier-ignore

    // Ustar indicator (offset: 257 - length: 6)
    // Ignore

    // Ustar version (offset: 263 - length: 2)
    // Ignore

    // File owner user (offset: 265 - length: 32)
    const user = _readString(buffer, 265, 32);

    // File owner group (offset: 297 - length: 32)
    const group = _readString(buffer, 297, 32);

    // File data (offset: 512 - length: size)
    while (buffer.length < 512 + size) {
      await check_stream();
    }

    const data = buffer.slice(512, 512 + size);

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

    let adjusted_size = 512 + 512 * Math.trunc(size / 512);
    if (size % 512) {
      adjusted_size += 512;
    }

    while (buffer.length < adjusted_size && !done) {
      await check_stream();
    }

    if (done && buffer.length < adjusted_size) {
      break;
    }

    buffer = buffer.slice(adjusted_size);
  }
}

function _readString(buffer: Uint8Array, offset: number, size: number) {
  const view = buffer.slice(offset, offset + size);
  const i = view.indexOf(0);
  const td = new TextDecoder();
  return td.decode(view.slice(0, i));
}

function _readNumber(buffer: Uint8Array, offset: number, size: number) {
  const view = buffer.slice(offset, offset + size);
  let str = "";
  for (let i = 0; i < size; i++) {
    str += String.fromCodePoint(view[i]);
  }
  return Number.parseInt(str, 8);
}
