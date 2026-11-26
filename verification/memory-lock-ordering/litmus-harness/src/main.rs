//! Handwritten bounded litmus tests, NOT execution of WVL lock methods.
use loom::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use loom::thread;
use std::sync::{Arc as HostArc, atomic::{AtomicUsize as HostAtomic, Ordering as HostOrdering}};

fn main() {
    let name = std::env::args().nth(1).expect("scenario required");
    let known = ["direct", "direct_no_release", "direct_no_acquire", "marker_rmw", "marker_store"];
    assert!(known.contains(&name.as_str()), "unknown scenario");
    let runs = HostArc::new(HostAtomic::new(0));
    let observed = HostArc::new(HostAtomic::new(0));
    let r = runs.clone();
    let o = observed.clone();
    let mut builder = loom::model::Builder::new();
    builder.max_threads = 4;
    builder.max_branches = 1000;
    builder.max_permutations = None;
    builder.preemption_bound = None;
    let scenario = name.clone();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| builder.check(move || {
        r.fetch_add(1, HostOrdering::Relaxed);
        let marker = scenario.starts_with("marker");
        let state = Arc::new(AtomicUsize::new(if marker {2} else {1}));
        let payload = Arc::new(AtomicUsize::new(0));
        let s = state.clone();
        let p = payload.clone();
        let n = scenario.clone();
        let publisher = thread::spawn(move || {
            p.store(42, Ordering::Relaxed);
            if marker {
                // An existing reader publishes its writes by releasing 2->1.
                assert_eq!(s.fetch_sub(1, Ordering::Release), 2);
            } else {
                s.store(0, if n == "direct_no_release" {Ordering::Relaxed} else {Ordering::Release});
            }
        });
        let s = state.clone();
        let p = payload.clone();
        let n = scenario.clone();
        let seen = o.clone();
        let observer = thread::spawn(move || {
            if marker {
                // Writer's registration is not an acquire. A plain relaxed store
                // should break the cross-thread release sequence, unlike RMW.
                let marked = if n == "marker_store" {
                    if s.load(Ordering::Relaxed) == 1 {s.store(5, Ordering::Relaxed); true} else {false}
                } else {s.compare_exchange(1, 5, Ordering::Relaxed, Ordering::Relaxed).is_ok()};
                if marked && s.compare_exchange(4, usize::MAX, Ordering::Acquire, Ordering::Relaxed).is_ok() {
                    seen.fetch_add(1, HostOrdering::Relaxed);
                    assert_eq!(p.load(Ordering::Relaxed), 42, "STALE_PAYLOAD");
                }
            } else if s.compare_exchange(0, 1, if n == "direct_no_acquire" {Ordering::Relaxed} else {Ordering::Acquire}, Ordering::Relaxed).is_ok() {
                seen.fetch_add(1, HostOrdering::Relaxed);
                assert_eq!(p.load(Ordering::Relaxed), 42, "STALE_PAYLOAD");
            }
        });
        let releaser = if marker {
            let s = state.clone();
            Some(thread::spawn(move || {
                // Conditional finite slice of last-reader release. RELEASE only:
                // no artificial acquire that could mask marker-store mutation.
                let _ = s.compare_exchange(5, 4, Ordering::Release, Ordering::Relaxed);
            }))
        } else {None};
        publisher.join().unwrap();
        observer.join().unwrap();
        if let Some(t) = releaser {t.join().unwrap();}
    })));
    let error = outcome.err().map(|e| {
        if let Some(s) = e.downcast_ref::<String>() {s.clone()}
        else if let Some(s) = e.downcast_ref::<&str>() {s.to_string()}
        else {"non-string panic".into()}
    });
    let mutant = name != "direct" && name != "marker_rmw";
    let expected = if mutant {error.as_ref().is_some_and(|e| e.contains("STALE_PAYLOAD"))}
        else {error.is_none() && observed.load(HostOrdering::Relaxed) > 0};
    println!("{}", serde_json::json!({"scenario":name,"expectedOutcomeObserved":expected,
        "mutation":mutant,"modelExecutionsStarted":runs.load(HostOrdering::Relaxed),
        "successfulAcquisitionObservations":observed.load(HostOrdering::Relaxed),"panic":error,
        "maxBranches":1000,"preemptionBound":null,"maxPermutations":null,
        "scope":"finite one-shot handwritten litmus, Loom model only; no wait/notify"}));
    if !expected {std::process::exit(1);}
}
