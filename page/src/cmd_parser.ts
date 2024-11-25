import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";
import { get_data } from "./cat";

let waiter: SharedObject;
let is_all_done = false;
let is_cmd_run_end = true;
let end_of_exec = false;

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
      is_cmd_run_end: () => {
        return is_cmd_run_end;
      },
      set_end_of_exec: (
        _end_of_exec: boolean,
      ) => {
        end_of_exec = _end_of_exec;
      }
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
  const exec_file = new SharedObjectRef(ctx.exec_file_id).proxy<(...string) => void>();

  cmd_parser = new SharedObject((...args) => {
    is_cmd_run_end = false;
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
      } else if (cmd.includes("/")) {
        console.log("cmd includes /");
        await terminal("executing file...\r\n");
        end_of_exec = false;
        await exec_file(...args);
        while (!end_of_exec) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      } else {
        await terminal(`command not found: ${cmd}\r\n`);
      }
      await terminal(">");
      is_cmd_run_end = true;
    })(args);
  }, ctx.cmd_parser_id);

  await terminal("rustc -h\r\n");
  await rustc("-h");
};
