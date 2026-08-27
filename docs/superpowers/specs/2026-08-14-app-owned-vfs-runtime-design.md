# App-Owned VFS Runtime Design

## Context

The staged rust-analyzer startup design gives each mounted application generation its own `SysrootArchiveStore`. The current worker topology does not share that lifetime:

- `index.tsx` creates a persistent outer worker.
- The outer worker creates a nested utility worker that owns `vfs_root`.
- `SetupMyTerminal` creates a `WASIFarm` whose callback reads the generation-owned archive store.
- Neither the nested utility worker nor the farm is destroyed when the application generation ends.

This permits an old worker to invoke the sysroot callback after its archive store has been disposed. Additional-target status polling and cooperative cancellation cannot make this safe because sysroot extraction runs synchronously in the same utility worker that would have to process the cancel or status message.

This design supersedes only the runtime ownership and teardown portions of the staged startup design. The approved startup order, immediate editable model, overlay, readiness checks, and Run gating remain unchanged.

## Decision

Each mounted `App` generation owns one `AppRuntime`. The runtime owns all resources that can call or be called by that generation:

- a fresh `Ctx`;
- the worker that directly owns `vfs_root`;
- a lifecycle worker that owns the transferable Animal destroyer;
- the associated `WASIFarm`;
- the `SysrootArchiveStore` used by the farm callback;
- runtime-level `SharedObject` and `SharedObjectRef` channels;
- generation-owned parser and compile/run services;
- abortable HTTP and child-process bridges used by farm callbacks;
- the runtime generation token and readiness state.

A page-level `RuntimeSupervisor` owns only the current-generation slot and any quarantined runtime. A creation request waits for an ordinary pending teardown to prove Animal and utility-worker quiescence. If teardown enters quarantine, the supervisor blocks later generations and requires a page reload.

The intermediate outer worker is removed. `AppRuntime` starts the existing utility worker directly and sends it the `Ctx` and farm reference. A remount creates a new runtime with a new `Ctx`, worker, farm, store, and generation token. No runtime resource is reused across generations.

`App` receives the runtime rather than separately receiving `ctx`, a worker termination callback, and an archive store. UI components may borrow runtime services, but they do not own or dispose those services individually. The `StartupCoordinator` is registered with the runtime immediately after construction, so `runtime.dispose()` remains the sole application cleanup entrypoint.

`workspaceFileSystem` is intentionally not generation-owned. It is page-level user data, including the editable source, and survives a runtime restart. Runtime generation isolation applies to workers, callbacks, channels, readiness, and instrumentation rather than deleting user files.

## Startup Flow

1. The entrypoint asks `RuntimeSupervisor` to create a new `AppRuntime`. It waits if an earlier runtime is still performing ordinary teardown and fails with a reload-required state only if that runtime enters quarantine.
2. `App` immediately creates or reuses `file:///src/main.rs`, attaches it as a plaintext Monaco model, and leaves it editable.
3. Runtime initialization creates its `WASIFarm` independently of terminal component mounts. Runtime-owned stdin/stdout/stderr adapters route through a generation-qualified terminal service. Terminal mounts only register and unregister views against that service.
4. The farm's unknown-function callback uses the runtime's archive store. Sysroot archive operations remain synchronous; an async callback is not permitted to retain or resume access to the store.
5. The runtime passes the farm reference and its generation-specific `Ctx` directly to the utility worker.
6. The utility worker creates one thread-enabled `WASIFarmAnimal`, immediately creates a `DestroyerHandle`, and posts its cloneable handle object to the runtime before it starts or exposes `vfs_root`.
7. The runtime forwards the handle object to its independent lifecycle worker. That worker reconstructs the destroyer and acknowledges ownership. The utility worker may proceed only after the runtime receives this acknowledgement.
8. The utility worker instantiates `vfs_root`, registers all handlers, and reports runtime readiness.
9. The existing `StartupCoordinator` continues with sysroot prefetch, lightweight rust-analyzer initialization, startup sysroot installation, full project activation, crate-graph readiness, diagnostics, and inlay hints.
10. Additional targets are prefetched into the same runtime-owned store and loaded serially by the same runtime.

The UI remains usable while startup runs. The overlay is local to the editor and does not intercept pointer input. Run and target operations remain disabled until startup reaches `ready`.

## Runtime Interface

The concrete API may use equivalent names, but it must expose one cohesive owner rather than independent resources:

```ts
type AppRuntime = {
  readonly ctx: Ctx;
  readonly archiveStore: SysrootArchiveStore;
  readonly signal: AbortSignal;

  start(): Promise<void>;
  attachTerminal(sessionId: number, view: TerminalView): { dispose(): void };
  adoptCoordinator(owner: { dispose(): Promise<void> }): void;
  flush(): Promise<void>;
  run(triple?: string): Promise<void>;
  loadTarget(triple: string): Promise<void>;
  subscribe(listener: (state: RuntimeState) => void): () => void;
  reportFatal(error: unknown): void;
  dispose(): Promise<void>;
};
```

`start()` initializes only the VFS runtime and its channels. The Monaco model and rust-analyzer startup remain coordinated by `App` because they require the mounted editor, but their coordinator is adopted by the runtime before it starts. Run and target services are exposed through the runtime so their proxies and state are generation-owned.

The runtime must reject duplicate `start()` calls or coordinator adoption for one generation. `App` constructs and adopts the coordinator in one synchronous helper that either stores ownership or disposes the unadopted coordinator before returning an error. Terminal views may mount and unmount repeatedly without recreating the farm or worker. A fatal worker failure transitions the runtime once and prevents new operations.

## Shim Lifecycle Patch

The installed `@oligami/browser_wasi_shim-threads@0.4.1` destroyer implementation is not usable as shipped:

- its transferable object retains a `WorkerBackgroundRef` class instance, but reconstruction does not restore the prototype;
- its constructor starts a listener whose initial wait completes immediately and clears the handle before explicit destruction;
- the background coordinator destroys managed workers but does not close itself;
- `ThreadSpawner.destroy()` drops its background-worker reference without terminating it.

The implementation includes a reproducible Bun dependency patch recorded through `bun patch --commit`; it does not rely on an untracked `node_modules` edit. The patch must:

1. Store `WorkerBackgroundRefObject` in the destroyer transfer object and reconstruct it with `WorkerBackgroundRef.init_self()`.
2. Make explicit, idempotent `destroy()` consume the handle and remove the incorrect eager listener cleanup.
3. Terminate managed spawned/start workers, issue the background coordinator's own `close()` as its final action, and only then complete the blocking destroy acknowledgement.
4. Make `ThreadSpawner.destroy()` terminate and clear its directly held background-worker reference.
5. Preserve public API compatibility and add tests for transfer/reconstruction, destroy acknowledgement, repeated destroy, managed-worker termination, and coordinator closure.

The Bun patch captures source and built distribution because application imports resolve to `dist`. Build and lifecycle tests fail when this contract is unavailable; there is no unsafe fallback.

The dependency is pinned to exact version `0.4.1` while the patch is active. Upgrading it requires regenerating and re-verifying the patch rather than relying on a semver range against minified output. This is intentionally a repository-local stabilization until the same lifecycle fixes are available upstream.

## Worker Topology

The application starts the worker that imports `util_cmd.ts` directly. The forwarding-only worker layer is deleted.

The utility worker must own exactly one `WASIFarmAnimal` and one `vfs_root` instance. Reinitialization within the same generation is rejected rather than replacing an existing worker graph. It must publish the Animal's `DestroyerHandle` before starting guest work. If initialization fails after Animal construction, the worker destroys its Animal in a `finally` path; the runtime also terminates the worker and invokes any destroyer it received.

The main thread cannot invoke `DestroyerHandle.destroy()` because the existing shim implementation performs blocking synchronization. The runtime therefore transfers the handle object to a dedicated lifecycle worker. On teardown, the runtime asks that unblocked worker to invoke the shim destroyer and waits for its acknowledgement. This stops the Animal's background and spawned workers without requiring the blocked utility worker to process a message. The application does not implement or directly call an Atomics or shared-memory protocol; it invokes the existing shim lifecycle API from a worker context where its blocking operations are valid.

The shim's background coordinator, not the blocked utility worker, owns the concrete `Worker` references for spawned and start workers. The destroyer calls that coordinator through its existing shared transport; the patched coordinator terminates those owned workers and issues its own `close()` before completing the caller acknowledgement. No `Worker` object is transferred between agents.

After the lifecycle worker acknowledges Animal destruction, JavaScript `Worker.terminate()` is the hard stop for synchronous Wasm execution in the utility worker. After `terminate()` returns, that worker can no longer start a new farm callback. The lifecycle worker is then terminated. Runtime readiness is not published until the lifecycle worker owns the destroyer, so guest work never starts without both cleanup mechanisms available.

Animal destruction has a bounded acknowledgement deadline. If the shim cannot confirm destruction, or disposal begins after Animal construction but before destroyer ownership is acknowledged, the runtime terminates the known utility and lifecycle workers but quarantines, rather than disposes, the farm and archive store. The page-level supervisor retains these resources until unload, blocks all later runtime generations, and presents a reload-required state. Safety takes precedence over reclamation and shared-workspace availability.

Messages queued by the worker before termination are not trusted after disposal begins. Every inbound handler checks the runtime generation token and disposing state before touching coordinator, terminal, test, or readiness state.

The farm is destroyed after the Animal destroyer and utility-worker termination. At that point it is not used to unwind worker execution; it closes the main-thread Park, rejects any remaining base calls, and releases farm-owned resources.

The runtime separately tracks asynchronous host callbacks. Registration occurs synchronously before a callback Promise is returned to the farm. HTTP fetches receive the runtime abort signal. The child-process bridge exposes a disposable owner that terminates its worker and rejects its pending run. Terminal/LSP sends attach rejection handlers. Callback completion handlers are generation-guarded and cannot report through a destroyed farm.

Disposal first aborts callback work and terminates explicit callback producers, then awaits tracked callback settlement with a bounded cleanup deadline before terminating the utility worker. Completion handlers check the generation and farm state before reporting results. A callback that does not settle after its producer was aborted or terminated enters the same quarantine path as an unconfirmed Animal destroy: the callback, farm, and store dependencies are retained and later generations are blocked. Sysroot archive callbacks are synchronous and cannot outlive their call. The archive store is disposed only after host-callback settlement, Animal destruction, utility-worker termination, and farm destruction.

## Teardown Flow

Disposal is idempotent and uses this order:

1. Mark the runtime as disposing, remove data-plane inbound listeners, and reject new Run, target, farm, worker, and terminal-attachment operations. Retain only the lifecycle worker's token-guarded teardown-control listener until destroy acknowledgement or timeout.
2. Abort the generation signal. This initiates coordinator, analyzer, prefetch, host-callback, and UI cancellation but does not wait for a blocked VFS transport.
3. Terminate child-process workers and other explicit asynchronous host producers, then await tracked host callbacks against a bounded cleanup deadline. A timeout marks the runtime for quarantine; completion handlers remain detached and token-guarded.
4. Ask the lifecycle worker to invoke the Animal destroyer and race its acknowledgement against the explicit destroy deadline. Whether it acknowledges or times out, terminate the directly owned utility worker and lifecycle worker. This stops accepted startup or additional-target extraction without sending cancel, status, or release requests to the blocked utility worker. A timeout marks the runtime for quarantine.
5. Await coordinator, rust-analyzer, and Run/target operations. Their runtime wrappers race transport calls against the generation signal, so a dead worker cannot leave disposal waiting on an unresolved `SharedObjectRef` Promise. Losing transport Promises always have rejection handlers and are not used as a safety boundary after their worker has terminated.
6. If callback settlement or Animal destruction was not confirmed, transfer the farm, archive store, callback dependencies, and every channel they may still reach to `RuntimeSupervisor` quarantine. Clear only token-owned UI registrations, mark the generation reload-required, and return from disposal without executing any normal farm, channel, or store cleanup below.
7. Otherwise destroy the `WASIFarm` synchronously.
8. Close runtime-owned `SharedObject` and `SharedObjectRef` channels, including parser and compile/run services.
9. Dispose the `SysrootArchiveStore` and its progress subscriptions.
10. Clear generation-scoped terminal, LSP test, and readiness state only if the generation token still owns each registration. Release the supervisor's generation slot only after verified quiescence.

Cleanup continues after individual failures. Normal unmount resolves after cleanup. Fatal runtime disposal rejects with the initiating fatal error; if cleanup also fails, an `AggregateError` uses the initiating error as `cause` and lists cleanup errors in teardown order. Repeated calls return the same disposal Promise and result. Animal destruction and worker termination are still attempted when coordinator or analyzer disposal fails. If Animal-destruction acknowledgement fails, farm and store cleanup is omitted, the supervisor retains the quarantine, and later generation creation fails with a reload-required result.

No timeout is interpreted as successful sysroot cancellation. A timeout may mark the runtime failed and trigger full runtime disposal, but store disposal remains ordered after worker termination and farm destruction.

## Additional Targets

Additional-target loading remains supported.

- Selection is disabled until startup is ready and while another target is loading.
- The archive is prefetched before the guest command is issued.
- Loads are serialized because the archive callback has one active stream.
- Concurrent programmatic calls for the same triple share one Promise. A different triple is queued behind the active operation. Calls made after disposal starts reject immediately.
- A normal command failure is shown beside the selector without destroying a healthy runtime.
- A worker or transport failure is fatal to the runtime and starts full teardown.

Request-correlated guest status may remain for reporting command success or failure. It is not a cancellation or ownership boundary. Cleanup safety comes from direct Animal and worker ownership. Disposal during accepted extraction immediately takes the hard-stop path before it awaits the target operation.

Archive prefetch remains cooperatively abortable before the guest command starts. Once synchronous guest extraction begins, cancelling that target is a fatal runtime operation because safely interrupting it requires terminating the owning worker. The UI reports this distinction rather than presenting a non-functional per-command cancel action.

Run and target installation share one guest-command admission gate. Target-to-target calls retain the serialization policy above. A Run requested during target installation, a target requested during Run, or a second Run requested during Run rejects immediately with a busy error; no operation queues behind potentially unbounded user code. Disposal rejects queued target operations before they start.

## Generation Isolation

Every generation gets a new `Ctx`; therefore SharedObject identifiers cannot alias an older generation. Event producers also capture a generation token and ignore output after disposal.

All inbound worker, BroadcastChannel, proxy-response, host-callback, worker-error, and worker-messageerror completions perform the same token check. This includes work already queued on the browser event loop when worker termination occurs. Runtime wrappers race pending proxy calls against the generation signal and attach a terminal handler to the original Promise so closing a channel cannot produce an unhandled rejection.

Terminal routing keys include the runtime generation and session ID. Stale cleanup removes a registration only when its token still owns that registration. Terminal-size lookup uses the same generation-qualified routing rather than a global numeric session lookup. A detached view falls back to 80x24.

Runtime output is retained in a UTF-8 byte-bounded buffer per session. Trimming removes complete decoded Unicode code points until the encoded size fits the limit; it never slices an encoded sequence. Attaching or reattaching a view replays the retained buffer, then receives live output. Detaching a view does not close runtime channels or recreate the farm. Runtime disposal clears every session buffer.

Only one terminal view may own a generation/session pair. Attaching a replacement atomically detaches the previous view, snapshots the replay boundary, replays the retained buffer, and then enables live delivery from that boundary so bytes are neither duplicated nor lost.

The test API resets all generation state, including VFS writes, when a generation begins or ends. Late callbacks from an old generation cannot mutate the current test state. Old-generation asynchronous disposal may overlap a reload-required or waiting UI mount, but no new `AppRuntime` generation starts before verified quiescence. Every final cleanup operation is token-conditional.

## Error Handling

- Startup errors retain their originating message in the editor overlay. Code remains visible and editable; Run and target operations stay disabled.
- A non-fatal additional-target error leaves the current ready runtime usable.
- Worker errors, transport loss, or farm destruction are fatal runtime errors.
- Disposal preserves the initiating abort or fatal error as the primary failure. Cleanup failures are aggregated without replacing it.
- Fire-and-forget transport calls always attach rejection handlers.
- A disposed archive store is never used as a mechanism to trap a live worker. It is disposed only after callback producers have been stopped.
- This design introduces no application-owned `Atomics` or `SharedArrayBuffer` coordination protocol. A dedicated lifecycle worker invokes the existing shim's destroyer API, and direct `Worker.terminate()` provides the utility-worker execution boundary.
- Parser and compile/run setup return disposable, generation-scoped services. They do not store `Ctx`, proxies, or readiness in module globals.
- A quarantined generation prevents subsequent runtime creation and shared-workspace mutation until page reload.

## Testing

### Runtime Unit Tests

- The runtime creates one fresh `Ctx`, store, worker, and farm per generation.
- The supervisor creates no overlapping generation and blocks creation after quarantine.
- Duplicate runtime start is rejected, while terminal views may remount without recreating runtime resources.
- Guest startup is blocked until the runtime receives and acknowledges the Animal destroyer handle.
- Disposal is idempotent and follows the required order.
- Worker termination and farm destruction occur even when coordinator cleanup fails.
- Multiple cleanup errors are aggregated.
- New operations are rejected after disposal starts.
- Tracked async host callbacks are aborted and settled before their dependencies are disposed.
- Disposal before Animal construction leaves no owned resource active. Disposal after Animal construction but before destroyer acknowledgement enters quarantine and does not claim complete cleanup.

### Worker Lifecycle Tests

- The application starts `util_cmd.ts` directly; no forwarding worker remains.
- One utility worker owns one `WASIFarmAnimal` and one `vfs_root`.
- Reinitialization cannot overwrite an existing worker reference.
- The Animal destroyer stops background and spawned thread workers even while the utility worker is blocked in synchronous extraction.
- Dependency-level tests prove destroyer transfer/reconstruction and background coordinator closure.
- A missing destroyer acknowledgement quarantines farm/store resources and never falsely reports safe disposal.
- Terminating the utility worker during a pending sysroot read prevents all later archive callbacks.
- Farm destruction occurs after worker termination.
- A worker message queued before termination is rejected by the generation guard after disposal begins.
- Worker startup rejection, `error`, and `messageerror` each trigger one fatal transition and full cleanup.
- The teardown control listener survives data-plane listener removal long enough to receive destroy acknowledgement.

### Generation Tests

- Remounting creates distinct `Ctx`, worker, farm, store, and routing tokens.
- Late terminal, LSP, progress, and test events from an old generation are ignored.
- Old-generation cleanup cannot remove new-generation registrations.
- Pending BroadcastChannel requests and proxy responses cannot update a later generation or block old-generation disposal.
- Output buffered while no terminal view is attached is replayed only to the matching generation and session; terminal size falls back to 80x24.

### UI Tests

- The named plaintext model is attached immediately and remains editable.
- The overlay is editor-local and click-through.
- Run and target selection remain disabled before readiness.
- Startup failure preserves the model and displays the original error.

### Browser Integration Tests

- Startup reaches the approved phase order.
- No `hostRunCargo` or rustc host call occurs before full project configuration.
- The crate graph contains exact `rubrc-main` and `core` nodes.
- Versioned diagnostics and explicit inlay hints complete readiness.
- An additional target can be installed after readiness.
- Disposing during an active startup or additional-target sysroot read invokes the Animal destroyer and terminates the worker before farm and store disposal, without waiting for cooperative status polling.
- Remounting leaves no old worker, channel, farm callback, or generation event active.
- In-flight HTTP and child-process bridge operations are aborted or terminated before store and runtime channel disposal.
- Target installation is serialized; Run/target overlap and duplicate active Run calls reject as busy; queued target operations abort on disposal.
- A destroyer timeout enters reload-required quarantine; no new runtime starts against the shared workspace.

## Out of Scope

- Changing the approved rust-analyzer startup phases.
- Making SharedObject callbacks asynchronous.
- Using cooperative messages to interrupt synchronous Wasm execution.
- Reusing a VFS runtime across application generations.
- Refactoring unrelated shell command execution or workspace filesystem behavior.
