use std::collections::VecDeque;

const EVENT_PREFIX: &str = "\r\n[vfs-debug] ";
const EVENT_SUFFIX: &str = "\r\n";
const SNAPSHOT_TRUNCATION_SUFFIX: &str = " [truncated]";

pub fn is_lifecycle_event(event: &str) -> bool {
    matches!(
        event,
        "command:return"
            | "wasi-ext-spawn:run-rustc:enter"
            | "cargo:_reset:enter"
            | "cargo:_reset:return"
            | "cargo:_main:enter"
            | "cargo:_main:return"
            | "rustc:already-running"
            | "rustc:_reset:enter"
            | "rustc:_reset:return"
            | "rustc:_main:enter"
            | "rustc:_main:return"
            | "pool:init"
            | "write_cargo_result: allocate stdout failed"
    ) || event.starts_with("wasi-ext-spawn:run-rustc:return status=")
        || event.starts_with("wasi-ext-spawn:return status=")
        || event.starts_with("cargo:memory:")
        || event.starts_with("rustc:memory:")
        || event.starts_with("pool:capacity capacity=")
        || event.starts_with("pool:flush-return capacity=")
        || event.starts_with("host-cargo:")
        || event.starts_with("host-run-cargo:")
        || event.starts_with("debug-rustc:enter run=")
        || event.starts_with("debug-rustc:return run=")
        || event.starts_with("debug-reserve-self:")
        || event.starts_with("debug-reserve-rustc:")
        || event.starts_with("write_cargo_result: stdout=")
}

#[derive(Clone, Copy)]
pub enum PipeKind {
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Default)]
struct PipeState {
    invocation_id: usize,
    bytes: usize,
    eof: bool,
}

#[derive(Clone, Copy, Default)]
pub struct ThreadPoolState {
    pub capacity: usize,
    pub worker_count: usize,
    pub queued_task_count: Option<usize>,
    pub in_flight_runs: usize,
    pub run_enqueued: usize,
    pub run_started: usize,
    pub run_completed: usize,
    pub add_thread_requested: usize,
    pub add_thread_completed: usize,
    pub add_thread_disconnected: usize,
    pub terminate_requested: usize,
    pub terminate_completed: usize,
    pub terminate_disconnected: usize,
}

pub struct DebugState {
    events: VecDeque<String>,
    buffered_len: usize,
    limit: usize,
    dropped_events: usize,
    ra_boundary_dropped: usize,
    cargo: Option<usize>,
    rustc: Option<usize>,
    stdout: Option<PipeState>,
    stderr: Option<PipeState>,
    wait: Option<String>,
}

impl DebugState {
    pub fn new(limit: usize) -> Self {
        Self {
            events: VecDeque::new(),
            buffered_len: 0,
            limit,
            dropped_events: 0,
            ra_boundary_dropped: 0,
            cargo: None,
            rustc: None,
            stdout: None,
            stderr: None,
            wait: None,
        }
    }

    pub fn push_event(&mut self, event: &str) {
        let line = Self::event_line(event);
        if self.buffered_len.saturating_add(line.len()) > self.limit {
            self.dropped_events = self.dropped_events.saturating_add(1);
            return;
        }
        self.buffered_len += line.len();
        self.events.push_back(line);
    }

    pub fn push_snapshot(&mut self, snapshot: &str) {
        let line = Self::bounded_snapshot_line(snapshot, self.limit);
        while self.buffered_len.saturating_add(line.len()) > self.limit {
            let Some(evicted) = self.events.pop_front() else {
                break;
            };
            self.buffered_len -= evicted.len();
            self.dropped_events = self.dropped_events.saturating_add(1);
        }
        self.buffered_len += line.len();
        self.events.push_back(line);
    }

    pub fn buffered_len(&self) -> usize {
        self.buffered_len
    }

    pub fn dropped_events(&self) -> usize {
        self.dropped_events
    }

    pub fn set_ra_boundary_dropped(&mut self, dropped: usize) {
        self.ra_boundary_dropped = dropped;
    }

    pub fn drain(&mut self, max_bytes: usize) -> Vec<u8> {
        let mut drained = Vec::new();
        while let Some(line) = self.events.front() {
            if drained.len().saturating_add(line.len()) > max_bytes {
                break;
            }
            let line = self.events.pop_front().expect("front event must exist");
            self.buffered_len -= line.len();
            drained.extend_from_slice(line.as_bytes());
        }
        drained
    }

    pub fn cargo_enter(&mut self, invocation_id: usize) {
        self.cargo = Some(invocation_id);
    }

    pub fn cargo_return(&mut self, invocation_id: usize) {
        if self.cargo == Some(invocation_id) {
            self.cargo = None;
            self.wait = None;
        }
    }

    pub fn rustc_enter(&mut self, invocation_id: usize) {
        self.rustc = Some(invocation_id);
        self.stdout = None;
        self.stderr = None;
    }

    pub fn rustc_return(&mut self, invocation_id: usize) {
        if self.rustc == Some(invocation_id) {
            self.rustc = None;
            self.stdout = None;
            self.stderr = None;
        }
    }

    pub fn set_pipe_state(
        &mut self,
        invocation_id: usize,
        kind: PipeKind,
        bytes: usize,
        eof: bool,
    ) {
        if self.rustc != Some(invocation_id) {
            return;
        }
        let state = Some(PipeState {
            invocation_id,
            bytes,
            eof,
        });
        match kind {
            PipeKind::Stdout => self.stdout = state,
            PipeKind::Stderr => self.stderr = state,
        }
    }

    pub fn set_wait(&mut self, wait: &str) {
        self.wait = Some(wait.to_owned());
    }

    pub fn snapshot_line(&self, thread_pool: ThreadPoolState) -> String {
        let stdout = self.stdout.unwrap_or_default();
        let stderr = self.stderr.unwrap_or_default();
        format!(
            "snapshot cargo={} rustc={} stdout_id={} stdout_bytes={} stdout_eof={} stderr_id={} stderr_bytes={} stderr_eof={} wait={} dropped_events={} ra_boundary_dropped={} capacity={} worker_count={} queued_task_count={} in_flight_runs={} run_enqueued={} run_started={} run_completed={} add_thread_requested={} add_thread_completed={} add_thread_disconnected={} terminate_requested={} terminate_completed={} terminate_disconnected={}",
            Self::optional_id(self.cargo),
            Self::optional_id(self.rustc),
            Self::optional_pipe_id(self.stdout, stdout.invocation_id),
            stdout.bytes,
            stdout.eof,
            Self::optional_pipe_id(self.stderr, stderr.invocation_id),
            stderr.bytes,
            stderr.eof,
            self.wait.as_deref().unwrap_or("none"),
            self.dropped_events,
            self.ra_boundary_dropped,
            thread_pool.capacity,
            thread_pool.worker_count,
            Self::optional_count(thread_pool.queued_task_count),
            thread_pool.in_flight_runs,
            thread_pool.run_enqueued,
            thread_pool.run_started,
            thread_pool.run_completed,
            thread_pool.add_thread_requested,
            thread_pool.add_thread_completed,
            thread_pool.add_thread_disconnected,
            thread_pool.terminate_requested,
            thread_pool.terminate_completed,
            thread_pool.terminate_disconnected,
        )
    }

    pub fn snapshot_line_trace_disabled(&self) -> String {
        self.snapshot_line_with_thread_pool_status("trace-disabled")
    }

    pub fn snapshot_line_thread_pool_uninitialized(&self) -> String {
        self.snapshot_line_with_thread_pool_status("uninitialized")
    }

    fn snapshot_line_with_thread_pool_status(&self, thread_pool_status: &str) -> String {
        let stdout = self.stdout.unwrap_or_default();
        let stderr = self.stderr.unwrap_or_default();
        format!(
            "snapshot cargo={} rustc={} stdout_id={} stdout_bytes={} stdout_eof={} stderr_id={} stderr_bytes={} stderr_eof={} wait={} dropped_events={} ra_boundary_dropped={} thread_pool={thread_pool_status}",
            Self::optional_id(self.cargo),
            Self::optional_id(self.rustc),
            Self::optional_pipe_id(self.stdout, stdout.invocation_id),
            stdout.bytes,
            stdout.eof,
            Self::optional_pipe_id(self.stderr, stderr.invocation_id),
            stderr.bytes,
            stderr.eof,
            self.wait.as_deref().unwrap_or("none"),
            self.dropped_events,
            self.ra_boundary_dropped,
        )
    }

    fn event_line(event: &str) -> String {
        format!("{EVENT_PREFIX}{event}{EVENT_SUFFIX}")
    }

    fn bounded_snapshot_line(snapshot: &str, limit: usize) -> String {
        let line = Self::event_line(snapshot);
        if line.len() <= limit {
            return line;
        }

        let framing_len = EVENT_PREFIX.len().saturating_add(EVENT_SUFFIX.len());
        let Some(payload_limit) = limit.checked_sub(framing_len) else {
            return Self::compact_snapshot_line(limit);
        };
        if payload_limit == 0 {
            return Self::compact_snapshot_line(limit);
        }
        let truncation_suffix = if payload_limit >= SNAPSHOT_TRUNCATION_SUFFIX.len() {
            SNAPSHOT_TRUNCATION_SUFFIX
        } else {
            "~"
        };
        let mut end = snapshot
            .len()
            .min(payload_limit.saturating_sub(truncation_suffix.len()));
        while !snapshot.is_char_boundary(end) {
            end -= 1;
        }

        let mut bounded = String::with_capacity(limit);
        bounded.push_str(EVENT_PREFIX);
        bounded.push_str(&snapshot[..end]);
        bounded.push_str(truncation_suffix);
        bounded.push_str(EVENT_SUFFIX);
        bounded
    }

    fn compact_snapshot_line(limit: usize) -> String {
        const COMPACT_SNAPSHOT: &str = "snapshot";
        if limit == 0 {
            return String::new();
        }
        let content_len = limit.saturating_sub(1).min(COMPACT_SNAPSHOT.len());
        format!("{}~", &COMPACT_SNAPSHOT[..content_len])
    }

    fn optional_id(id: Option<usize>) -> String {
        id.map_or_else(|| "none".to_owned(), |id| id.to_string())
    }

    fn optional_pipe_id(pipe: Option<PipeState>, id: usize) -> String {
        pipe.map_or_else(|| "none".to_owned(), |_| id.to_string())
    }

    fn optional_count(count: Option<usize>) -> String {
        count.map_or_else(|| "none".to_owned(), |count| count.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_is_bounded_and_counts_dropped_events() {
        let mut state = DebugState::new(32);
        state.push_event("first");
        state.push_event("x".repeat(64).as_str());
        assert!(state.buffered_len() <= 32);
        assert_eq!(state.dropped_events(), 1);
        assert!(
            String::from_utf8(state.drain(32))
                .unwrap()
                .contains("first")
        );
    }

    #[test]
    fn snapshot_reports_outstanding_lifecycle_state() {
        let mut state = DebugState::new(1024);
        state.cargo_enter(7);
        state.rustc_enter(11);
        state.set_pipe_state(11, PipeKind::Stdout, 24, false);
        state.set_wait("cargo-main");
        let snapshot = state.snapshot_line(ThreadPoolState {
            capacity: 14,
            worker_count: 15,
            queued_task_count: Some(0),
            in_flight_runs: 1,
            run_enqueued: 4,
            run_started: 4,
            run_completed: 4,
            add_thread_requested: 2,
            add_thread_completed: 2,
            add_thread_disconnected: 1,
            terminate_requested: 3,
            terminate_completed: 3,
            terminate_disconnected: 0,
        });
        assert!(snapshot.contains("cargo=7"));
        assert!(snapshot.contains("rustc=11"));
        assert!(snapshot.contains("stdout_bytes=24"));
        assert!(snapshot.contains("wait=cargo-main"));
        assert!(snapshot.contains("in_flight_runs=1"));
        assert!(snapshot.contains("queued_task_count=0"));
        assert!(snapshot.contains("add_thread_disconnected=1"));
        assert!(snapshot.contains("terminate_requested=3"));
        assert_eq!(snapshot.matches("queued_task_count=").count(), 1);
        assert!(!snapshot.contains("queued_tasks="));
        assert!(!snapshot.contains("completion_disconnected="));
    }

    #[test]
    fn priority_snapshot_evicts_old_events_instead_of_being_dropped() {
        let mut state = DebugState::new(64);
        state.push_event("old-one");
        state.push_event("old-two");
        state.push_snapshot("snapshot wait=cargo-main");
        let output = String::from_utf8(state.drain(64)).unwrap();
        assert!(output.contains("snapshot wait=cargo-main"));
        assert!(state.dropped_events() > 0);
    }

    #[test]
    fn oversized_priority_snapshot_is_truncated_and_retained() {
        let mut state = DebugState::new(64);
        state.push_event("old-event");
        state.push_snapshot(&format!("snapshot marker={} END", "\u{e9}".repeat(128)));

        let bytes = state.drain(64);
        assert!(!bytes.is_empty());
        assert!(bytes.len() <= 64);
        let output = String::from_utf8(bytes).expect("snapshot truncation must preserve UTF-8");
        assert!(output.contains("snapshot"));
        assert!(output.contains("[truncated]"));
        assert!(!output.contains(" END"));
    }

    #[test]
    fn oversized_priority_snapshot_survives_tiny_nonzero_capacity() {
        let mut state = DebugState::new(8);
        state.push_snapshot(&format!("snapshot {}", "\u{e9}".repeat(128)));

        let bytes = state.drain(8);
        assert!(!bytes.is_empty());
        assert!(bytes.len() <= 8);
        let output = String::from_utf8(bytes).expect("compact snapshot marker must be valid UTF-8");
        assert!(output.ends_with('~'));
    }

    #[test]
    fn debug_capture_accepts_only_structured_lifecycle_events() {
        for event in [
            "command:return",
            "wasi-ext-spawn:run-rustc:enter",
            "wasi-ext-spawn:return status=7",
            "cargo:memory:after-main pages=56",
            "rustc:_main:return",
            "pool:capacity capacity=2",
            "host-cargo:request id=41",
            "host-cargo:response id=41 status=0",
            "host-cargo:reject id=42 status=1",
            "host-run-cargo:cargo:run_cargo id=41",
            "debug-rustc:return run=4",
        ] {
            assert!(
                is_lifecycle_event(event),
                "expected lifecycle event: {event}"
            );
        }

        for event in [
            "command:start cargo check --message-format=json",
            "wasi-ext-spawn:run-rustc:enter args=[\"src/main.rs\"]",
            "wasi-ext-spawn:run-rustc:panic fn main() leaked",
            "child-process:cwd /workspace/src",
            "child-process:filesystem-conflicts [\"src/main.rs\"]",
        ] {
            assert!(!is_lifecycle_event(event), "rejected raw event: {event}");
        }
    }

    #[test]
    fn matching_returns_clear_active_lifecycle_state() {
        let mut state = DebugState::new(1024);
        state.cargo_enter(7);
        state.rustc_enter(11);
        state.set_pipe_state(11, PipeKind::Stdout, 24, true);
        state.set_wait("cargo-main");

        state.cargo_return(8);
        state.rustc_return(12);
        let active = state.snapshot_line(ThreadPoolState::default());
        assert!(active.contains("cargo=7"));
        assert!(active.contains("rustc=11"));
        assert!(active.contains("stdout_bytes=24"));
        assert!(active.contains("wait=cargo-main"));

        state.rustc_return(11);
        state.cargo_return(7);
        let returned = state.snapshot_line(ThreadPoolState::default());
        assert!(returned.contains("cargo=none"));
        assert!(returned.contains("rustc=none"));
        assert!(returned.contains("stdout_id=none"));
        assert!(returned.contains("wait=none"));
    }

    #[test]
    fn pipe_updates_only_apply_to_the_active_rustc_invocation() {
        let mut state = DebugState::new(1024);
        state.rustc_enter(11);
        state.set_pipe_state(12, PipeKind::Stdout, 24, false);
        assert!(
            state
                .snapshot_line(ThreadPoolState::default())
                .contains("stdout_id=none")
        );

        state.rustc_return(11);
        state.set_pipe_state(11, PipeKind::Stdout, 48, true);
        assert!(
            state
                .snapshot_line(ThreadPoolState::default())
                .contains("stdout_id=none")
        );
    }

    #[test]
    fn trace_disabled_snapshot_does_not_report_fake_pool_counts() {
        let mut state = DebugState::new(1024);
        state.cargo_enter(7);
        let snapshot = state.snapshot_line_trace_disabled();
        assert!(snapshot.contains("cargo=7"));
        assert!(snapshot.contains("thread_pool=trace-disabled"));
        assert!(!snapshot.contains("thread_pool_capacity="));
    }

    #[test]
    fn uninitialized_thread_pool_snapshot_does_not_report_fake_counts() {
        let mut state = DebugState::new(1024);
        state.set_wait("cargo-main");
        let snapshot = state.snapshot_line_thread_pool_uninitialized();
        assert!(snapshot.contains("wait=cargo-main"));
        assert!(snapshot.contains("thread_pool=uninitialized"));
        assert!(!snapshot.contains("capacity="));
    }

    #[test]
    fn ra_boundary_dropped_is_in_every_wait_snapshot() {
        let mut state = DebugState::new(4096);
        state.set_ra_boundary_dropped(7);

        for snapshot in [
            state.snapshot_line(ThreadPoolState::default()),
            state.snapshot_line_trace_disabled(),
            state.snapshot_line_thread_pool_uninitialized(),
        ] {
            assert!(snapshot.contains("ra_boundary_dropped=7"), "{snapshot}");
        }
    }
}
