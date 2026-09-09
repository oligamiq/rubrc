# Browser LSP Test Port Design

## Goal

Allow the browser LSP acceptance test to run while another local Pages preview
uses the default port, without changing the existing default behavior.

## Design

`scripts/lsp_browser_diagnostics_test.mjs` will read `PORT`, defaulting to
`4173`. It will reject values that are not safe integers in the inclusive range
1 through 65535 before starting the static server or Chromium.

The validated port will be the single source for the test base URL, expected
metadata URL, server listen address, and browser navigation. The implementation
will follow the validation already used by the standalone static server CLI.

## Compatibility

Running the existing package script without `PORT` will continue to use 4173.
Callers may select another port, for example `PORT=4174 bun run
test:lsp-browser`.

## Verification

The browser contract test will first cover the default, override, invalid-value
rejection, and consistent URL/listen usage. The real Chromium semantic test will
then run on port 4174 while the existing Pages preview remains on port 4173.
