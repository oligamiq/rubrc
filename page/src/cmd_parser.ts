export interface CommandWaiterEndpoint {
  is_all_done(): boolean;
  is_cmd_run_end(): boolean;
  set_end_of_exec(endOfExec: boolean): void;
}

export interface CommandWaiterProxy {
  is_all_done(): Promise<boolean>;
  is_cmd_run_end(): Promise<boolean>;
  set_end_of_exec(endOfExec: boolean): Promise<void>;
}
