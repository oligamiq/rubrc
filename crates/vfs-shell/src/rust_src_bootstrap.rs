use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum RustSrcLoadState {
    NotStarted = 0,
    Loading = 1,
    Ready = 2,
    Failed = 3,
}

pub struct RustSrcBootstrap {
    state: AtomicU8,
}

impl RustSrcBootstrap {
    pub const fn new() -> Self {
        Self {
            state: AtomicU8::new(RustSrcLoadState::NotStarted as u8),
        }
    }

    pub fn state(&self) -> RustSrcLoadState {
        match self.state.load(Ordering::Acquire) {
            0 => RustSrcLoadState::NotStarted,
            1 => RustSrcLoadState::Loading,
            2 => RustSrcLoadState::Ready,
            3 => RustSrcLoadState::Failed,
            _ => unreachable!("invalid rust-src bootstrap state"),
        }
    }

    pub fn begin(&self) -> bool {
        self.state
            .compare_exchange(
                RustSrcLoadState::NotStarted as u8,
                RustSrcLoadState::Loading as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub fn finish(&self, ready: bool) {
        let target = if ready {
            RustSrcLoadState::Ready
        } else {
            RustSrcLoadState::Failed
        } as u8;
        let _ = self.state.compare_exchange(
            RustSrcLoadState::Loading as u8,
            target,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{RustSrcBootstrap, RustSrcLoadState};

    #[test]
    fn bootstrap_transitions_once_to_ready() {
        let state = RustSrcBootstrap::new();
        assert_eq!(state.state(), RustSrcLoadState::NotStarted);
        assert!(state.begin());
        assert_eq!(state.state(), RustSrcLoadState::Loading);
        state.finish(true);
        assert_eq!(state.state(), RustSrcLoadState::Ready);
        assert!(!state.begin());
        state.finish(false);
        assert_eq!(state.state(), RustSrcLoadState::Ready);
    }

    #[test]
    fn bootstrap_transitions_once_to_failed() {
        let state = RustSrcBootstrap::new();
        assert!(state.begin());
        state.finish(false);
        assert_eq!(state.state(), RustSrcLoadState::Failed);
        assert!(!state.begin());
        state.finish(true);
        assert_eq!(state.state(), RustSrcLoadState::Failed);
    }
}
