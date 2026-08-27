import { createTargetErrorState } from "./target_error_state.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

Deno.test("older target failure cannot publish over the latest selection", async () => {
  const controller = new AbortController();
  const publications: Array<string | undefined> = [];
  const errors = createTargetErrorState({
    signal: controller.signal,
    publish: (message) => publications.push(message),
  });
  const targetA = deferred<void>();
  const targetB = deferred<void>();
  const first = errors.load("target-a", () => targetA.promise).catch(() => {});
  const second = errors.load("target-b", () => targetB.promise).catch(() => {});

  targetA.reject(new Error("target A failed"));
  await first;
  assert(
    publications.filter((value) => value !== undefined).length === 0,
    "older target failure published over target B",
  );

  targetB.reject(new Error("target B failed"));
  await second;
  assert(
    publications.at(-1) === "target B failed",
    "latest target failure was not published",
  );
});

Deno.test("duplicate same-target requests publish only the latest request failure", async () => {
  const controller = new AbortController();
  const publications: Array<string | undefined> = [];
  const errors = createTargetErrorState({
    signal: controller.signal,
    publish: (message) => publications.push(message),
  });
  const shared = deferred<void>();

  const first = errors.load("same-target", () => shared.promise).catch(() => {});
  const second = errors.load("same-target", () => shared.promise).catch(() => {});
  shared.reject(new Error("shared failure"));
  await Promise.all([first, second]);

  assert(
    publications.filter((value) => value === "shared failure").length === 1,
    "duplicate requests did not preserve unique request identity",
  );
});

Deno.test("target failure after runtime abort is ignored", async () => {
  const controller = new AbortController();
  const publications: Array<string | undefined> = [];
  const errors = createTargetErrorState({
    signal: controller.signal,
    publish: (message) => publications.push(message),
  });
  const target = deferred<void>();
  const loading = errors.load("target-a", () => target.promise).catch(() => {});

  controller.abort(new Error("runtime aborted"));
  target.reject(new Error("late target failure"));
  await loading;

  assert(
    !publications.includes("late target failure"),
    "aborted runtime published a late target error",
  );
});
