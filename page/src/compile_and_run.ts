import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import type { Ctx } from "./ctx";

let ctx: Ctx;
let terminal: ((string) => Promise<void>) & {
  reset_err_buff: () => Promise<void>;
  get_err_buff: () => Promise<string>;
  reset_out_buff: () => Promise<void>;
  get_out_buff: () => Promise<string>;
};
let shared_downloader: SharedObject;
let input_char: (c: number) => Promise<void>;
let waiter: any;

const run_command = async (args: string[]) => {
  const line = args.join(" ");
  for (let i = 0; i < line.length; i++) {
    await input_char(line.charCodeAt(i));
  }
  await input_char(13);
};

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

  input_char = new SharedObjectRef(ctx.input_char_id).proxy();
};

let can_setup = false;

export const compile_and_run = async (triple: string) => {
  if (!can_setup) {
    if (await waiter.is_all_done()) {
      terminal = new SharedObjectRef(ctx.terminal_id).proxy();
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
    await run_command(exec);

    if (triple === "wasm32-wasip1") {
      await run_command(["/tmp/main.wasm"]);
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

      await run_command(clang_args);
    } else {
      await run_command(["download", "/tmp/main"]);
    }
  }
};

export const download = async (file: string) => {
  console.log("download");
  await run_command(["download", file]);
};
