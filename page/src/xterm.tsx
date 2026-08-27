import { createEffect, on, onCleanup } from "solid-js";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import XTerm from "./solid_xterm";
import { isTouchCapableDevice } from "./mobile_terminal_gestures";
import type { AppRuntime } from "./app_runtime.ts";

export type RuntimeTerminalBinding = Pick<
  AppRuntime,
  | "attachTerminal"
  | "resizeTerminal"
  | "inputTerminal"
  | "interruptTerminal"
>;

export type SetupMyTerminalProps = {
  runtime: RuntimeTerminalBinding;
  sessionId: number;
  isActive: boolean;
};

export const SetupMyTerminal = (props: SetupMyTerminalProps) => {
  let xterm: Terminal | undefined;
  const fitAddon = new FitAddon();

  const report = (operation: Promise<void>) => {
    void operation.catch(console.error);
  };

  createEffect(
    on(
      () => props.isActive,
      (active) => {
        if (!active || !xterm) return;
        const terminal = xterm;
        const timeout = window.setTimeout(() => {
          fitAddon.fit();
          if (!isTouchCapableDevice()) terminal.focus();
          report(
            props.runtime.resizeTerminal(
              props.sessionId,
              terminal.cols,
              terminal.rows,
            ),
          );
        }, 0);
        onCleanup(() => window.clearTimeout(timeout));
      },
      { defer: true },
    ),
  );

  const handleMount = (terminal: Terminal) => {
    xterm = terminal;
    const attachment = props.runtime.attachTerminal(props.sessionId, {
      write: (value) => terminal.write(value.replace(/\n/g, "\r\n")),
      size: () => ({ cols: terminal.cols, rows: terminal.rows }),
    });

    fitAddon.fit();
    report(
      props.runtime.resizeTerminal(
        props.sessionId,
        terminal.cols,
        terminal.rows,
      ),
    );

    const onWindowResize = () => {
      fitAddon.fit();
      report(
        props.runtime.resizeTerminal(
          props.sessionId,
          terminal.cols,
          terminal.rows,
        ),
      );
    };
    window.addEventListener("resize", onWindowResize);

    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "v" || event.code === "KeyV")
      ) {
        return false;
      }
      if (
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "c" || event.code === "KeyC") &&
        terminal.hasSelection()
      ) {
        return false;
      }
      return true;
    });

    if (props.isActive && !isTouchCapableDevice()) terminal.focus();

    return () => {
      attachment.dispose();
      if (xterm === terminal) xterm = undefined;
      window.removeEventListener("resize", onWindowResize);
    };
  };

  const onData = (data: string) => {
    const keyMap: Record<string, number> = {
      "\x1b[A": 0x110001,
      "\x1bOA": 0x110001,
      "\x1b[B": 0x110002,
      "\x1bOB": 0x110002,
      "\x1b[C": 0x110003,
      "\x1bOC": 0x110003,
      "\x1b[D": 0x110004,
      "\x1bOD": 0x110004,
      "\x1b[H": 0x110005,
      "\x1bOH": 0x110005,
      "\x1b[1~": 0x110005,
      "\x1b[F": 0x110006,
      "\x1bOF": 0x110006,
      "\x1b[4~": 0x110006,
      "\x1b[3~": 0x110007,
    };
    const mapped = keyMap[data];
    if (mapped !== undefined) {
      report(props.runtime.inputTerminal(props.sessionId, mapped));
      return;
    }
    if (data.length > 1) {
      report(props.runtime.inputTerminal(props.sessionId, data));
      return;
    }
    for (let index = 0; index < data.length; index++) {
      const codePoint = data.codePointAt(index);
      if (codePoint === undefined) continue;
      if (codePoint === 3) {
        report(props.runtime.interruptTerminal(props.sessionId));
      } else {
        report(props.runtime.inputTerminal(props.sessionId, codePoint));
      }
      if (codePoint > 0xffff) index++;
    }
  };

  const onResize = (size: { cols: number; rows: number }) => {
    report(
      props.runtime.resizeTerminal(props.sessionId, size.cols, size.rows),
    );
  };

  return (
    <XTerm
      onMount={handleMount}
      onData={onData}
      onResize={onResize}
      addons={[fitAddon]}
      options={{ scrollSensitivity: isTouchCapableDevice() ? 8 : 1 }}
      class="w-full h-full"
    />
  );
};
