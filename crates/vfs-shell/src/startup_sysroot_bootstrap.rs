use std::sync::{Mutex, MutexGuard};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub(crate) enum StartupSysroot {
    RustSrc = 0,
    Target = 1,
}

impl TryFrom<u32> for StartupSysroot {
    type Error = StartupSysrootError;

    fn try_from(kind: u32) -> Result<Self, Self::Error> {
        match kind {
            0 => Ok(Self::RustSrc),
            1 => Ok(Self::Target),
            _ => Err(StartupSysrootError::InvalidKind),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub(crate) enum LoadState {
    NotStarted = 0,
    Loading = 1,
    Ready = 2,
    Failed = 3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub(crate) enum StartupSysrootError {
    None = 0,
    Fetch = 1,
    Extract = 2,
    MissingSentinel = 3,
    InvalidKind = 4,
}

impl StartupSysrootError {
    pub(crate) fn from_load_error(message: &str) -> Self {
        if message.contains("failed to fetch sysroot archive")
            || message.contains("is unavailable")
            || message.contains("invalid sysroot archive status")
            || message.contains("invalid sysroot archive length")
        {
            Self::Fetch
        } else {
            Self::Extract
        }
    }
}

#[derive(Clone, Copy)]
struct BootstrapState {
    state: LoadState,
    error: StartupSysrootError,
}

impl BootstrapState {
    const NOT_STARTED: Self = Self {
        state: LoadState::NotStarted,
        error: StartupSysrootError::None,
    };
}

pub(crate) struct StartupSysrootBootstraps {
    states: Mutex<[BootstrapState; 2]>,
}

impl StartupSysrootBootstraps {
    pub(crate) const fn new() -> Self {
        Self {
            states: Mutex::new([BootstrapState::NOT_STARTED; 2]),
        }
    }

    fn states(&self) -> MutexGuard<'_, [BootstrapState; 2]> {
        self.states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn state(&self, kind: StartupSysroot) -> LoadState {
        self.states()[kind as usize].state
    }

    pub(crate) fn error(&self, kind: StartupSysroot) -> StartupSysrootError {
        self.states()[kind as usize].error
    }

    pub(crate) fn begin(&self, kind: StartupSysroot) -> bool {
        let mut states = self.states();
        let bootstrap = &mut states[kind as usize];
        if matches!(bootstrap.state, LoadState::Loading | LoadState::Ready) {
            return false;
        }
        bootstrap.state = LoadState::Loading;
        bootstrap.error = StartupSysrootError::None;
        true
    }

    pub(crate) fn finish(&self, kind: StartupSysroot, result: Result<(), StartupSysrootError>) {
        let mut states = self.states();
        let bootstrap = &mut states[kind as usize];
        if bootstrap.state != LoadState::Loading {
            return;
        }
        match result {
            Ok(()) => {
                bootstrap.state = LoadState::Ready;
                bootstrap.error = StartupSysrootError::None;
            }
            Err(error) => {
                bootstrap.state = LoadState::Failed;
                bootstrap.error = error;
            }
        }
    }

    pub(crate) fn load_state_code(&self, kind: u32) -> u32 {
        StartupSysroot::try_from(kind)
            .map(|kind| self.state(kind) as u32)
            .unwrap_or(LoadState::Failed as u32)
    }

    pub(crate) fn error_code(&self, kind: u32) -> u32 {
        StartupSysroot::try_from(kind)
            .map(|kind| self.error(kind) as u32)
            .unwrap_or(StartupSysrootError::InvalidKind as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::{LoadState, StartupSysroot, StartupSysrootBootstraps, StartupSysrootError};

    #[test]
    fn startup_sysroot_bootstrap_states_and_errors_are_independent() {
        let bootstraps = StartupSysrootBootstraps::new();

        assert_eq!(
            bootstraps.state(StartupSysroot::RustSrc),
            LoadState::NotStarted
        );
        assert_eq!(
            bootstraps.state(StartupSysroot::Target),
            LoadState::NotStarted
        );
        assert!(bootstraps.begin(StartupSysroot::RustSrc));
        assert!(!bootstraps.begin(StartupSysroot::RustSrc));
        bootstraps.finish(
            StartupSysroot::RustSrc,
            Err(StartupSysrootError::MissingSentinel),
        );

        assert_eq!(bootstraps.state(StartupSysroot::RustSrc), LoadState::Failed);
        assert_eq!(
            bootstraps.error(StartupSysroot::RustSrc),
            StartupSysrootError::MissingSentinel
        );
        assert!(bootstraps.begin(StartupSysroot::RustSrc));
        assert_eq!(
            bootstraps.state(StartupSysroot::RustSrc),
            LoadState::Loading
        );
        assert_eq!(
            bootstraps.error(StartupSysroot::RustSrc),
            StartupSysrootError::None
        );
        assert_eq!(
            bootstraps.state(StartupSysroot::Target),
            LoadState::NotStarted
        );
        assert_eq!(
            bootstraps.error(StartupSysroot::Target),
            StartupSysrootError::None
        );

        assert!(bootstraps.begin(StartupSysroot::Target));
        bootstraps.finish(StartupSysroot::Target, Ok(()));
        assert_eq!(bootstraps.state(StartupSysroot::Target), LoadState::Ready);
        assert_eq!(
            bootstraps.error(StartupSysroot::Target),
            StartupSysrootError::None
        );
        assert!(!bootstraps.begin(StartupSysroot::Target));
    }

    #[test]
    fn startup_sysroot_bootstrap_scalar_access_rejects_invalid_kinds() {
        let bootstraps = StartupSysrootBootstraps::new();

        assert_eq!(bootstraps.load_state_code(0), LoadState::NotStarted as u32);
        assert_eq!(bootstraps.error_code(0), StartupSysrootError::None as u32);
        assert_eq!(bootstraps.load_state_code(1), LoadState::NotStarted as u32);
        assert_eq!(bootstraps.error_code(1), StartupSysrootError::None as u32);
        assert_eq!(bootstraps.load_state_code(2), LoadState::Failed as u32);
        assert_eq!(
            bootstraps.error_code(2),
            StartupSysrootError::InvalidKind as u32
        );
    }

    #[test]
    fn startup_sysroot_bootstrap_classifies_load_errors() {
        assert_eq!(
            StartupSysrootError::from_load_error("failed to fetch sysroot archive for 'rust-src'"),
            StartupSysrootError::Fetch
        );
        assert_eq!(
            StartupSysrootError::from_load_error(
                "sysroot archive for 'wasm32-wasip1' is unavailable"
            ),
            StartupSysrootError::Fetch
        );
        assert_eq!(
            StartupSysrootError::from_load_error(
                "invalid sysroot archive status 7 for 'wasm32-wasip1'"
            ),
            StartupSysrootError::Fetch
        );
        assert_eq!(
            StartupSysrootError::from_load_error("invalid sysroot archive length: -1"),
            StartupSysrootError::Fetch
        );
        assert_eq!(
            StartupSysrootError::from_load_error("failed to decode sysroot archive entry"),
            StartupSysrootError::Extract
        );
    }
}
