export type Ctx = {
  terminal_id: string;
  rustc_id: string;
  waiter_id: string;
  cmd_parser_id: string;
  tree_id: string;
  ls_id: string;
  exec_file_id: string;
  download_id: string;
  download_by_url_id: string;
  load_additional_sysroot_id: string;
  llvm_id: string;
};

const gen_id = () => Math.random().toString(36).substring(7);

export const gen_ctx = (): Ctx => {
  return {
    terminal_id: gen_id(),
    rustc_id: gen_id(),
    waiter_id: gen_id(),
    cmd_parser_id: gen_id(),
    tree_id: gen_id(),
    ls_id: gen_id(),
    exec_file_id: gen_id(),
    download_id: gen_id(),
    download_by_url_id: gen_id(),
    load_additional_sysroot_id: gen_id(),
    llvm_id: gen_id(),
  };
};
