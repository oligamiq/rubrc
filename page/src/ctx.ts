import { v4 as uuidv4 } from "uuid";

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

export const gen_ctx = (): Ctx => {
  return {
    terminal_id: uuidv4(),
    rustc_id: uuidv4(),
    waiter_id: uuidv4(),
    cmd_parser_id: uuidv4(),
    tree_id: uuidv4(),
    ls_id: uuidv4(),
    exec_file_id: uuidv4(),
    download_id: uuidv4(),
    download_by_url_id: uuidv4(),
    load_additional_sysroot_id: uuidv4(),
    llvm_id: uuidv4(),
  };
};
