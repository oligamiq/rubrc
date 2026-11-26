#!/usr/bin/env python3
"""Bounded actual-source Loom runner; evidence and dependency/build state stay local."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time

BASE = Path(__file__).resolve().parent
PROJECT = BASE.parent.parent
HARNESS = BASE / "actual-harness"
SOURCE = PROJECT / ".worktrees/wvl-lock-batching/wasi_virt_layer/src/memory_lock.rs"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-lock", action="store_true", help="explicitly generate Cargo.lock before locked builds")
    parser.add_argument("--build-timeout", type=int, default=120)
    parser.add_argument("--test-timeout", type=int, default=30)
    parser.add_argument("--max-permutations", type=int, default=1000)
    parser.add_argument("--max-duration", type=int, default=10)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    results = BASE / "results" / ("actual-" + stamp)
    results.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location("source_transform", HARNESS / "source_transform.py")
    transform = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transform)
    manifest = transform.transform(SOURCE, results / "source")
    env = os.environ.copy()
    # Do not inherit model knobs that silently alter the documented bounds.
    for key in list(env):
        if key.startswith("LOOM_"):
            del env[key]
    env["CARGO_HOME"] = str(HARNESS / ".cargo-home")
    env["CARGO_TARGET_DIR"] = str(HARNESS / "target")
    env["WVL_VERIFICATION_MAX_PERMUTATIONS"] = str(args.max_permutations)
    env["WVL_VERIFICATION_MAX_DURATION_S"] = str(args.max_duration)
    records = []
    summary = {"utc": stamp, "source": manifest, "environment": {k: env[k] for k in ("CARGO_HOME", "CARGO_TARGET_DIR", "WVL_VERIFICATION_MAX_PERMUTATIONS", "WVL_VERIFICATION_MAX_DURATION_S")},
               "limits": vars(args), "commands": records, "harness_hashes": {str(p.relative_to(BASE)): sha(p) for p in [HARNESS / "Cargo.toml", HARNESS / "build.rs", HARNESS / "source_transform.py", HARNESS / "src/lib.rs", Path(__file__)]}}

    snapshot = results / "harness-snapshot"
    for name in ("Cargo.toml", "Cargo.lock", "build.rs", "source_transform.py", "src/lib.rs"):
        original = HARNESS / name
        if original.exists():
            destination = snapshot / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(original.read_bytes())
    (snapshot / "actual_runner.py").write_bytes(Path(__file__).read_bytes())
    (results / "source" / "memory_lock_original.rs").write_bytes(SOURCE.read_bytes())

    def save():
        if (HARNESS / "Cargo.lock").exists():
            summary["cargo_lock_sha256"] = sha(HARNESS / "Cargo.lock")
        (results / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    def run(label, command, timeout):
        log = results / (label + ".log")
        started = time.monotonic()
        timed_out = False
        with log.open("w") as out:
            out.write("COMMAND " + json.dumps(command) + "\n")
            out.flush()
            proc = subprocess.Popen(command, cwd=HARNESS, env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(proc.pid, signal.SIGKILL)
                code = proc.wait()
            out.write(f"\nRUNNER exit_code={code} timeout={timed_out}\n")
        records.append({"label": label, "command": command, "cwd": str(HARNESS), "timeout_s": timeout, "exit_code": code,
                        "timed_out": timed_out, "elapsed_s": round(time.monotonic() - started, 3), "log": str(log.relative_to(BASE))})
        save()
        print(f"{label}: exit={code}, timeout={timed_out}, log={log}", flush=True)
        return code == 0 and not timed_out

    run("rustc-version", ["rustc", "--version", "--verbose"], 10)
    run("cargo-version", ["cargo", "--version"], 10)
    run("source-commit", ["git", "-C", str(SOURCE.parents[2]), "rev-parse", "HEAD"], 10)
    run("source-status", ["git", "-C", str(SOURCE.parents[2]), "status", "--short"], 10)
    if args.prepare_lock and not run("generate-lock", ["cargo", "generate-lockfile"], args.build_timeout):
        return 1
    if not (HARNESS / "Cargo.lock").exists():
        raise RuntimeError("Cargo.lock missing; explicitly run --prepare-lock once")
    success = True
    for label, features in [("legacy", []), ("waiter-aware", ["--features", "waiter-aware-memory-lock"])]:
        if not run(label + "-build", ["cargo", "test", "--locked", "--no-run", *features], args.build_timeout):
            success = False
            continue
        for case in ("writer_release_to_reader_payload", "readers_release_to_writer_disjoint_payloads"):
            ok = run(label + "-" + case, ["cargo", "test", "--locked", *features, "tests::" + case, "--", "--exact", "--nocapture", "--test-threads=1"], args.test_timeout)
            success = success and ok
    summary["all_invocations_passed"] = success
    summary["interpretation"] = "Only bounded model executions; passes do not establish arbitrary-execution correctness, wait/notify correctness, or liveness. Inspect model counters and cap terminations."
    save()
    print(f"RESULTS {results}")
    return 0 if success else 1

if __name__ == "__main__":
    raise SystemExit(main())
