import { SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";

let ctx: Ctx;
let cmd_parser: (...string) => void;
let waiter: {
  is_all_done: () => boolean;
  is_cmd_run_end: () => boolean;
};
let terminal: (string) => void;

export const compile_and_run_setup = (_ctx: Ctx) => {
  ctx = _ctx;

  waiter = new SharedObjectRef(ctx.waiter_id).proxy<{
    is_all_done: () => boolean;
    is_cmd_run_end: () => boolean;
  }>();
}

let can_setup = false;

export const compile_and_run = async () => {
  if (!can_setup) {
    if (await waiter.is_all_done()) {
      terminal = new SharedObjectRef(ctx.terminal_id).proxy<(string) => void>();

      cmd_parser = new SharedObjectRef(ctx.cmd_parser_id).proxy<
        (...string) => void
      >();
      can_setup = true;
    } else {
      terminal = new SharedObjectRef(ctx.terminal_id).proxy<(string) => void>();

      await terminal("this is not done yet\r\n");
    }
  }

  if (can_setup) {
    const exec = ["rustc", "/main.rs", "--sysroot", "/sysroot", "--target", "wasm32-wasip1", "--out-dir", "/tmp", "-Ccodegen-units=1"];
    await terminal(`${exec.join(" ")}\r\n`);
    await cmd_parser(...exec);
    while (!await waiter.is_cmd_run_end()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await terminal("/tmp/main.wasm\r\n");
    await cmd_parser("/tmp/main.wasm");
    while (!await waiter.is_cmd_run_end()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
