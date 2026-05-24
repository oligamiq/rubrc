import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";

let waiter: SharedObject;
let is_all_done = false;
let is_cmd_run_end = true;
let end_of_exec = false;

export const parser_setup = async (ctx: Ctx) => {
  waiter = new SharedObject(
    {
      is_all_done: (): boolean => {
        return is_all_done;
      },
      is_cmd_run_end: () => {
        return is_cmd_run_end;
      },
      set_end_of_exec: (_end_of_exec: boolean) => {
        end_of_exec = _end_of_exec;
      },
    },
    ctx.waiter_id,
  );

  is_all_done = true;

  await all_done(ctx);
};

const all_done = async (ctx: Ctx) => {
  const terminal = new SharedObjectRef(ctx.terminal_id).proxy<
    (string: string) => Promise<void>
  >();
};
