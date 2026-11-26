#!/usr/bin/env python3
"""Run bounded native regressions against the unmodified WVL lock source.

No Cargo invocation or third-party Python dependencies. Evidence is create-only;
choose a new --output-dir for another run. This is empirical regression evidence,
not a formal proof or a substitute for Wasm-runtime integration tests.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

EXPECTED_COMMIT = "77f45543eb976e4e7843e78fcd67bd837acac6bd"
INPUTS = (
    "wasi_virt_layer/src/memory_lock.rs",
    "wasi_virt_layer/tests/support/memory_lock_cases.rs",
    "wasi_virt_layer/src/shared_global.rs",
    "wasi_virt_layer/tests/memory_lock_protocol.rs",
)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fresh_text(path, text):
    with path.open("x", encoding="utf-8") as handle:
        handle.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2] / ".worktrees/wvl-lock-batching")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--repetitions", type=int, default=20)
    parser.add_argument("--test-timeout", type=float, default=20)
    parser.add_argument("--compile-timeout", type=float, default=60)
    args = parser.parse_args()
    if args.repetitions < 1 or args.test_timeout <= 0 or args.compile_timeout <= 0:
        parser.error("repetitions and timeouts must be positive")
    root = args.source_root.resolve()
    out = args.output_dir.resolve()
    for relative in INPUTS:
        if not (root / relative).is_file():
            parser.error(f"missing source input: {root / relative}")
    out.mkdir(parents=True, exist_ok=True)
    result_path = out / "native-results.json"
    logs = out / "native-logs"
    artifacts = out / "native-artifacts"
    for path in (result_path, logs, artifacts):
        if path.exists():
            parser.error(f"refusing to overwrite existing evidence: {path}; choose a fresh --output-dir")
    logs.mkdir()
    artifacts.mkdir()
    evidence = {
        "schema_version": 1,
        "objective": "Empirical regression tests of actual unchanged memory_lock.rs and existing native export harness; not formal verification",
        "started_at_utc": utc_now(),
        "invocation": [sys.executable, *sys.argv],
        "working_directory": str(Path.cwd()),
        "source_root": str(root),
        "output_directory": str(out),
        "expected_commit": EXPECTED_COMMIT,
        "environment": {
            "platform": platform.platform(), "machine": platform.machine(),
            "python": sys.version, "rustc_path": shutil.which("rustc"),
            "RUSTUP_TOOLCHAIN": os.environ.get("RUSTUP_TOOLCHAIN"),
            "RUSTFLAGS": os.environ.get("RUSTFLAGS"),
            "note": "Direct rustc commands do not consume Cargo RUSTFLAGS; inherited environment except RUST_BACKTRACE=1",
        },
        "configuration": vars(args) | {"source_root": str(root), "output_dir": str(out)},
        "source_hashes_before": {relative: sha256(root / relative) for relative in INPUTS},
        "runner_sha256": sha256(Path(__file__).resolve()),
        "commands": [], "variants": [], "failures": [],
    }

    def run(label, argv, timeout):
        number = len(evidence["commands"])
        prefix = logs / f"{number:03d}-{label}"
        record = {
            "label": label, "argv": [str(a) for a in argv],
            "shell_command": shlex.join([str(a) for a in argv]),
            "cwd": str(root), "timeout_seconds": timeout,
            "started_at_utc": utc_now(), "timed_out": False,
        }
        started = time.monotonic()
        try:
            process = subprocess.Popen(record["argv"], cwd=root, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, start_new_session=True,
                                       env=os.environ | {"RUST_BACKTRACE": "1"})
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                record["timed_out"] = True
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
            record["returncode"] = process.returncode
        except OSError as error:
            stdout, stderr = b"", repr(error).encode()
            record["returncode"] = None
        record["duration_seconds"] = time.monotonic() - started
        for stream, data in (("stdout", stdout), ("stderr", stderr)):
            path = prefix.with_suffix(f".{stream}.log")
            with path.open("xb") as handle:
                handle.write(data)
            record[f"{stream}_path"] = str(path.relative_to(out))
            record[f"{stream}_sha256"] = hashlib.sha256(data).hexdigest()
        evidence["commands"].append(record)
        text = stdout.decode("utf-8", errors="replace")
        if record["returncode"] != 0 or record["timed_out"]:
            evidence["failures"].append(f"{label}: returncode={record['returncode']}, timeout={record['timed_out']}")
        return record, text

    try:
        _, revision = run("git-head", ["git", "rev-parse", "HEAD"], 10)
        evidence["observed_commit"] = revision.strip()
        _, status = run("git-status-before", ["git", "status", "--porcelain=v1"], 10)
        evidence["source_status_before"] = status
        _, version = run("rustc-version", ["rustc", "-vV"], 30)
        evidence["rustc_version"] = version
        if revision.strip() != EXPECTED_COMMIT:
            raise RuntimeError("source commit differs from the pinned target")
        wrapper = artifacts / "actual_source_wrapper.rs"
        fresh_text(wrapper, '// Includes the actual production module, which includes its actual tests.\n'
                   + '#![allow(dead_code)]\n'
                   + f'#[path = {json.dumps(str(root / INPUTS[0]))}]\nmod memory_lock;\n')
        evidence["wrapper_path"] = str(wrapper.relative_to(out))
        evidence["wrapper_sha256"] = sha256(wrapper)
        for harness, source, baseline_count in (
            ("core", wrapper, 8),
            ("exports", root / INPUTS[3], 9),
        ):
            for feature in (False, True):
                for optimization in (0, 3):
                    label = f"{harness}-{'waiter' if feature else 'baseline'}-opt{optimization}"
                    binary = artifacts / label
                    argv = ["rustc", "--edition=2024", "--test", str(source), "-C", f"opt-level={optimization}", "-o", str(binary)]
                    if feature:
                        argv += ["--cfg", 'feature="waiter-aware-memory-lock"']
                    variant = {"label": label, "harness": harness, "feature_enabled": feature,
                               "optimization": optimization, "expected_test_count": baseline_count + (2 if feature else 0),
                               "runs": []}
                    evidence["variants"].append(variant)
                    compiled, _ = run(label + "-compile", argv, args.compile_timeout)
                    variant["compile_command_index"] = len(evidence["commands"]) - 1
                    if compiled["returncode"] != 0 or compiled["timed_out"]:
                        continue
                    variant["binary_sha256"] = sha256(binary)
                    listed, listing = run(label + "-list", [str(binary), "--list"], args.test_timeout)
                    variant["test_names"] = [line.removesuffix(": test") for line in listing.splitlines() if line.endswith(": test")]
                    if len(variant["test_names"]) != variant["expected_test_count"]:
                        evidence["failures"].append(f"{label}: unexpected test inventory")
                    for repetition in range(args.repetitions):
                        threads = 1 if repetition % 2 == 0 else 4
                        record, stdout = run(f"{label}-run{repetition + 1:02d}",
                            [str(binary), "--nocapture", f"--test-threads={threads}"], args.test_timeout)
                        match = re.search(r"test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out", stdout)
                        passed = bool(match and int(match[1]) == variant["expected_test_count"] and all(int(match[i]) == 0 for i in range(2, 6)) and record["returncode"] == 0 and not record["timed_out"])
                        variant["runs"].append({"repetition": repetition + 1, "test_threads": threads,
                                                "command_index": len(evidence["commands"]) - 1, "passed": passed,
                                                "passed_test_count": int(match[1]) if match else None})
                        if not passed:
                            evidence["failures"].append(f"{label} run {repetition + 1}: unsuccessful test summary")
    except Exception as error:
        evidence["failures"].append(f"runner exception: {type(error).__name__}: {error}")
    finally:
        evidence["source_hashes_after"] = {relative: sha256(root / relative) for relative in INPUTS}
        evidence["sources_unchanged"] = evidence["source_hashes_before"] == evidence["source_hashes_after"]
        if not evidence["sources_unchanged"]:
            evidence["failures"].append("source hashes changed during experiment")
        _, status = run("git-status-after", ["git", "status", "--porcelain=v1"], 10)
        evidence["source_status_after"] = status
        evidence["finished_at_utc"] = utc_now()
        all_runs = [run for variant in evidence["variants"] for run in variant["runs"]]
        evidence["summary"] = {
            "variant_count": len(evidence["variants"]),
            "test_process_runs": len(all_runs),
            "successful_test_process_runs": sum(run["passed"] for run in all_runs),
            "successful_test_executions": sum(run["passed_test_count"] for run in all_runs if run["passed"]),
            "timeout_count": sum(command["timed_out"] for command in evidence["commands"]),
            "outcome": "PASS" if not evidence["failures"] and len(all_runs) == 8 * args.repetitions else "FAIL",
        }
        fresh_text(result_path, json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence["summary"], indent=2))
    print(f"Evidence: {result_path}")
    return 0 if evidence["summary"]["outcome"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
