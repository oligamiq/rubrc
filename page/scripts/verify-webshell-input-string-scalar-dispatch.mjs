import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/worker_process/util_cmd.ts", import.meta.url), "utf8");
const xtermSource = readFileSync(new URL("../src/xterm.tsx", import.meta.url), "utf8");

const handlerStart = source.indexOf("new SharedObject(({ sessionId, data }: { sessionId: number, data: string }) =>");
if (handlerStart === -1) {
  throw new Error("Could not find the input_string SharedObject handler");
}

const handlerEnd = source.indexOf("}, ctx.input_string_id)", handlerStart);
if (handlerEnd === -1) {
  throw new Error("Could not find the end of the input_string SharedObject handler");
}

const handler = source.slice(handlerStart, handlerEnd);
const normalBranchIndex = handler.indexOf("sessionId !== LSP_SESSION_ID && sessionId !== 0xEEEEEEEE");
const encoderIndex = handler.indexOf("new TextEncoder().encode(data)");

if (normalBranchIndex === -1) {
  throw new Error("Normal WebShell input_string must be handled separately from LSP and WRITE_FILE");
}

if (encoderIndex === -1) {
  throw new Error("LSP and WRITE_FILE input_string paths must still encode string data");
}

if (normalBranchIndex > encoderIndex) {
  throw new Error("Normal WebShell input_string must avoid pointer-based TextEncoder transfer");
}

const normalBranch = handler.slice(normalBranchIndex, encoderIndex);

if (!normalBranch.includes("for (const char of data)")) {
  throw new Error("Normal WebShell input_string must dispatch each pasted character as a scalar event");
}

if (!normalBranch.includes("const codePoint = char.codePointAt(0)")) {
  throw new Error("Normal WebShell input_string must extract each character code point");
}

if (!normalBranch.includes("codePoint !== undefined")) {
  throw new Error("Normal WebShell input_string must guard against undefined code points");
}

if (!normalBranch.includes("vfs_root.dispatch(sessionId, 0, codePoint, 0)")) {
  throw new Error("Normal WebShell input_string must use InputChar event type 0 for each character");
}

if (!normalBranch.includes("return;")) {
  throw new Error("Normal WebShell input_string must return before pointer-based dispatch");
}

if (!xtermSource.includes("0x110001")) {
  throw new Error("Special key codes must be above the Unicode scalar range");
}

if (!xtermSource.includes("data.codePointAt(i)")) {
  throw new Error("Single-character xterm input must use codePointAt for Unicode input");
}

if (!xtermSource.includes("codePoint > 0xffff")) {
  throw new Error("Single-character xterm input must skip low surrogates after non-BMP code points");
}
