// npx ts-node test_run.ts

import { ConsoleStdout, Fd, File, OpenFile } from "@bjorn3/browser_wasi_shim";
import { WASIFarm, wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";

import { set_fake_worker } from "./common.ts";

await set_fake_worker();

const isNode =
	(typeof process !== "undefined" && !!process.versions?.node) ||
	(typeof Deno !== "undefined");

let farm: WASIFarm;
if (!isNode) {
    await import("@xterm/xterm/css/xterm.css");
    const { FitAddon } = await import("xterm-addon-fit");
    const { Terminal } = await import("@xterm/xterm");

    wait_async_polyfill();

	const term = new Terminal({
		convertEol: true,
	});
	const terminalElement = document.getElementById("terminal");

	if (!terminalElement) {
		throw new Error("No terminal element found");
	}

	term.open(terminalElement);

	const fitAddon = new FitAddon();
	term.loadAddon(fitAddon);
	fitAddon.fit();

	class XtermStdio extends Fd {
		term: Terminal;

		constructor(term: Terminal) {
			super();
			this.term = term;
		}
		fd_write(data: Uint8Array) /*: {ret: number, nwritten: number}*/ {
			const str = new TextDecoder().decode(data);
			this.term.write(str);
			console.log(str);
			return { ret: 0, nwritten: data.byteLength };
		}
	}

	farm = new WASIFarm(
		new XtermStdio(term),
		new XtermStdio(term),
		new XtermStdio(term),
		[],
	);

	const worker = new Worker("./worker.ts", { type: "module" });

	worker.postMessage({
		wasi_ref: farm.get_ref(),
	});

	worker.onmessage = (e) => {
		if (e.data.type === 'exit') {
			if (globalThis.process?.exit) {
				globalThis.process.exit(e.data.code);
			} else if (globalThis.Deno?.exit) {
				globalThis.Deno.exit(e.data.code);
			}
		}
	};
} else {
	farm = new WASIFarm(
		new OpenFile(new File([])), // stdin
		ConsoleStdout.lineBuffered((msg) => console.log(`[WASI stdout] ${msg}`)),
		ConsoleStdout.lineBuffered((msg) => console.warn(`[WASI stderr] ${msg}`)),
		[],
	);

	const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

	worker.postMessage({
        wasi_ref: farm.get_ref(),
	});

	if (typeof worker.on === "function") {
		worker.on("error", (err: any) => {
			console.error("Worker error:", err);
			if (globalThis.process?.exit) {
				globalThis.process.exit(1);
			} else if (globalThis.Deno?.exit) {
				globalThis.Deno.exit(1);
			}
		});
		worker.on("message", (e: any) => {
			if (e && e.type === 'exit') {
				if (globalThis.process?.exit) {
					globalThis.process.exit(e.code);
				} else if (globalThis.Deno?.exit) {
					globalThis.Deno.exit(e.code);
				}
			}
		});
	} else {
		worker.onerror = (err: any) => {
			console.error("Worker error:", err);
			if (globalThis.process?.exit) {
				globalThis.process.exit(1);
			} else if (globalThis.Deno?.exit) {
				globalThis.Deno.exit(1);
			}
		};
		worker.onmessage = (e: any) => {
			if (e.data && e.data.type === 'exit') {
				if (globalThis.process?.exit) {
					globalThis.process.exit(e.data.code);
				} else if (globalThis.Deno?.exit) {
					globalThis.Deno.exit(e.data.code);
				}
			}
		};
	}
}