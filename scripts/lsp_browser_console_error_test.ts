/// <reference lib="deno.ns" />

import { shouldSuppressOptionalMetadataNotFound } from "./lsp_browser_console_error.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const missingResourceText =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";
const expectedMetadataUrl = "http://127.0.0.1:4173/.rubrc-pages-build.json";

Deno.test("optional metadata suppression requires its exact valid absolute URL", () => {
  for (const locationUrl of [
    undefined,
    "",
    "http://[",
    "/.rubrc-pages-build.json",
    "pptr:internal",
    "http://127.0.0.1:4173/app.js",
    "https://example.test/.rubrc-pages-build.json",
    "http://127.0.0.1:8080/.rubrc-pages-build.json",
    "http://127.0.0.1:4173/.rubrc-pages-build.json?v=1",
    "http://127.0.0.1:4173/.rubrc-pages-build.json#fragment",
  ]) {
    assert(
      !shouldSuppressOptionalMetadataNotFound(
        missingResourceText,
        locationUrl,
        expectedMetadataUrl,
      ),
      `suppressed invalid or unrelated location ${String(locationUrl)}`,
    );
  }

  assert(
    shouldSuppressOptionalMetadataNotFound(
      missingResourceText,
      expectedMetadataUrl,
      expectedMetadataUrl,
    ),
    `did not suppress exact metadata location ${expectedMetadataUrl}`,
  );

  assert(
    !shouldSuppressOptionalMetadataNotFound(
      "Unrelated browser error",
      expectedMetadataUrl,
      expectedMetadataUrl,
    ),
    "suppressed an unrelated error at the metadata URL",
  );
});
