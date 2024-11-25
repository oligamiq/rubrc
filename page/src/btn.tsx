import { compile_and_run } from "./compile_and_run";

export const Button = () => {
  return (
    <button
      type="button"
      onClick={() => {
        console.log("button clicked");
        compile_and_run();
      }}
      class="text-2xl text-green-700 text-center py-20"
    >
      Compile and Run
    </button>
  );
};
