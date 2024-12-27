import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";

let ctx: Ctx;
let cmd_parser: (...string) => Promise<void>;
let waiter: {
  is_all_done: () => Promise<boolean>;
  is_cmd_run_end: () => Promise<boolean>;
};
let terminal: ((string) => Promise<void>) & {
  reset_err_buff: () => Promise<void>;
  get_err_buff: () => Promise<string>;
  reset_out_buff: () => Promise<void>;
  get_out_buff: () => Promise<string>;
};
let shared_downloader: SharedObject;
let exec_ref: (...string) => Promise<void>;

export const compile_and_run_setup = (_ctx: Ctx) => {
  ctx = _ctx;

  waiter = new SharedObjectRef(ctx.waiter_id).proxy();

  shared_downloader = new SharedObject((url: string, name: string) => {
    (async () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = name; // ダウンロード時のファイル名を指定
      document.body.appendChild(a); // DOM に追加
      a.click(); // クリックしてダウンロードを開始
      document.body.removeChild(a); // すぐに削除
    })();
  }, ctx.download_by_url_id);

  exec_ref = new SharedObjectRef(ctx.cmd_parser_id).proxy();
};

let can_setup = false;

export const compile_and_run = async (triple: string) => {
  if (!can_setup) {
    if (await waiter.is_all_done()) {
      terminal = new SharedObjectRef(ctx.terminal_id).proxy();

      cmd_parser = new SharedObjectRef(ctx.cmd_parser_id).proxy();
      can_setup = true;
    } else {
      terminal = new SharedObjectRef(ctx.terminal_id).proxy();

      await terminal("this is not done yet\r\n");
    }
  }

  if (can_setup) {
    const exec = [
      "rustc",
      "/main.rs",
      "--sysroot",
      "/sysroot",
      "--target",
      triple,
      "--out-dir",
      "/tmp",
      "-Ccodegen-units=1",
    ];
    if (triple === "wasm32-wasip1") {
      exec.push("-Clinker-flavor=wasm-ld");
      exec.push("-Clinker=wasm-ld");
    } else {
      // exec.push("-Zunstable-options");
      // exec.push("-Clinker-flavor=gnu");
      exec.push("-Clinker=lld");

      await terminal.reset_err_buff();
    }
    await terminal(`${exec.join(" ")}\r\n`);
    await cmd_parser(...exec);
    while (!(await waiter.is_cmd_run_end())) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (triple === "wasm32-wasip1") {
      await terminal("/tmp/main.wasm\r\n");
      await cmd_parser("/tmp/main.wasm");
      while (!(await waiter.is_cmd_run_end())) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } else if (triple === "x86_64-pc-windows-gnu") {
      const err_msg = await terminal.get_out_buff();
      console.log("err_msg: ", err_msg);

      const lld_args_and_etc = err_msg
        .split("\r\n")
        .find((line) => line.includes("Linking using"));
      if (!lld_args_and_etc) {
        throw new Error("cannot get lld arguments");
      }

      // split by space
      const lld_args_str = lld_args_and_etc
        .split(' "')
        ?.slice(1)
        .map((arg) => arg.slice(0, -1));

      // first args to lld-link
      const clang_args = lld_args_str;
      clang_args[0] = "lld-link";

      // // add -fuse-ld=lld
      // clang_args.push("-fuse-ld=lld");

      await terminal(`${clang_args.join(" ")}\r\n`);
      await cmd_parser(...clang_args);
    } else {
      await terminal("download /tmp/main\r\n");
      await cmd_parser("download", "/tmp/main");
      while (!(await waiter.is_cmd_run_end())) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
};

export const download = async (file: string) => {
  console.log("download");
  await terminal(`download ${file}\r\n`);
  exec_ref("download", file);
};
