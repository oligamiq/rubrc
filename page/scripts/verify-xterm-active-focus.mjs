import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/xterm.tsx", import.meta.url), "utf8");
const lines = source.split("\n");

const startLine = lines.findIndex((line) => line.includes("createEffect(on(() => props.isActive"));
const endLine = lines.findIndex((line, index) => index > startLine && line.includes("{ defer: true }));"));

if (startLine === -1 || endLine === -1) {
  throw new Error("Could not find the props.isActive effect in page/src/xterm.tsx");
}

const body = lines.slice(startLine, endLine + 1).join("\n");
const fitIndex = body.indexOf("fit_addon.fit()");
const terminalCaptureIndex = body.indexOf("const terminal = xterm");
const focusIndex = body.indexOf("terminal.focus()");
const resizeIndex = body.indexOf("resize_fn(");
const cleanupIndex = body.indexOf("onCleanup(");
const clearTimeoutIndex = body.indexOf("window.clearTimeout(");
const deferIndex = body.indexOf("{ defer: true }");

if (!source.includes("import { createEffect, on, onCleanup } from \"solid-js\";")) {
  throw new Error("page/src/xterm.tsx must import onCleanup from solid-js");
}

if (fitIndex === -1) {
  throw new Error("The active terminal effect no longer fits the xterm instance");
}

if (terminalCaptureIndex === -1) {
  throw new Error("The active terminal effect must capture the xterm instance before deferring focus");
}

if (focusIndex === -1) {
  throw new Error("The active terminal effect must focus xterm so paste targets the active session");
}

if (resizeIndex === -1) {
  throw new Error("The active terminal effect no longer reports terminal size");
}

if (!(terminalCaptureIndex < fitIndex && fitIndex < focusIndex && focusIndex < resizeIndex)) {
  throw new Error("The active terminal effect should fit, focus, then report terminal size");
}

if (cleanupIndex === -1 || clearTimeoutIndex === -1) {
  throw new Error("The active terminal effect must clear its deferred focus timer on cleanup");
}

if (!(resizeIndex < cleanupIndex && cleanupIndex < clearTimeoutIndex)) {
  throw new Error("The active terminal effect should register cleanup after scheduling the focus timer");
}

if (deferIndex === -1) {
  throw new Error("The active terminal effect should be deferred to avoid mount-time focus churn");
}
