import { compile_and_run, download } from "./compile_and_run";

export const RunButton = (props: {
  triple: string;
}) => {
  return (
    <button
      type="button"
      onClick={() => {
        console.log("run button clicked");
        compile_and_run(props.triple);
      }}
      class="text-2xl text-green-700"
    >
      Compile and Run
    </button>
  );
};

export const DownloadButton = () => {
  return (
    <button
      type="button"
      onClick={() => {
        console.log("download button clicked");
        download("/tmp/main.wasm");
      }}
      class="text-2xl text-green-700"
    >
      Download file
    </button>
  );
};
