// Generated module differs from actual source only by the three checked substitutions.
include!(concat!(env!("OUT_DIR"), "/actual_module.rs"));

#[cfg(test)]
mod tests {
    use super::actual::{MemoryAccessLock, WaitNotify};
    use loom::{sync::{atomic::{AtomicI32, AtomicUsize, Ordering}, Arc}, thread};
    use std::{sync::{atomic::AtomicUsize as Counter, Arc as StdArc}, time::{Duration, Instant}};

    // Deliberately not a compare-and-park backend: this models ordering, not waiting.
    struct YieldBackend;
    impl WaitNotify for YieldBackend {
        fn wait(&self, _: &AtomicI32, _: i32) { thread::yield_now(); }
        fn notify(&self, _: &AtomicI32, _: u32) {}
    }

    fn model(case: &'static str, f: impl Fn() + Send + Sync + 'static) {
        let mut builder = loom::model::Builder::new();
        builder.max_threads = 4;
        builder.max_branches = 128;
        builder.preemption_bound = Some(2);
        let max_permutations = std::env::var("WVL_VERIFICATION_MAX_PERMUTATIONS").unwrap_or_else(|_| "1000".into()).parse().unwrap();
        let max_duration_s = std::env::var("WVL_VERIFICATION_MAX_DURATION_S").unwrap_or_else(|_| "10".into()).parse().unwrap();
        builder.max_permutations = Some(max_permutations);
        builder.max_duration = Some(Duration::from_secs(max_duration_s));
        builder.checkpoint_interval = 1;
        let count = StdArc::new(Counter::new(0));
        let inside = count.clone();
        let completed = StdArc::new(Counter::new(0));
        let completed_inside = completed.clone();
        let start = Instant::now();
        println!("MODEL case={case} max_threads=4 max_branches=128 preemption_bound=2 max_permutations={max_permutations} max_duration_s={max_duration_s} checkpoint_interval=1");
        builder.check(move || {
            inside.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            f();
            completed_inside.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        println!("MODEL_RESULT case={case} executions_started={} executions_completed={} payload_assertions_per_execution={} elapsed_ms={} status=bounded_model_pass_not_arbitrary_exhaustiveness", count.load(std::sync::atomic::Ordering::Relaxed), completed.load(std::sync::atomic::Ordering::Relaxed), if case == "writer_release_to_reader_payload" { 1 } else { 2 }, start.elapsed().as_millis());
    }

    #[test]
    fn writer_release_to_reader_payload() {
        model("writer_release_to_reader_payload", || {
            let lock = Arc::new(MemoryAccessLock::new());
            let payload = Arc::new(AtomicUsize::new(0));
            // Acquire before spawn: reader cannot enter an earlier lock epoch.
            lock.write_acquire(&YieldBackend);
            let reader_lock = lock.clone();
            let reader_payload = payload.clone();
            let reader = thread::spawn(move || {
                reader_lock.read_acquire(&YieldBackend);
                assert_eq!(reader_payload.load(Ordering::Relaxed), 41);
                reader_lock.read_release(&YieldBackend);
            });
            // After spawn: spawn synchronization cannot publish this store.
            payload.store(41, Ordering::Relaxed);
            lock.write_release(&YieldBackend);
            reader.join().unwrap();
        });
    }

    #[test]
    fn readers_release_to_writer_disjoint_payloads() {
        model("readers_release_to_writer_disjoint_payloads", || {
            let lock = Arc::new(MemoryAccessLock::new());
            let left = Arc::new(AtomicUsize::new(0));
            let right = Arc::new(AtomicUsize::new(0));
            // Two logical read permits transferred to separate workers; the lock
            // has no thread-local ownership. Writer cannot acquire count > 0.
            lock.read_acquire(&YieldBackend);
            lock.read_acquire(&YieldBackend);
            let writer_lock = lock.clone();
            let writer_left = left.clone();
            let writer_right = right.clone();
            let writer = thread::spawn(move || {
                writer_lock.write_acquire(&YieldBackend);
                assert_eq!(writer_left.load(Ordering::Relaxed), 17);
                assert_eq!(writer_right.load(Ordering::Relaxed), 29);
                writer_lock.write_release(&YieldBackend);
            });
            let first_lock = lock.clone();
            let first = thread::spawn(move || {
                left.store(17, Ordering::Relaxed);
                first_lock.read_release(&YieldBackend);
            });
            let second_lock = lock.clone();
            let second = thread::spawn(move || {
                right.store(29, Ordering::Relaxed);
                second_lock.read_release(&YieldBackend);
            });
            // Writer checks before joins; joins in the main thread cannot mask
            // missing publication between worker readers and worker writer.
            writer.join().unwrap();
            first.join().unwrap();
            second.join().unwrap();
        });
    }
}
