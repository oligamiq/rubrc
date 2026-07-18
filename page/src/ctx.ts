import { v4 as uuidv4 } from "uuid";

export type Ctx = {
  terminal_id: string;
  waiter_id: string;
  cmd_parser_id: string;
  tree_id: string;
  ls_id: string;
  exec_file_id: string;
  load_additional_sysroot_id: string;
  input_char_id: string;
  input_string_id: string;
  interrupt_id: string;
  resize_id: string;
  get_terminal_size_id: string;
  create_session_id: string;
  vfs_ready_id: string;
  close_session_id: string;
};

export const gen_ctx = (): Ctx => {
  return {
    terminal_id: uuidv4(),
    waiter_id: uuidv4(),
    cmd_parser_id: uuidv4(),
    tree_id: uuidv4(),
    ls_id: uuidv4(),
    exec_file_id: uuidv4(),
    load_additional_sysroot_id: uuidv4(),
    input_char_id: uuidv4(),
    input_string_id: uuidv4(),
    interrupt_id: uuidv4(),
    resize_id: uuidv4(),
    get_terminal_size_id: uuidv4(),
    create_session_id: uuidv4(),
    vfs_ready_id: uuidv4(),
    close_session_id: uuidv4(),
  };
};
