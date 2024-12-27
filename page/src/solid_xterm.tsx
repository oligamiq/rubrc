// solid-xterm's code fork
// https://github.com/WVAviator/solid-xterm

import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  type ITerminalAddon,
  type ITerminalInitOnlyOptions,
  type ITerminalOptions,
  Terminal,
} from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export type OnMountCleanup = () => void | (() => Promise<void>) | undefined;

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export type ITerminalAddonConstructor = new (...args: any[]) => ITerminalAddon;
export interface XTermProps {
  /**
   * The CSS classes that will be applied to the terminal container.
   */
  class?: string;

  /**
   * A set of options for the terminal that will be provided on loading.
   * A list of all available properties can be found at https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
   */
  options?: ITerminalOptions & ITerminalInitOnlyOptions;

  /**
   * An array of addons that will be loaded into XTerm. Addons can be passed as either an instance or a constructor.
   * @see https://xtermjs.org/docs/api/addons/
   * @example
   * ```tsx
   * import { SearchAddon } from 'xterm-addon-search';
   * import { FitAddon } from 'xterm-addon-fit';
   *
   * ...
   *
   * const searchAddon = createMemo(() => new SearchAddon());
   *
   * <XTerm addons={[searchAddon(), FitAddon]} />
   * ```
   */
  addons?: (ITerminalAddonConstructor | ITerminalAddon)[];

  /**
   * On mount, this callback will be called with the terminal instance.
   * @param terminal The terminal object emitting the event.
   * @returns A function that will be called when the component is unmounted.
   */
  onMount?: (terminal: Terminal) => OnMountCleanup | Promise<OnMountCleanup>;

  /**
   * A callback that will be called when the bell is triggered.
   * @param terminal The terminal object emitting the event.
   */
  onBell?: (terminal: Terminal) => void;

  /**
   * A callback that will be called when a binary event fires. This is used to enable non UTF-8 conformant binary messages to be sent to the backend. Currently this is only used for a certain type of mouse reports that happen to be not UTF-8 compatible. The event value is a JS string, pass it to the underlying pty as binary data, e.g. `pty.write(Buffer.from(data, 'binary'))`.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onbinary
   * @param data
   * @param terminal The terminal object emitting the event.
   */
  onBinary?: (data: string, terminal: Terminal) => void;

  /**
   * A callback that will be called when the cursor moves.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#oncursormove
   * @param cursorPosition An object containing x and y properties representing the new cursor position.
   * @param terminal The terminal object emitting the event.
   */
  onCursorMove?: (
    cursorPosition: { x: number; y: number },
    terminal: Terminal,
  ) => void;

  /**
   * A callback that will be called when a data event fires. This happens for example when the user types or pastes into the terminal. The event value is whatever string results, in a typical setup, this should be passed on to the backing pty.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#ondata
   * @param data
   * @param terminal The terminal object emitting the event.
   */
  onData?: (data: string, terminal: Terminal) => void;

  /**
   * A callback that will be called when a key is pressed. The event value contains the string that will be sent in the data event as well as the DOM event that triggered it.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onkey
   * @param event An object containing a key property representing the string sent to the data event, and a domEvent property containing the DOM event that triggered the keypress.
   * @param terminal The terminal object emitting the event.
   */
  onKey?: (
    event: { key: string; domEvent: KeyboardEvent },
    terminal: Terminal,
  ) => void;

  /**
   * A callback that will be called when a line feed is added.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onlinefeed
   * @param terminal The terminal object emitting the event.
   */
  onLineFeed?: (terminal: Terminal) => void;

  /**
   * A callback that will be called when rows are rendered. The event value contains the start row and end rows of the rendered area (ranges from 0 to Terminal.rows - 1).
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onrender
   * @param event An object containing start and end properties which represent the start and end rows (inclusive) of the rendered area.
   * @param terminal The terminal object emitting the event.
   */
  onRender?: (
    event: { start: number; end: number },
    terminal: Terminal,
  ) => void;

  /**
   * A callback that will be called when the terminal is resized.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onresize
   * @param size An object containing cols and rows properties representing the new size.
   * @param terminal The terminal object emitting the event.
   */
  onResize?: (size: { cols: number; rows: number }, terminal: Terminal) => void;

  /**
   * A callback that will be called when a scroll occurs.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onscroll
   * @param yPos The new y-position of the viewport.
   * @param terminal The terminal object emitting the event.
   */
  onScroll?: (yPos: number, terminal: Terminal) => void;

  /**
   * A callback that will be called when a selection change occurs.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onselectionchange
   * @param terminal The terminal object emitting the event.
   */
  onSelectionChange?: (terminal: Terminal) => void;

  /**
   * A callback that will be called when an OSC 0 or OSC 2 title change occurs.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#ontitlechange
   * @param title The new title.
   * @param terminal The terminal object emitting the event.
   */
  onTitleChange?: (title: string, terminal: Terminal) => void;

  /**
   * A callback that will be called when data has been parsed by the terminal, after write is called. This event is useful to listen for any changes in the buffer.
   * This fires at most once per frame, after data parsing completes. Note that this can fire when there are still writes pending if there is a lot of data.
   * @see https://xtermjs.org/docs/api/terminal/classes/terminal/#onwriteparsed
   * @param terminal The terminal object emitting the event.
   */
  onWriteParsed?: (terminal: Terminal) => void;
}

const XTerm = ({
  class: className = "",
  options = {},
  addons = [],
  onMount,
  onBell,
  onBinary,
  onCursorMove,
  onData,
  onKey,
  onLineFeed,
  onRender,
  onResize,
  onScroll,
  onSelectionChange,
  onTitleChange,
  onWriteParsed,
}: XTermProps) => {
  const [terminal, setTerminal] = createSignal<Terminal | undefined>();

  const handleRef = (terminalContainerRef: HTMLDivElement) => {
    const newTerminal = new Terminal(options);
    newTerminal.open(terminalContainerRef);

    // biome-ignore lint/complexity/noForEach: <explanation>
    addons.forEach((addon) => {
      if (typeof addon === "function") {
        newTerminal?.loadAddon(new addon());
      } else {
        newTerminal?.loadAddon(addon);
      }
    });

    setTerminal(newTerminal);
  };

  onCleanup(() => {
    const currentTerminal = terminal();
    if (!currentTerminal) return;
    currentTerminal.dispose();
    setTerminal(undefined);
  });

  createEffect(async () => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onMount) return;
    const onMountCleanup = await onMount(currentTerminal);
    onCleanup(() => {
      onMountCleanup();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onBell) return;
    const onBellListener = currentTerminal.onBell(() =>
      onBell(currentTerminal),
    );
    onCleanup(() => {
      onBellListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onBinary) return;
    const onBinaryListener = currentTerminal.onBinary((data) =>
      onBinary(data, currentTerminal),
    );
    onCleanup(() => {
      onBinaryListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onCursorMove) return;
    const onCursorMoveListener = currentTerminal.onCursorMove(() => {
      if (!currentTerminal) return;
      const cursorX = currentTerminal.buffer.active.cursorX;
      const cursorY = currentTerminal.buffer.active.cursorY;
      const cursorPosition = { x: cursorX, y: cursorY };
      onCursorMove(cursorPosition, currentTerminal);
    });
    onCleanup(() => {
      onCursorMoveListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onData) return;
    const onDataListener = currentTerminal.onData((data) =>
      onData(data, currentTerminal),
    );
    onCleanup(() => {
      onDataListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onKey) return;
    const onKeyListener = currentTerminal.onKey((event) =>
      onKey(event, currentTerminal),
    );
    onCleanup(() => {
      onKeyListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onLineFeed) return;
    const onLineFeedListener = currentTerminal.onLineFeed(() =>
      onLineFeed(currentTerminal),
    );
    onCleanup(() => {
      onLineFeedListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onRender) return;
    const onRenderListener = currentTerminal.onRender((event) =>
      onRender(event, currentTerminal),
    );
    onCleanup(() => {
      onRenderListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onResize) return;
    const onResizeListener = currentTerminal.onResize((size) =>
      onResize(size, currentTerminal),
    );
    onCleanup(() => {
      onResizeListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onScroll) return;
    const onScrollListener = currentTerminal.onScroll((yPos) =>
      onScroll(yPos, currentTerminal),
    );
    onCleanup(() => {
      onScrollListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onSelectionChange) return;
    const onSelectionChangeListener = currentTerminal.onSelectionChange(() =>
      onSelectionChange(currentTerminal),
    );
    onCleanup(() => {
      onSelectionChangeListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onTitleChange) return;
    const onTitleChangeListener = currentTerminal.onTitleChange((title) =>
      onTitleChange(title, currentTerminal),
    );
    onCleanup(() => {
      onTitleChangeListener.dispose();
    });
  });

  createEffect(() => {
    const currentTerminal = terminal();
    if (!currentTerminal || !onWriteParsed) return;
    const onWriteParsedListener = currentTerminal.onWriteParsed(() =>
      onWriteParsed(currentTerminal),
    );
    onCleanup(() => {
      onWriteParsedListener.dispose();
    });
  });

  return <div id="term-wrapper" class={className} ref={handleRef} />;
};

export default XTerm;
