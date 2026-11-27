# First Cargo DOM integration prerequisite failure

Run45963794430 atdeb39f40. OFF editor cold/reload passed; Cargo helper stopped BEFORE first button click, because terminal last line was RA startup metadata errors rather than an empty prompt. The original prompt was printed earlier, followed by sysroot/RA background output. No Cargo runtime/performance observation was made; not a compiler regression.

Fix: focus real xterm textarea, press Enter on empty shell input, wait for fresh empty absolute-directory prompt BEFORE capture/timed public button click. No compilation/cache warming command. Expected natural shell interaction; retain fail-closed prompt requirement. No body/source-text fallback. All timing still starts at actual Compile and Run click. Existing source/target/generation/output assertions retained. Need browser rerun.

Raw terminal also reports cargo metadata failures while discovering sysroot in legacyOFF path despite UI reaching ready; preserve these, not assumed new regressions. No explicit successful exit status API; still no public acceptance.
