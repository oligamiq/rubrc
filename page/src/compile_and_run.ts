import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";

let ctx: Ctx;
type TerminalProxy = (
  args: {
    sessionId: number;
    data: Uint8Array;
  },
) => Promise<void>;

let terminal: TerminalProxy;
let input_string: (args: {
  sessionId: number;
  data: string;
}) => Promise<void>;
let waiter: any;

const run_command = async (args: string[]) => {
  const line = args.join(" ");
  await input_string({
    sessionId: 0,
    data: `${line}\r`,
  });
};

export const compile_and_run_setup = (_ctx: Ctx) => {
  ctx = _ctx;

  waiter = new SharedObjectRef(ctx.waiter_id).proxy();

  input_string = new SharedObjectRef(ctx.input_string_id).proxy();
};

let can_setup = false;

export const compile_and_run = async (triple?: string) => {
  if (!can_setup) {
    if (await waiter.is_all_done()) {
      terminal = new SharedObjectRef(ctx.terminal_id).proxy();
      can_setup = true;
    } else {
      terminal = new SharedObjectRef(ctx.terminal_id).proxy();
      await terminal({
        sessionId: 0,
        data: new TextEncoder().encode("this is not done yet\r\n"),
      });
    }
  }

  if (can_setup) {
    if (triple === undefined) {
      await run_command(["cargo", "run"]);
    } else {
      await run_command([
        "cargo",
        "run",
        "--target",
        triple,
      ]);
    }
  }
};

export const download = async (file: string) => {
  console.log("download");
  await run_command(["download", file]);
};
