//! Core-only relocation lock shared by the WASM exports and native tests.
//!
//! Both variants prefer readers: the waiting marker does not bar new readers.
//! As in the original lock, an unending reader workload can starve a writer.

use core::sync::atomic::{AtomicI32, Ordering};

// The candidate's sticky marker shares the reader-count word. It is cleared
// only by writer acquisition; a separate waiter counter would require a
// cross-atomic registration/notification protocol.
const WAITING: i32 = if cfg!(feature = "waiter-aware-memory-lock") {
    1 << 30
} else {
    0
};
#[cfg(feature = "waiter-aware-memory-lock")]
const MAX_READERS: i32 = WAITING - 1;

/// Backend wait must atomically compare the state and register the waiter.
pub(super) trait WaitNotify {
    fn wait(&self, state: &AtomicI32, expected: i32);
    fn notify(&self, state: &AtomicI32, count: u32);

    #[cfg(test)]
    fn before_writer_register(&self, _state: &AtomicI32, _expected: i32) {}

    #[cfg(test)]
    fn reader_saturated(&self, _state: &AtomicI32) {}
}

/// One shared atomic word; no per-thread state or allocations.
pub(super) struct MemoryAccessLock {
    state: AtomicI32,
}

impl MemoryAccessLock {
    pub(super) const fn new() -> Self {
        Self {
            state: AtomicI32::new(0),
        }
    }

    #[inline(always)]
    pub(super) fn read_acquire(&self, backend: &impl WaitNotify) {
        loop {
            let old = self.state.load(Ordering::Relaxed);
            if old >= 0 {
                #[cfg(feature = "waiter-aware-memory-lock")]
                if old & MAX_READERS == MAX_READERS {
                    #[cfg(test)]
                    backend.reader_saturated(&self.state);
                    core::hint::spin_loop();
                    continue;
                }
                if self
                    .state
                    .compare_exchange_weak(old, old + 1, Ordering::Acquire, Ordering::Relaxed)
                    .is_ok()
                {
                    return;
                }
            } else {
                backend.wait(&self.state, old);
            }
        }
    }

    #[inline(always)]
    pub(super) fn read_release(&self, backend: &impl WaitNotify) {
        if self.state.fetch_sub(1, Ordering::Release) == (WAITING | 1) {
            backend.notify(&self.state, 1);
        }
    }

    #[inline(always)]
    pub(super) fn write_acquire(&self, backend: &impl WaitNotify) {
        #[cfg(not(feature = "waiter-aware-memory-lock"))]
        loop {
            match self
                .state
                .compare_exchange(0, -1, Ordering::Acquire, Ordering::Relaxed)
            {
                Ok(_) => return,
                Err(0) => continue,
                Err(current) => backend.wait(&self.state, current),
            }
        }

        #[cfg(feature = "waiter-aware-memory-lock")]
        loop {
            let mut current = self.state.load(Ordering::Relaxed);
            if current == 0 || current == WAITING {
                if self
                    .state
                    .compare_exchange_weak(current, -1, Ordering::Acquire, Ordering::Relaxed)
                    .is_ok()
                {
                    return;
                }
                continue;
            }
            if current > 0 && current & WAITING == 0 {
                #[cfg(test)]
                backend.before_writer_register(&self.state, current);
                // An RMW preserves the release sequence. If the last reader
                // already left, CAS fails and the loop acquires instead of
                // parking without a future notifier.
                if self
                    .state
                    .compare_exchange_weak(
                        current,
                        current | WAITING,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    )
                    .is_err()
                {
                    continue;
                }
                current |= WAITING;
            }
            // compare-and-park handles a release before parking; the sticky
            // marker handles reader-count ABA. The writer-release broadcast
            // wakes every waiter at this address, regardless of expected value.
            backend.wait(&self.state, current);
        }
    }

    #[inline(always)]
    pub(super) fn write_release(&self, backend: &impl WaitNotify) {
        self.state.store(0, Ordering::Release);
        backend.notify(&self.state, u32::MAX);
    }
}

#[cfg(test)]
#[path = "../tests/support/memory_lock_cases.rs"]
mod tests;
