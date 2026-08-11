/// <reference lib="deno.ns" />

import { shouldSuppressOptionalMetadataNotFound } from "./lsp_browser_console_error.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const missingResourceText =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";

Deno.test("optional metadata suppression requires its exact valid absolute URL", () => {
  for (const locationUrl of [
    undefined,
    "",
    "http://[",
    "/.rubrc-pages-build.json",
    "pptr:internal",
    "http://127.0.0.1:4173/app.js",
    "http://127.0.0.1:4173/.rubrc-pages-build.json?v=1",
    "http://127.0.0.1:4173/.rubrc-pages-build.json#fragment",
  ]) {
    assert(
      !shouldSuppressOptionalMetadataNotFound(missingResourceText, locationUrl),
      `suppressed invalid or unrelated location ${String(locationUrl)}`,
    );
  }

  for (const locationUrl of [
    "http://127.0.0.1:4173/.rubrc-pages-build.json",
    "https://example.test/.rubrc-pages-build.json",
  ]) {
    assert(
      shouldSuppressOptionalMetadataNotFound(missingResourceText, locationUrl),
      `did not suppress exact metadata location ${locationUrl}`,
    );
  }

  assert(
    !shouldSuppressOptionalMetadataNotFound(
      "Unrelated browser error",
      "http://127.0.0.1:4173/.rubrc-pages-build.json",
    ),
    "suppressed an unrelated error at the metadata URL",
  );
});
