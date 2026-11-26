#!/usr/bin/env python3
"""Bounded actual-source Wasm wait/notify correspondence; no full CLI build."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PINNED_COMMIT = "77f45543eb976e4e7843e78fcd67bd837acac6bd"
SOURCE_FILES = ["abi.rs"] + ["wasm_stream/" + p + ".rs" for p in (
    "pipeline", "translator", "mem_info", "own_memory_abi", "passes/post_combine",
    "passes/fn_in_starts", "passes/reactor_initialize")]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, default=None)
    parser.add_argument("--cargo-home", type=Path, default=None)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--build-timeout", type=int, default=240)
    args = parser.parse_args()
    out = args.output_dir.resolve()
    # Reject reuse, including stale successful outputs. Never delete evidence.
    out.mkdir(parents=True, exist_ok=False)
    source = (args.source_root or Path(os.environ.get("WVL_SOURCE_ROOT", ROOT / ".worktrees/wvl-lock-batching"))).resolve()
    env = os.environ.copy()
    env.update(WVL_SOURCE_ROOT=str(source), CARGO_BUILD_JOBS="2", CARGO_PROFILE_DEV_DEBUG="0",
               CARGO_INCREMENTAL="0", RAYON_NUM_THREADS="2", CARGO_TERM_COLOR="never")
    if args.cargo_home:
        env["CARGO_HOME"] = str(args.cargo_home.resolve())
    target = HERE / ".target"
    records = []
    report = {"status": "fail", "started_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
              "source_root": str(source), "output_dir": str(out), "commands": records,
              "limits": {"cargo_build_jobs": 2, "rayon_threads": 2, "build_timeout_s": args.build_timeout,
                         "harness_timeout_s": 20, "node_timeout_s": 30, "subprocess_cpu_s": 240},
              "environment": {"platform": platform.platform(), "python": sys.version,
                              "cargo_home": env.get("CARGO_HOME", str(Path.home() / ".cargo"))}}

    def run(label, command, timeout):
        start = time.monotonic()
        stdout = out / (label + ".stdout.log")
        stderr = out / (label + ".stderr.log")
        entry = {"label": label, "argv": list(map(str, command)), "cwd": str(ROOT),
                 "timeout_s": timeout, "stdout": stdout.name, "stderr": stderr.name}
        records.append(entry)
        def limits():
            resource.setrlimit(resource.RLIMIT_CPU, (240, 241))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        with stdout.open("wb") as so, stderr.open("wb") as se:
            process = subprocess.Popen(entry["argv"], cwd=ROOT, env=env, stdout=so, stderr=se,
                                       start_new_session=True, preexec_fn=limits)
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                entry["timed_out"] = True
                code = process.returncode
        entry.update(exit_code=code, elapsed_s=round(time.monotonic() - start, 4))
        if code != 0:
            raise RuntimeError(f"{label} failed ({code}); see {stderr}")
        return stdout.read_text().strip()

    try:
        if not __debug__:
            raise RuntimeError("Python optimization disables assertions; run without -O/PYTHONOPTIMIZE")
        report["source_commit"] = run("source-version", ["git", "-C", source, "rev-parse", "HEAD"], 10)
        report["source_status"] = run("source-status", ["git", "-C", source, "status", "--porcelain"], 10)
        if report["source_commit"] != PINNED_COMMIT or report["source_status"]:
            raise RuntimeError(f"Expected clean source checkout at {PINNED_COMMIT}")
        report["source_sha256"] = {p: sha(source / "wasi_virt_layer-cli/src" / p) for p in SOURCE_FILES}
        report["versions"] = {tool: run("version-" + tool, [tool, "--version"], 10) for tool in ["cargo", "rustc", "node"]}
        report["harness_sha256"] = {str(p.relative_to(HERE)): sha(p) for p in [
            HERE / "run.py", HERE / "worker-tests.mjs", HERE / "harness/Cargo.toml",
            HERE / "harness/Cargo.lock", HERE / "harness/build.rs", HERE / "harness/src/main.rs"]}
        command = ["cargo", "build", "--locked", "--manifest-path", HERE / "harness/Cargo.toml", "--target-dir", target]
        if args.offline:
            command.append("--offline")
        run("build", command, args.build_timeout)
        executable = target / "debug/wvl-wasm-wait-correspondence"
        report["executable_sha256"] = sha(executable)
        run("structural", [executable, out], 20)
        run("workers", ["node", HERE / "worker-tests.mjs", out / "lowered.wasm", out / "runtime.json"], 30)
        structural = json.loads((out / "structural.json").read_text())
        runtime = json.loads((out / "runtime.json").read_text())
        assert structural["status"] == runtime["status"] == "pass"
        assert [c["threads"] for c in structural["cases"]] == [True, False]
        assert structural["negative_controls"]["wrong_timeout_type_rejected"]
        assert [c["name"] for c in runtime["cases"]] == ["notify-one", "notify-all-u32-max"]
        for case, size in zip(runtime["cases"], [1, 3]):
            assert case["status"] == "pass" and case["parkedWitness"]["singleNotifyReturn"] == size
            assert len([e for e in case["events"] if e["type"] == "ready" and e["mismatch"] == 1 and e["zeroTimeout"] == 2]) == size
            assert len([e for e in case["events"] if e["type"] == "done" and e["result"] == 0]) == size
        report["source_sha256_after"] = {p: sha(source / "wasi_virt_layer-cli/src" / p) for p in SOURCE_FILES}
        report["source_status_after"] = run("source-status-after", ["git", "-C", source, "status", "--porcelain"], 10)
        assert report["source_sha256"] == report["source_sha256_after"], "source changed during run"
        assert report["source_status"] == report["source_status_after"], "source worktree status changed during run"
        report.update(status="pass", structural="structural.json", runtime="runtime.json")
    except Exception as error:
        report["error"] = repr(error)
        print(str(error), file=sys.stderr)
    finally:
        report["finished_at_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
        report["artifact_sha256"] = {p.name: sha(p) for p in sorted(out.iterdir()) if p.is_file()}
        (out / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "result": str(out / "result.json")}))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
