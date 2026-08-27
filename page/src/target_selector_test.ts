import { createTargetSelectorState } from "./target_selector_state.ts";
import targetSelectorSource from "./TargetSelector.tsx" with { type: "text" };

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("disabled target selector cannot open or select", () => {
  let disabled = true;
  const selections: string[] = [];
  const state = createTargetSelectorState(
    () => disabled,
    (value) => selections.push(value),
  );

  state.toggle();
  state.select("wasm32-wasip1");
  assert(!state.open(), "disabled selector opened");
  assert(selections.length === 0, "disabled selector emitted a selection");

  disabled = false;
  state.toggle();
  state.close();
  assert(!state.open(), "external close did not update selector state");
  state.toggle();
  state.select("wasm32-wasip1");
  assert(!state.open(), "selection did not close the selector");
  assert(
    selections.join(",") === "wasm32-wasip1",
    "enabled selector did not emit its selection",
  );
});

Deno.test("TargetSelector renders a native disabled control and styling", async () => {
  const source = targetSelectorSource;
  assert(source.includes("disabled: boolean"), "selector lacks disabled prop");
  assert(
    source.includes("disabled={props.disabled}"),
    "selector trigger is not natively disabled",
  );
  assert(
    (source.match(/disabled=\{props\.disabled\}/g) ?? []).length >= 2,
    "selector choices are not natively disabled",
  );
  assert(
    source.includes("disabled:cursor-not-allowed") &&
      source.includes("disabled:opacity-50"),
    "selector lacks disabled styling",
  );
  assert(
    source.includes("state.close()"),
    "click-outside close does not synchronize selector state",
  );
  assert(
    source.includes("loadTarget(triple: string): Promise<void>"),
    "selector lacks a concrete runtime target callback",
  );
  assert(
    source.includes("props.selectedTarget") &&
      source.includes("props.activeTarget") &&
      source.includes("props.completedTargets"),
    "selector does not render canonical runtime target status",
  );
  assert(
    !source.includes("props.onChange") && !source.includes("props.value"),
    "selector still uses generic local selection props",
  );
});
