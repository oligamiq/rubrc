import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";

let waiter: SharedObject;
let is_all_done = false;
let is_cmd_run_end = true;
let end_of_exec = false;
let is_rustc_fetch_end = false;

export const parser_setup = async (ctx: Ctx) => {
  const n = 1;

  const resolvers: PromiseWithResolvers<void>[] = [];
  for (let i = 0; i < n; i++) {
    resolvers.push(Promise.withResolvers<void>());
  }

  waiter = new SharedObject(
    {
      rustc: () => {
        resolvers[0].resolve();
      },
      end_rustc_fetch: () => {
        is_rustc_fetch_end = true;
      },
      is_rustc_fetch_end: () => {
        return is_rustc_fetch_end;
      },
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

  await Promise.all(resolvers.map((r) => r.promise));

  is_all_done = true;

  await all_done(ctx);
};

const all_done = async (ctx: Ctx) => {
  const terminal = new SharedObjectRef(ctx.terminal_id).proxy<
    (string: string) => Promise<void>
  >();
};
