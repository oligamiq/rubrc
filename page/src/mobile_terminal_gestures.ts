import type { Terminal } from "@xterm/xterm";

const LONG_PRESS_MS = 650;
const LONG_PRESS_MOVE_TOLERANCE_PX = 4;
const SCROLL_START_DISTANCE_PX = 8;
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_DISTANCE_PX = 6;
const COMPATIBILITY_EVENT_BLOCK_MS = 1200;
const KEYBOARD_FOCUS_SUPPRESSION_MS = 1200;
const KEYBOARD_VIEWPORT_DELTA_PX = 120;

type GestureMode = "idle" | "pending" | "scrolling" | "selecting";

interface GesturePoint {
  id: number;
  clientX: number;
  clientY: number;
}

interface CellPosition {
  column: number;
  row: number;
}

export const isTouchCapableDevice = (): boolean => {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined"
  ) {
    return false;
  }

  return navigator.maxTouchPoints > 0 || "ontouchstart" in window;
};

const copyText = async (text: string): Promise<void> => {
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // HTTPSでない場合などは従来方式へフォールバックする。
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";

  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
};

export const installMobileTerminalGestures = (
  container: HTMLDivElement,
  terminal: Terminal,
): (() => void) => {
  if (!isTouchCapableDevice()) {
    return () => {};
  }

  const getScreen = () =>
    container.querySelector<HTMLElement>(".xterm-screen");
  const getViewport = () =>
    container.querySelector<HTMLElement>(".xterm-viewport");

  const usePointerEvents = "PointerEvent" in window;

  /*
   * ブラウザーのパン・長押し選択を無効化し、このモジュールだけで
   * タップ、スクロール、長押しを判定する。
   */
  const previousTouchAction = container.style.touchAction;
  const previousUserSelect = container.style.userSelect;
  const previousWebkitUserSelect = container.style.webkitUserSelect;
  const previousWebkitTouchCallout = container.style.getPropertyValue(
    "-webkit-touch-callout",
  );

  container.style.touchAction = "none";
  container.style.userSelect = "none";
  container.style.webkitUserSelect = "none";
  container.style.setProperty("-webkit-touch-callout", "none");

  let activeId: number | undefined;
  let gestureMode: GestureMode = "idle";
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let startedAt = 0;
  let maxDistanceFromStart = 0;
  let scrollTopAtStart = 0;
  let scrolledDuringGesture = false;
  let keyboardWasOpenAtStart = false;
  let suppressKeyboardFocusUntil = 0;
  let largestVisualViewportHeight =
    window.visualViewport?.height ?? window.innerHeight;
  let selectionAnchor: CellPosition | undefined;
  let longPressTimer: number | undefined;
  let suppressCompatibilityEventsUntil = 0;
  let copyButton: HTMLButtonElement | undefined;

  const cancelEvent = (event: Event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopImmediatePropagation();
  };

  const updateLargestVisualViewportHeight = () => {
    const height = window.visualViewport?.height ?? window.innerHeight;

    /*
     * キーボードが閉じている可能性が高いときだけ基準値を更新する。
     * textareaがフォーカス中の縮んだviewportを基準値にしない。
     */
    if (document.activeElement !== terminal.textarea) {
      largestVisualViewportHeight = Math.max(
        largestVisualViewportHeight,
        height,
      );
    }
  };

  const isSoftwareKeyboardOpen = (): boolean => {
    const virtualKeyboard = (navigator as Navigator & {
      virtualKeyboard?: { boundingRect?: DOMRectReadOnly };
    }).virtualKeyboard;

    if ((virtualKeyboard?.boundingRect?.height ?? 0) > 0) {
      return true;
    }

    const textareaFocused =
      terminal.textarea !== undefined &&
      document.activeElement === terminal.textarea;

    if (!textareaFocused) {
      return false;
    }

    const currentHeight =
      window.visualViewport?.height ?? window.innerHeight;

    return (
      largestVisualViewportHeight - currentHeight >=
      KEYBOARD_VIEWPORT_DELTA_PX
    );
  };

  const blurTerminalIfKeyboardMustStayClosed = () => {
    if (performance.now() >= suppressKeyboardFocusUntil) {
      return;
    }

    if (document.activeElement === terminal.textarea) {
      terminal.blur();
    }
  };

  const handleFocusIn = (event: FocusEvent) => {
    if (
      performance.now() < suppressKeyboardFocusUntil &&
      event.target === terminal.textarea
    ) {
      terminal.blur();
    }
  };

  const clearLongPressTimer = () => {
    if (longPressTimer === undefined) {
      return;
    }
    window.clearTimeout(longPressTimer);
    longPressTimer = undefined;
  };

  const removeCopyButton = () => {
    copyButton?.remove();
    copyButton = undefined;
  };

  const clientPointToCell = (
    clientX: number,
    clientY: number,
  ): CellPosition | undefined => {
    const screen = getScreen();
    if (!screen) {
      return undefined;
    }

    const rect = screen.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return undefined;
    }

    const relativeX = Math.max(
      0,
      Math.min(rect.width - 1, clientX - rect.left),
    );
    const relativeY = Math.max(
      0,
      Math.min(rect.height - 1, clientY - rect.top),
    );

    return {
      column: Math.max(
        0,
        Math.min(
          terminal.cols - 1,
          Math.floor((relativeX / rect.width) * terminal.cols),
        ),
      ),
      row:
        terminal.buffer.active.viewportY +
        Math.max(
          0,
          Math.min(
            terminal.rows - 1,
            Math.floor((relativeY / rect.height) * terminal.rows),
          ),
        ),
    };
  };

  const selectWordAt = (clientX: number, clientY: number): boolean => {
    const position = clientPointToCell(clientX, clientY);
    if (!position) {
      return false;
    }

    const line = terminal.buffer.active.getLine(position.row);
    const text = line?.translateToString(true) ?? "";
    if (text.length === 0 || position.column >= text.length) {
      return false;
    }

    const cellText = line?.getCell(position.column)?.getChars() ?? "";
    if (cellText.length === 0 || /^\s+$/u.test(cellText)) {
      return false;
    }

    const separators =
      terminal.options.wordSeparator ?? " ()[]{}',\"`";
    const isSeparator = (character: string) =>
      separators.includes(character);

    if (isSeparator(text[position.column] ?? "")) {
      return false;
    }

    let start = position.column;
    let end = position.column + 1;

    while (start > 0 && !isSeparator(text[start - 1] ?? "")) {
      start--;
    }
    while (end < text.length && !isSeparator(text[end] ?? "")) {
      end++;
    }

    terminal.select(start, position.row, Math.max(1, end - start));
    selectionAnchor = { column: start, row: position.row };
    return terminal.hasSelection();
  };

  const extendSelectionTo = (clientX: number, clientY: number) => {
    if (!selectionAnchor) {
      return;
    }

    const current = clientPointToCell(clientX, clientY);
    if (!current) {
      return;
    }

    const anchorOffset =
      selectionAnchor.row * terminal.cols + selectionAnchor.column;
    const currentOffset = current.row * terminal.cols + current.column;
    const startOffset = Math.min(anchorOffset, currentOffset);
    const endOffset = Math.max(anchorOffset, currentOffset);

    terminal.select(
      startOffset % terminal.cols,
      Math.floor(startOffset / terminal.cols),
      Math.max(1, endOffset - startOffset + 1),
    );
  };

  const showCopyButton = (clientX: number, clientY: number) => {
    removeCopyButton();

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "コピー";
    button.setAttribute(
      "aria-label",
      "選択したターミナル文字列をコピー",
    );

    Object.assign(button.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: `${Math.max(
        8,
        Math.min(clientX - 32, window.innerWidth - 88),
      )}px`,
      top: `${Math.max(
        8,
        Math.min(clientY - 54, window.innerHeight - 48),
      )}px`,
      minWidth: "72px",
      minHeight: "40px",
      padding: "8px 12px",
      border: "1px solid rgba(255, 255, 255, 0.3)",
      borderRadius: "8px",
      background: "#202124",
      color: "#ffffff",
      fontSize: "14px",
      lineHeight: "20px",
      boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
    });

    button.addEventListener("click", async () => {
      try {
        await copyText(terminal.getSelection());
        button.textContent = "コピー済み";
      } catch (error) {
        console.error("Failed to copy terminal selection", error);
        button.textContent = "コピー失敗";
      }
      window.setTimeout(removeCopyButton, 500);
    });

    document.body.appendChild(button);
    copyButton = button;
  };

  const beginLongPress = () => {
    clearLongPressTimer();
    longPressTimer = window.setTimeout(() => {
      longPressTimer = undefined;
      if (
        activeId === undefined ||
        gestureMode !== "pending" ||
        maxDistanceFromStart > LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        return;
      }
      if (!selectWordAt(startX, startY)) {
        return;
      }
      gestureMode = "selecting";
      showCopyButton(startX, startY);
    }, LONG_PRESS_MS);
  };

  const startGesture = (point: GesturePoint) => {
    suppressCompatibilityEventsUntil =
      performance.now() + COMPATIBILITY_EVENT_BLOCK_MS;
    removeCopyButton();
    terminal.clearSelection();

    activeId = point.id;
    gestureMode = "pending";
    startX = point.clientX;
    startY = point.clientY;
    lastY = point.clientY;
    startedAt = performance.now();
    maxDistanceFromStart = 0;
    scrollTopAtStart = getViewport()?.scrollTop ?? 0;
    scrolledDuringGesture = false;
    keyboardWasOpenAtStart = isSoftwareKeyboardOpen();
    selectionAnchor = undefined;
    beginLongPress();
  };

  const moveGesture = (point: GesturePoint) => {
    if (activeId !== point.id) {
      return;
    }

    maxDistanceFromStart = Math.max(
      maxDistanceFromStart,
      Math.hypot(point.clientX - startX, point.clientY - startY),
    );

    if (maxDistanceFromStart > LONG_PRESS_MOVE_TOLERANCE_PX) {
      clearLongPressTimer();
    }

    if (gestureMode === "selecting") {
      extendSelectionTo(point.clientX, point.clientY);
      return;
    }

    if (
      gestureMode === "pending" &&
      maxDistanceFromStart >= SCROLL_START_DISTANCE_PX
    ) {
      gestureMode = "scrolling";
      terminal.clearSelection();

      const viewport = getViewport();
      if (!viewport) {
        return;
      }
      viewport.scrollTop += startY - point.clientY;
      scrolledDuringGesture = true;
      lastY = point.clientY;
      return;
    }

    if (gestureMode === "scrolling") {
      const viewport = getViewport();
      if (!viewport) {
        return;
      }
      viewport.scrollTop += lastY - point.clientY;
      scrolledDuringGesture = true;
      lastY = point.clientY;
    }
  };

  const finishGesture = (point: GesturePoint, cancelled: boolean) => {
    if (activeId !== point.id) {
      return;
    }

    clearLongPressTimer();

    // pointermoveが間引かれた場合でも、指を離した位置を含めて
    // 実際の移動距離を判定する。
    maxDistanceFromStart = Math.max(
      maxDistanceFromStart,
      Math.hypot(point.clientX - startX, point.clientY - startY),
    );

    const viewport = getViewport();
    const scrollTopChanged =
      viewport !== null &&
      Math.abs(viewport.scrollTop - scrollTopAtStart) >= 1;
    const didScroll =
      gestureMode === "scrolling" ||
      scrolledDuringGesture ||
      scrollTopChanged ||
      maxDistanceFromStart >= SCROLL_START_DISTANCE_PX;

    const elapsed = performance.now() - startedAt;
    const shouldOpenKeyboard =
      !cancelled &&
      !didScroll &&
      gestureMode === "pending" &&
      elapsed <= TAP_MAX_DURATION_MS &&
      maxDistanceFromStart <= TAP_MAX_DISTANCE_PX;

    suppressCompatibilityEventsUntil =
      performance.now() + COMPATIBILITY_EVENT_BLOCK_MS;

    if (didScroll && !keyboardWasOpenAtStart) {
      /*
       * pointerup後にxterm.jsやブラウザーが遅れてtextareaへ
       * フォーカスしても、スクロール操作ではキーボードを開かない。
       */
      suppressKeyboardFocusUntil =
        performance.now() + KEYBOARD_FOCUS_SUPPRESSION_MS;
      blurTerminalIfKeyboardMustStayClosed();
    } else if (shouldOpenKeyboard) {
      suppressKeyboardFocusUntil = 0;
    }

    activeId = undefined;
    gestureMode = "idle";
    startedAt = 0;
    maxDistanceFromStart = 0;
    scrollTopAtStart = 0;
    scrolledDuringGesture = false;
    keyboardWasOpenAtStart = false;
    selectionAnchor = undefined;

    if (shouldOpenKeyboard) {
      terminal.focus();
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (
      event.pointerType !== "touch" ||
      !event.isPrimary ||
      activeId !== undefined
    ) {
      return;
    }

    cancelEvent(event);
    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      // Pointer captureが利用できなくても継続する。
    }
    startGesture({
      id: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || activeId !== event.pointerId) {
      return;
    }
    cancelEvent(event);
    moveGesture({
      id: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  const finishPointer = (event: PointerEvent, cancelled: boolean) => {
    if (event.pointerType !== "touch" || activeId !== event.pointerId) {
      return;
    }

    cancelEvent(event);
    try {
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 既に解除済みの場合は無視する。
    }
    finishGesture(
      {
        id: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      },
      cancelled,
    );
  };

  const handlePointerUp = (event: PointerEvent) =>
    finishPointer(event, false);
  const handlePointerCancel = (event: PointerEvent) =>
    finishPointer(event, true);

  const findTouch = (
    touches: TouchList,
    identifier: number,
  ): Touch | undefined => {
    for (let index = 0; index < touches.length; index++) {
      const touch = touches.item(index);
      if (touch?.identifier === identifier) {
        return touch;
      }
    }
    return undefined;
  };

  const handleTouchStartFallback = (event: TouchEvent) => {
    if (activeId !== undefined || event.changedTouches.length !== 1) {
      return;
    }
    const touch = event.changedTouches.item(0);
    if (!touch) {
      return;
    }
    cancelEvent(event);
    startGesture({
      id: touch.identifier,
      clientX: touch.clientX,
      clientY: touch.clientY,
    });
  };

  const handleTouchMoveFallback = (event: TouchEvent) => {
    if (activeId === undefined) {
      return;
    }
    const touch = findTouch(event.touches, activeId);
    if (!touch) {
      return;
    }
    cancelEvent(event);
    moveGesture({
      id: touch.identifier,
      clientX: touch.clientX,
      clientY: touch.clientY,
    });
  };

  const finishTouchFallback = (
    event: TouchEvent,
    cancelled: boolean,
  ) => {
    if (activeId === undefined) {
      return;
    }
    const touch = findTouch(event.changedTouches, activeId);
    if (!touch) {
      return;
    }
    cancelEvent(event);
    finishGesture(
      {
        id: touch.identifier,
        clientX: touch.clientX,
        clientY: touch.clientY,
      },
      cancelled,
    );
  };

  const handleTouchEndFallback = (event: TouchEvent) =>
    finishTouchFallback(event, false);
  const handleTouchCancelFallback = (event: TouchEvent) =>
    finishTouchFallback(event, true);

  /* Pointer Events利用時にxterm.js側へTouch Eventsを渡さない。 */
  const handleTouchBlocker = (event: TouchEvent) => {
    cancelEvent(event);
  };

  const handleCompatibilityEvent = (event: Event) => {
    if (performance.now() < suppressCompatibilityEventsUntil) {
      cancelEvent(event);
    }
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (
      activeId !== undefined ||
      gestureMode !== "idle" ||
      performance.now() < suppressCompatibilityEventsUntil
    ) {
      cancelEvent(event);
    }
  };

  if (usePointerEvents) {
    container.addEventListener("pointerdown", handlePointerDown, true);
    container.addEventListener("pointermove", handlePointerMove, true);
    container.addEventListener("pointerup", handlePointerUp, true);
    container.addEventListener("pointercancel", handlePointerCancel, true);

    for (const type of [
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
    ] as const) {
      container.addEventListener(type, handleTouchBlocker, {
        capture: true,
        passive: false,
      });
    }
  } else {
    container.addEventListener("touchstart", handleTouchStartFallback, {
      capture: true,
      passive: false,
    });
    container.addEventListener("touchmove", handleTouchMoveFallback, {
      capture: true,
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEndFallback, {
      capture: true,
      passive: false,
    });
    container.addEventListener("touchcancel", handleTouchCancelFallback, {
      capture: true,
      passive: false,
    });
  }

  for (const type of ["mousedown", "mouseup", "click", "dblclick"] as const) {
    container.addEventListener(type, handleCompatibilityEvent, true);
  }
  container.addEventListener("contextmenu", handleContextMenu, true);
  container.addEventListener("focusin", handleFocusIn, true);
  window.visualViewport?.addEventListener(
    "resize",
    updateLargestVisualViewportHeight,
  );

  return () => {
    clearLongPressTimer();
    removeCopyButton();

    if (usePointerEvents) {
      container.removeEventListener("pointerdown", handlePointerDown, true);
      container.removeEventListener("pointermove", handlePointerMove, true);
      container.removeEventListener("pointerup", handlePointerUp, true);
      container.removeEventListener(
        "pointercancel",
        handlePointerCancel,
        true,
      );
      for (const type of [
        "touchstart",
        "touchmove",
        "touchend",
        "touchcancel",
      ] as const) {
        container.removeEventListener(type, handleTouchBlocker, true);
      }
    } else {
      container.removeEventListener(
        "touchstart",
        handleTouchStartFallback,
        true,
      );
      container.removeEventListener(
        "touchmove",
        handleTouchMoveFallback,
        true,
      );
      container.removeEventListener(
        "touchend",
        handleTouchEndFallback,
        true,
      );
      container.removeEventListener(
        "touchcancel",
        handleTouchCancelFallback,
        true,
      );
    }

    for (const type of [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
    ] as const) {
      container.removeEventListener(type, handleCompatibilityEvent, true);
    }
    container.removeEventListener("contextmenu", handleContextMenu, true);
    container.removeEventListener("focusin", handleFocusIn, true);
    window.visualViewport?.removeEventListener(
      "resize",
      updateLargestVisualViewportHeight,
    );

    container.style.touchAction = previousTouchAction;
    container.style.userSelect = previousUserSelect;
    container.style.webkitUserSelect = previousWebkitUserSelect;
    if (previousWebkitTouchCallout) {
      container.style.setProperty(
        "-webkit-touch-callout",
        previousWebkitTouchCallout,
      );
    } else {
      container.style.removeProperty("-webkit-touch-callout");
    }
  };
};
