import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../crates/vfs-shell/src/main.rs", import.meta.url), "utf8");

if (!source.includes("fn special_key_bytes")) {
  throw new Error("vfs-shell must translate custom key codes to ANSI bytes for child stdin");
}

for (const seq of ["\\x1b[A", "\\x1b[B", "\\x1b[C", "\\x1b[D", "\\x1b[H", "\\x1b[F", "\\x1b[3~"]) {
  if (!source.includes(seq)) {
    throw new Error(`vfs-shell special key translation is missing ${seq}`);
  }
}

if (!source.includes("KeyEvent::Left") || !source.includes("KeyEvent::Right")) {
  throw new Error("TerminalEchoHandler must handle left/right key events explicitly");
}

const handlerStart = source.indexOf("impl<'a> KeyEventHandler for TerminalEchoHandler<'a>");
const handlerEnd = source.indexOf("// ============================================================", handlerStart);
const handler = source.slice(handlerStart, handlerEnd);

if (handler.includes("\\x1b[1C") || handler.includes("\\x1b[1D")) {
  throw new Error("TerminalEchoHandler must not move one column for grapheme left/right events");
}

if (!handler.includes("self.needs_redraw = true")) {
  throw new Error("TerminalEchoHandler must force redraw for width-sensitive cursor movement");
}
