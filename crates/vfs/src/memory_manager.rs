use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use wasi_virt_layer::memory::{WasmAccess, WasmAccessName};

#[derive(Debug, Clone, Copy)]
pub(crate) struct TargetConfig {
    pub min_pages: i32,
    pub reserve_pages: i32,
}

pub(crate) struct MemoryReserveManager {
    thread_margin: TargetConfig,
}

impl MemoryReserveManager {
    const fn new(thread_margin: TargetConfig) -> Self {
        Self { thread_margin }
    }

    fn warn_failed(name: &str, config: TargetConfig, current: i32, reserve_pages: i32) {
        eprintln!(
            "\x1b[33m[memory] failed to reserve {} pages for {} (have {}, need {})\x1b[0m",
            reserve_pages, name, current, config.min_pages
        );
    }

    pub fn ensure_once<Wasm: WasmAccess + WasmAccessName>(
        &self,
        reserve: &TargetReserveOnce,
        config: TargetConfig,
    ) {
        let mut reserved = reserve.reserved.lock();
        if *reserved {
            return;
        }

        let current = crate::memory_size::<Wasm>();
        if current >= config.min_pages {
            *reserved = true;
            return;
        }

        let reserve_pages = config.reserve_pages.max(config.min_pages - current);
        let result = crate::memory_reserve::<Wasm>(reserve_pages);
        if result <= 0 {
            Self::warn_failed(Wasm::NAME, config, current, reserve_pages);
            return;
        }

        *reserved = true;
    }

    pub fn reserve_for_thread(&self) {
        let config = self.thread_margin;
        let current = crate::memory_size_self();
        if current < config.min_pages {
            let result = crate::memory_reserve_self(config.reserve_pages);
            if result <= 0 {
                Self::warn_failed("__self", config, current, config.reserve_pages);
            }
        }
    }
}

pub(crate) struct TargetReserveOnce {
    reserved: parking_lot::Mutex<bool>,
}

impl TargetReserveOnce {
    pub const fn new() -> Self {
        Self {
            reserved: parking_lot::Mutex::new(false),
        }
    }
}

pub(crate) struct StartOnce {
    started: AtomicBool,
}

impl StartOnce {
    pub const fn new() -> Self {
        Self {
            started: AtomicBool::new(false),
        }
    }

    pub fn try_start(&self) -> bool {
        !self.started.swap(true, Ordering::SeqCst)
    }

    pub fn is_started(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }
}

pub(crate) const THREAD_SELF_CONFIG: TargetConfig = TargetConfig {
    min_pages: 1024,
    reserve_pages: 1024,
};

pub(crate) const RUSTC_CONFIG: TargetConfig = TargetConfig {
    min_pages: 4096,
    reserve_pages: 4096,
};

pub(crate) const LLVM_CONFIG: TargetConfig = TargetConfig {
    min_pages: 4096,
    reserve_pages: 4096,
};

pub(crate) const LSP_CONFIG: TargetConfig = TargetConfig {
    min_pages: 2048,
    reserve_pages: 2048,
};

pub(crate) const CARGO_CONFIG: TargetConfig = TargetConfig {
    min_pages: 2048,
    reserve_pages: 2048,
};

pub(crate) const VFS_SHELL_CONFIG: TargetConfig = TargetConfig {
    min_pages: 1024,
    reserve_pages: 1024,
};

pub(crate) static MEMORY_MANAGER: LazyLock<MemoryReserveManager> =
    LazyLock::new(|| MemoryReserveManager::new(THREAD_SELF_CONFIG));

pub(crate) static CARGO_RESERVE_ONCE: TargetReserveOnce = TargetReserveOnce::new();
pub(crate) static RUSTC_RESERVE_ONCE: TargetReserveOnce = TargetReserveOnce::new();
pub(crate) static LLVM_RESERVE_ONCE: TargetReserveOnce = TargetReserveOnce::new();
pub(crate) static LSP_RESERVE_ONCE: TargetReserveOnce = TargetReserveOnce::new();
pub(crate) static VFS_SHELL_RESERVE_ONCE: TargetReserveOnce = TargetReserveOnce::new();

pub(crate) static LSP_START_ONCE: StartOnce = StartOnce::new();
