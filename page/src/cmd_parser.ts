import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";

let waiter: SharedObject;
let is_all_done = false;

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
      is_all_done: (): boolean => {
        return is_all_done;
      },
    },
    ctx.waiter_id,
  );

  await Promise.all(resolvers.map((r) => r.promise));

  is_all_done = true;

  await all_done(ctx);
};

let cmd_parser: SharedObject;

const all_done = async (ctx: Ctx) => {
  const rustc = new SharedObjectRef(ctx.rustc_id).proxy<(...string) => void>();
  const terminal = new SharedObjectRef(ctx.terminal_id).proxy<
    (string) => void
  >();
  const ls = new SharedObjectRef(ctx.ls_id).proxy<(...string) => void>();
  const tree = new SharedObjectRef(ctx.tree_id).proxy<(...string) => void>();

  cmd_parser = new SharedObject((...args) => {
    (async (args: string[]) => {
      console.log(args);

      const cmd = args[0];

      console.log(cmd);

      if (cmd === "rustc") {
        console.log("rustc");
        await terminal("executing rustc...\r\n");
        await rustc(...args.slice(1));
      } else if (cmd === "echo") {
        console.log("echo");
        await terminal(`${args.slice(1).join(" ")}\r\n`);
      } else if (cmd === "ls") {
        console.log("ls");
        await terminal("executing ls...\r\n");
        await ls(...args.slice(1));
      } else if (cmd === "tree") {
        console.log("tree");
        await terminal("executing tree...\r\n");
        await tree(...args.slice(1));
      } else {
        await terminal(`command not found: ${cmd}\r\n`);
      }
      await terminal(">");
    })(args);
  }, ctx.cmd_parser_id);

  await terminal("rustc -h\r\n");
  await rustc("-h");
};
