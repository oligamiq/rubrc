"use components";
export function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {
  
  function promiseWithResolvers() {
    if (Promise.withResolvers) {
      return Promise.withResolvers();
    } else {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
  }
  const symbolDispose = Symbol.dispose || Symbol.for('dispose');
  const symbolAsyncIterator = Symbol.asyncIterator;
  const symbolIterator = Symbol.iterator;
  
  const _debugLog = (...args) => {
    if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
    console.debug(...args);
  };
  const ASYNC_DETERMINISM = 'random';
  const GLOBAL_COMPONENT_MEMORY_MAP = new Map();
  const CURRENT_TASK_META = {};
  
  function _getGlobalCurrentTaskMeta(componentIdx) {
    const v = CURRENT_TASK_META[componentIdx];
    if (v === undefined || v === null) { return undefined; }
    return { ...v };
  }
  
  
  function _setGlobalCurrentTaskMeta(args) {
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    return CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
  }
  
  
  function _withGlobalCurrentTaskMeta(args) {
    _debugLog('[_withGlobalCurrentTaskMeta()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    const { taskID, componentIdx, fn } = args;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return fn();
    } catch (err) {
      _debugLog("error while executing sync callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx] = null;
    }
  }
  
  async function _withGlobalCurrentTaskMetaAsync(args) {
    _debugLog('[_withGlobalCurrentTaskMetaAsync()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    
    const { taskID, componentIdx, fn } = args;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return await fn();
    } catch (err) {
      _debugLog("error while executing async callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx] = null;
    }
  }
  
  async function _clearCurrentTask(args) {
    _debugLog('[_clearCurrentTask()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    
    const meta = CURRENT_TASK_META[componentIdx];
    if (!meta) { throw new Error(`missing current task meta for component idx [${componentIdx}]n`); }
    
    if (meta.taskID !== taskID) {
      throw new Error(`task ID [${meta.taskID}] != requested ID [${taskID}]`);
    }
    if (meta.componentIdx !== componentIdx) {
      throw new Error(`component idx [${meta.componentIdx}] != requested idx [${componentIdx}]`);
    }
    
    CURRENT_TASK_META[componentIdx] = null;
  }
  
  function lookupMemoriesForComponent(args) {
    const { componentIdx } = args ?? {};
    if (args.componentIdx === undefined) { throw new TypeError("missing component idx"); }
    
    const metas = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!metas) { return []; }
    
    if (args.memoryIdx === undefined) {
      return Object.values(metas);
    }
    
    const meta = metas[args.memoryIdx];
    return meta?.memory;
  }
  
  function registerGlobalMemoryForComponent(args) {
    const { componentIdx, memory, memoryIdx } = args ?? {};
    if (componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (memory === undefined && memoryIdx === undefined) { throw new TypeError('missing both memory & memory idx'); }
    let inner = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!inner) {
      inner = {};
      GLOBAL_COMPONENT_MEMORY_MAP.set(componentIdx, inner);
    }
    
    inner[memoryIdx] = { memory, memoryIdx, componentIdx };
  }
  
  class RepTable {
    #data = [0, null];
    #target;
    
    constructor(args) {
      this.target = args?.target;
    }
    
    data() { return this.#data; }
    
    insert(val) {
      _debugLog('[RepTable#insert()] args', { val, target: this.target });
      const freeIdx = this.#data[0];
      if (freeIdx === 0) {
        this.#data.push(val);
        this.#data.push(null);
        const rep = (this.#data.length >> 1) - 1;
        _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep });
        return rep;
      }
      this.#data[0] = this.#data[freeIdx << 1];
      const placementIdx = freeIdx << 1;
      this.#data[placementIdx] = val;
      this.#data[placementIdx + 1] = null;
      _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep: freeIdx });
      return freeIdx;
    }
    
    get(rep) {
      _debugLog('[RepTable#get()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during get, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      return val;
    }
    
    contains(rep) {
      _debugLog('[RepTable#contains()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during contains, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      return !!this.#data[baseIdx];
    }
    
    remove(rep) {
      _debugLog('[RepTable#remove()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during remove, (cannot be 0)'); }
      if (this.#data.length === 2) { throw new Error('invalid'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      
      this.#data[baseIdx] = this.#data[0];
      this.#data[0] = rep;
      
      return val;
    }
    
    clear() {
      _debugLog('[RepTable#clear()] args', { rep, target: this.target });
      this.#data = [0, null];
    }
  }
  const _coinFlip = () => { return Math.random() > 0.5; };
  let SCOPE_ID = 0;
  const I32_MIN = -2_147_483_648;
  
  const I32_MAX= 2_147_483_647;
  
  
  function _isValidNumericPrimitive(ty, v) {
    if (v === undefined || v === null) { return false; }
    switch (ty) {
      case 'bool':
      return v === 0 || v === 1;
      break;
      case 'u8':
      return v >= 0 && v <= 255;
      break;
      case 's8':
      return v >= -128 && v <= 127;
      break;
      case 'u16':
      return v >= 0 && v <= 65535;
      break;
      case 's16':
      return v >= -32768 && v <= 32767;
      case 'u32':
      return v >= 0 && v <= 4_294_967_295;
      case 's32':
      return v >= -2_147_483_648 && v <= 2_147_483_647;
      case 'u64':
      return typeof v === 'bigint' && v >= 0 && v <= 18_446_744_073_709_551_615n;
      case 's64':
      return typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n;
      break;
      case 'f32':
      case 'f64': return typeof v === 'number';
      default:
      return false;
    }
    return true;
  }
  
  function _requireValidNumericPrimitive(ty, v) {
    if (v === undefined  || v === null || !_isValidNumericPrimitive(ty, v)) {
      throw new TypeError(`invalid ${ty} value [${v}]`);
    }
    return true;
  }
  
  const _typeCheckValidI32 = (n) => typeof n === 'number' && n >= I32_MIN && n <= I32_MAX;
  
  
  const _typeCheckAsyncFn= (f) => {
    return f instanceof ASYNC_FN_CTOR;
  };
  
  let RESOURCE_CALL_BORROWS = [];const ASYNC_FN_CTOR = (async () => {}).constructor;
  
  function clearCurrentTask(componentIdx, taskID) {
    _debugLog('[clearCurrentTask()] args', { componentIdx, taskID });
    
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while ending current task');
    }
    
    const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (!tasks || !Array.isArray(tasks)) {
      throw new Error('missing/invalid tasks for component instance while ending task');
    }
    if (tasks.length == 0) {
      throw new Error(`no current tasks for component instance [${componentIdx}] while ending task`);
    }
    
    if (taskID !== undefined) {
      const last = tasks[tasks.length - 1];
      if (last.id !== taskID) {
        // throw new Error('current task does not match expected task ID');
        return;
      }
    }
    
    ASYNC_CURRENT_TASK_IDS.pop();
    ASYNC_CURRENT_COMPONENT_IDXS.pop();
    
    const taskMeta = tasks.pop();
    return taskMeta.task;
  }
  
  const CURRENT_TASK_MAY_BLOCK= globalThis.WebAssembly ? new globalThis.WebAssembly.Global({ value: 'i32', mutable: true }, 0) : false;
  
  const ASYNC_CURRENT_TASK_IDS = [];
  const ASYNC_CURRENT_COMPONENT_IDXS = [];
  
  function unpackCallbackResult(result) {
    if (!(_typeCheckValidI32(result))) { throw new Error('invalid callback return value [' + result + '], not a valid i32'); }
    const eventCode = result & 0xF;
    if (eventCode < 0 || eventCode > 3) {
      throw new Error('invalid async return value [' + eventCode + '], outside callback code range');
    }
    if (result < 0 || result >= 2**32) { throw new Error('invalid callback result'); }
    // TODO: table max length check?
    const waitableSetRep = result >> 4;
    return [eventCode, waitableSetRep];
  }
  
  class AsyncSubtask {
    static _ID = 0n;
    
    static State = {
      STARTING: 0,
      STARTED: 1,
      RETURNED: 2,
      CANCELLED_BEFORE_STARTED: 3,
      CANCELLED_BEFORE_RETURNED: 4,
    };
    
    #id;
    #state = AsyncSubtask.State.STARTING;
    #componentIdx;
    
    #parentTask;
    #childTask = null;
    
    #dropped = false;
    #cancelRequested = false;
    
    #memoryIdx = null;
    #lenders = null;
    
    #waitable = null;
    
    #callbackFn = null;
    #callbackFnName = null;
    
    #postReturnFn = null;
    #onProgressFn = null;
    #pendingEventFn = null;
    
    #callMetadata = {};
    
    #resolved = false;
    
    #onResolveHandlers = [];
    #onStartHandlers = [];
    
    #result = null;
    #resultSet = false;
    
    fnName;
    target;
    isAsync;
    isManualAsync;
    
    constructor(args) {
      if (typeof args.componentIdx !== 'number') {
        throw new Error('invalid componentIdx for subtask creation');
      }
      this.#componentIdx = args.componentIdx;
      
      this.#id = ++AsyncSubtask._ID;
      this.fnName = args.fnName;
      
      if (!args.parentTask) { throw new Error('missing parent task during subtask creation'); }
      this.#parentTask = args.parentTask;
      
      if (args.childTask) { this.#childTask = args.childTask; }
      
      if (args.memoryIdx) { this.#memoryIdx = args.memoryIdx; }
      
      if (!args.waitable) { throw new Error("missing/invalid waitable"); }
      this.#waitable = args.waitable;
      
      if (args.callMetadata) { this.#callMetadata = args.callMetadata; }
      
      this.#lenders = [];
      this.target = args.target;
      this.isAsync = args.isAsync;
      this.isManualAsync = args.isManualAsync;
    }
    
    id() { return this.#id; }
    parentTaskID() { return this.#parentTask?.id(); }
    childTaskID() { return this.#childTask?.id(); }
    state() { return this.#state; }
    
    waitable() { return this.#waitable; }
    waitableRep() { return this.#waitable.idx(); }
    
    join() { return this.#waitable.join(...arguments); }
    getPendingEvent() { return this.#waitable.getPendingEvent(...arguments); }
    hasPendingEvent() { return this.#waitable.hasPendingEvent(...arguments); }
    setPendingEvent() { return this.#waitable.setPendingEvent(...arguments); }
    
    setTarget(tgt) { this.target = tgt; }
    
    getResult() {
      if (!this.#resultSet) { throw new Error("subtask result has not been set") }
      return this.#result;
    }
    setResult(v) {
      if (this.#resultSet) { throw new Error("subtask result has already been set"); }
      this.#result = v;
      this.#resultSet = true;
    }
    
    componentIdx() { return this.#componentIdx; }
    
    setChildTask(t) {
      if (!t) { throw new Error('cannot set missing/invalid child task on subtask'); }
      if (this.#childTask) { throw new Error('child task is already set on subtask'); }
      if (this.#parentTask === t) { throw new Error("parent cannot be child"); }
      this.#childTask = t;
    }
    getChildTask(t) { return this.#childTask; }
    
    getParentTask() { return this.#parentTask; }
    
    setCallbackFn(f, name) {
      if (!f) { return; }
      if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
      this.#callbackFn = f;
      this.#callbackFnName = name;
    }
    
    getCallbackFnName() {
      if (!this.#callbackFn) { return undefined; }
      return this.#callbackFn.name;
    }
    
    setPostReturnFn(f) {
      if (!f) { return; }
      if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
      this.#postReturnFn = f;
    }
    
    setOnProgressFn(f) {
      if (this.#onProgressFn) { throw new Error('on progress fn can only be set once'); }
      this.#onProgressFn = f;
    }
    
    isNotStarted() {
      return this.#state == AsyncSubtask.State.STARTING;
    }
    
    registerOnStartHandler(f) {
      this.#onStartHandlers.push(f);
    }
    
    onStart(args) {
      _debugLog('[AsyncSubtask#onStart()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        parentTaskID: this.parentTaskID(),
        fnName: this.fnName,
        args,
      });
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      this.#state = AsyncSubtask.State.STARTED;
      
      let result;
      
      // If we have been provided a helper start function as a result of
      // component fusion performed by wasmtime tooling, then we can call that helper and lifts/lowers will
      // be performed for us.
      //
      // See also documentation on `HostIntrinsic::PrepareCall`
      //
      if (this.#callMetadata.startFn) {
        result = this.#callMetadata.startFn.apply(null, args?.startFnParams ?? []);
      }
      
      return result;
    }
    
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    reject(subtaskErr) {
      this.#childTask?.reject(subtaskErr);
    }
    
    onResolve(subtaskValue) {
      _debugLog('[AsyncSubtask#onResolve()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        isAsync: this.isAsync,
        childTaskID: this.childTaskID(),
        parentTaskID: this.parentTaskID(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        fnName: this.fnName,
      });
      
      if (this.#resolved) {
        throw new Error('subtask has already been resolved');
      }
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      if (subtaskValue === null && this.#cancelRequested) {
        if (this.#state === AsyncSubtask.State.STARTING) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
        } else {
          if (this.#state !== AsyncSubtask.State.STARTED) {
            throw new Error('resolved subtask must have been started before cancellation');
          }
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
        }
      } else {
        if (this.#state !== AsyncSubtask.State.STARTED) {
          throw new Error('resolved subtask must have been started before completion');
        }
        this.#state = AsyncSubtask.State.RETURNED;
      }
      
      this.setResult(subtaskValue);
      
      for (const f of this.#onResolveHandlers) {
        try {
          f(subtaskValue);
        } catch (err) {
          console.error("error during subtask resolve handler", err);
          throw err;
        }
      }
      
      const callMetadata = this.getCallMetadata();
      
      // TODO(fix): we should be able to easily have the caller's meomry
      // to lower into here, but it's not present in PrepareCall
      const memory = callMetadata.memory ?? this.#parentTask?.getReturnMemory() ?? lookupMemoriesForComponent({ componentIdx: this.#parentTask?.componentIdx() })[0];
      if (callMetadata && !callMetadata.returnFn && this.isAsync && callMetadata.resultPtr && memory) {
        const { resultPtr, realloc } = callMetadata;
        const lowers = callMetadata.lowers; // may have been updated in task.return of the child
        if (lowers && lowers.length > 0) {
          lowers[0]({
            componentIdx: this.#componentIdx,
            memory,
            realloc,
            vals: [subtaskValue],
            storagePtr: resultPtr,
            stringEncoding: callMetadata.stringEncoding,
          });
        }
      }
      
      this.#resolved = true;
      this.#parentTask.removeSubtask(this);
    }
    
    getStateNumber() { return this.#state; }
    isReturned() { return this.#state === AsyncSubtask.State.RETURNED; }
    
    getCallMetadata() { return this.#callMetadata; }
    
    isResolved() {
      if (this.#state === AsyncSubtask.State.STARTING
      || this.#state === AsyncSubtask.State.STARTED) {
        return false;
      }
      if (this.#state === AsyncSubtask.State.RETURNED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_STARTED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_RETURNED) {
        return true;
      }
      throw new Error('unrecognized internal Subtask state [' + this.#state + ']');
    }
    
    addLender(handle) {
      _debugLog('[AsyncSubtask#addLender()] args', { handle });
      if (!Number.isNumber(handle)) { throw new Error('missing/invalid lender handle [' + handle + ']'); }
      
      if (this.#lenders.length === 0 || this.isResolved()) {
        throw new Error('subtask has no lendors or has already been resolved');
      }
      
      handle.lends++;
      this.#lenders.push(handle);
    }
    
    deliverResolve() {
      _debugLog('[AsyncSubtask#deliverResolve()] args', {
        lenders: this.#lenders,
        parentTaskID: this.parentTaskID(),
        subtaskID: this.#id,
        childTaskID: this.childTaskID(),
        resolved: this.isResolved(),
        resolveDelivered: this.resolveDelivered(),
      });
      
      const cannotDeliverResolve = this.resolveDelivered() || !this.isResolved();
      if (cannotDeliverResolve) {
        throw new Error('subtask cannot deliver resolution twice, and the subtask must be resolved');
      }
      
      for (const lender of this.#lenders) {
        lender.lends--;
      }
      
      this.#lenders = null;
    }
    
    resolveDelivered() {
      _debugLog('[AsyncSubtask#resolveDelivered()] args', { });
      if (this.#lenders === null && !this.isResolved()) {
        throw new Error('invalid subtask state, lenders missing and subtask has not been resolved');
      }
      return this.#lenders === null;
    }
    
    drop() {
      _debugLog('[AsyncSubtask#drop()] args', {
        componentIdx: this.#componentIdx,
        parentTaskID: this.#parentTask?.id(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        childTaskID: this.#childTask?.id(),
        childTaskFnName: this.#childTask?.entryFnName(),
        subtaskFnName: this.fnName,
      });
      if (!this.#waitable) { throw new Error('missing/invalid inner waitable'); }
      if (!this.resolveDelivered()) {
        throw new Error('cannot drop subtask before resolve is delivered');
      }
      if (this.#waitable) { this.#waitable.drop() }
      this.#dropped = true;
    }
    
    #getComponentState() {
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) {
        throw new Error('invalid/missing async state for component [' + componentIdx + ']');
      }
      return state;
    }
    
    getWaitableHandleIdx() {
      _debugLog('[AsyncSubtask#getWaitableHandleIdx()] args', { });
      if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
      return this.waitableRep();
    }
  }
  
  function _prepareCall(
  memoryIdx,
  getMemoryFn,
  startFn,
  returnFn,
  callerComponentIdx,
  calleeComponentIdx,
  taskReturnTypeIdx,
  calleeIsAsyncInt,
  stringEncoding,
  resultCountOrAsync,
  ) {
    _debugLog('[_prepareCall()]', {
      memoryIdx,
      callerComponentIdx,
      calleeComponentIdx,
      taskReturnTypeIdx,
      calleeIsAsyncInt,
      stringEncoding,
      resultCountOrAsync,
    });
    const argArray = [...arguments];
    
    // value passed in *may* be as large as u32::MAX which may be mangled into -2
    resultCountOrAsync >>>= 0;
    
    let isAsync = false;
    let hasResultPointer = false;
    if (resultCountOrAsync === 2**32 - 1) {
      // prepare async with no result (u32::MAX)
      isAsync = true;
      hasResultPointer = false;
    } else if (resultCountOrAsync === 2**32 - 2) {
      // prepare async with result (u32::MAX - 1)
      isAsync = true;
      hasResultPointer = true;
    }
    
    const currentCallerTaskMeta = getCurrentTask(callerComponentIdx);
    if (!currentCallerTaskMeta) {
      throw new Error('invalid/missing current task for caller during prepare call');
    }
    
    const currentCallerTask = currentCallerTaskMeta.task;
    if (!currentCallerTask) {
      throw new Error('unexpectedly missing task in meta for caller during prepare call');
    }
    
    if (currentCallerTask.componentIdx() !== callerComponentIdx) {
      throw new Error(`task component idx [${ currentCallerTask.componentIdx() }] !== [${ callerComponentIdx }] (callee ${ calleeComponentIdx })`);
    }
    
    let getCalleeParamsFn;
    let resultPtr = null;
    let directParamsArr;
    if (hasResultPointer) {
      directParamsArr = argArray.slice(10, argArray.length - 1);
      getCalleeParamsFn = () => directParamsArr;
      resultPtr = argArray[argArray.length - 1];
    } else {
      directParamsArr = argArray.slice(10);
      getCalleeParamsFn = () => directParamsArr;
    }
    
    let encoding;
    switch (stringEncoding) {
      case 0:
      encoding = 'utf8';
      break;
      case 1:
      encoding = 'utf16';
      break;
      case 2:
      encoding = 'compact-utf16';
      break;
      default:
      throw new Error(`unrecognized string encoding enum [${stringEncoding}]`);
    }
    
    const subtask = currentCallerTask.createSubtask({
      componentIdx: callerComponentIdx,
      parentTask: currentCallerTask,
      isAsync,
      callMetadata: {
        getMemoryFn,
        memoryIdx,
        resultPtr,
        returnFn,
        startFn,
        stringEncoding,
      }
    });
    
    const [newTask, newTaskID] = createNewCurrentTask({
      componentIdx: calleeComponentIdx,
      isAsync,
      getCalleeParamsFn,
      entryFnName: [
      'task',
      subtask.getParentTask().id(),
      'subtask',
      subtask.id(),
      'new-prepared-async-task'
      ].join('/'),
      stringEncoding,
    });
    newTask.setParentSubtask(subtask);
    newTask.setReturnMemoryIdx(memoryIdx);
    newTask.setReturnMemory(getMemoryFn);
    subtask.setChildTask(newTask);
    
    newTask.subtaskMeta = {
      subtask,
      calleeComponentIdx,
      callerComponentIdx,
      getCalleeParamsFn,
      stringEncoding,
      isAsync,
    };
    
    _setGlobalCurrentTaskMeta({
      taskID: newTask.id(),
      componentIdx: newTask.componentIdx(),
    });
  }
  
  function _asyncStartCall(args, callee, paramCount, resultCount, flags) {
    const componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
    
    const globalTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
    if (!globalTaskMeta) { throw new Error('missing global current task globalTaskMeta'); }
    const taskID = globalTaskMeta.taskID;
    
    _debugLog('[_asyncStartCall()] args', { args, componentIdx });
    const { getCallbackFn, callbackIdx, getPostReturnFn, postReturnIdx } = args;
    
    const preparedTaskMeta = getCurrentTask(componentIdx, taskID);
    if (!preparedTaskMeta) { throw new Error('unexpectedly missing current task'); }
    
    const preparedTask = preparedTaskMeta.task;
    if (!preparedTask) { throw new Error('unexpectedly missing current task'); }
    if (!preparedTask.subtaskMeta) { throw new Error('missing subtask meta from prepare'); }
    
    const {
      subtask,
      returnMemoryIdx,
      getReturnMemoryFn,
      callerComponentIdx,
      calleeComponentIdx,
      getCalleeParamsFn,
      isAsync,
      stringEncoding,
    } = preparedTask.subtaskMeta;
    if (!subtask) { throw new Error("missing subtask from cstate during async start call"); }
    if (calleeComponentIdx !== preparedTask.componentIdx()) {
      throw new Error(`meta callee idx [${calleeComponentIdx}] != current task idx [${preparedTask.componentIdx()}] during async start call`);
    }
    if (calleeComponentIdx !== componentIdx) {
      throw new Error("mismatched componentIdx for async start call (does not match prepare)");
    }
    
    const argArray = [...arguments];
    
    if (resultCount < 0 || resultCount > 1) { throw new Error('invalid/unsupported result count'); }
    
    const callbackFnName = 'callback_' + callbackIdx;
    const callbackFn = getCallbackFn();
    preparedTask.setCallbackFn(callbackFn, callbackFnName);
    preparedTask.setPostReturnFn(getPostReturnFn());
    
    if (resultCount < 0 || resultCount > 1) {
      throw new Error(`unsupported result count [${ resultCount }]`);
    }
    
    const params = preparedTask.getCalleeParams();
    if (paramCount !== params.length) {
      throw new Error(`unexpected callee param count [${ params.length }], _asyncStartCall invocation expected [${ paramCount }]`);
    }
    
    const callerComponentState = getOrCreateAsyncState(subtask.componentIdx());
    
    const calleeComponentState = getOrCreateAsyncState(preparedTask.componentIdx());
    const calleeBackpressure = calleeComponentState.hasBackpressure();
    
    // Set up a handler on subtask completion to lower results from the call into the caller's memory region.
    //
    // NOTE: during fused guest->guest calls this handler is triggered, but does not actually perform
    // lowering manually, as fused modules provider helper functions that can
    subtask.registerOnResolveHandler((res) => {
      _debugLog('[_asyncStartCall()] handling subtask result', { res, subtaskID: subtask.id() });
      
      let subtaskCallMeta = subtask.getCallMetadata();
      
      // NOTE: in the case of guest -> guest async calls, there may be no memory/realloc present,
      // as the host will intermediate the value storage/movement between calls.
      //
      // We can simply take the value and lower it as a parameter
      if (subtaskCallMeta.memory || subtaskCallMeta.realloc) {
        throw new Error("call metadata unexpectedly contains memory/realloc for guest->guest call");
      }
      
      const callerTask = subtask.getParentTask();
      const calleeTask = preparedTask;
      const callerMemoryIdx = callerTask.getReturnMemoryIdx();
      const callerComponentIdx = callerTask.componentIdx();
      
      // If a helper function was provided we are likely in a fused guest->guest call,
      // and the result will be delivered (lift/lowered) via helper function
      if (subtaskCallMeta && subtaskCallMeta.returnFn) {
        _debugLog('[_asyncStartCall()] return function present while handling subtask result, returning early (skipping lower)', {
          calleeTaskID: calleeTask.id(),
          calleeComponentIdx,
        });
        
        // TODO: centralize calling of returnFn to *one place* (if possible)
        if (subtaskCallMeta.returnFnCalled) { return; }
        
        const res = subtaskCallMeta.returnFn.apply(null, [subtaskCallMeta.resultPtr]);
        
        _debugLog('[_asyncStartCall()] finished calling return fn', {
          calleeTaskID: calleeTask.id(),
          calleeComponentIdx,
          res,
        });
        
        return;
      }
      
      // If there is no where to lower the results, exit early
      if (!subtaskCallMeta.resultPtr) {
        _debugLog('[_asyncStartCall()] no result ptr during subtask result handling, returning early (skipping lower)');
        return;
      }
      
      let callerMemory;
      if (callerMemoryIdx !== null && callerMemoryIdx !== undefined) {
        callerMemory = lookupMemoriesForComponent({ componentIdx: callerComponentIdx, memoryIdx: callerMemoryIdx });
      } else {
        const callerMemories = lookupMemoriesForComponent({ componentIdx: callerComponentIdx });
        if (callerMemories.length !== 1) { throw new Error(`unsupported amount of caller memories`); }
        callerMemory = callerMemories[0];
      }
      
      if (!callerMemory) {
        _debugLog('[_asyncStartCall()] missing memory', { subtaskID: subtask.id(), res });
        throw new Error(`missing memory for to guest->guest call result (subtask [${subtask.id()}])`);
      }
      
      const lowerFns = calleeTask.getReturnLowerFns();
      if (!lowerFns || lowerFns.length === 0) {
        _debugLog('[_asyncStartCall()] missing result lower metadata for guest->guest call', { subtaskID: subtask.id() });
        throw new Error(`missing result lower metadata for guest->guest call (subtask [${subtask.id()}])`);
      }
      
      if (lowerFns.length !== 1) {
        _debugLog('[_asyncStartCall()] only single result reportetd for guest->guest call', { subtaskID: subtask.id() });
        throw new Error(`only single result supported for guest->guest calls (subtask [${subtask.id()}])`);
      }
      
      _debugLog('[_asyncStartCall()] lowering results', { subtaskID: subtask.id() });
      lowerFns[0]({
        realloc: undefined,
        memory: callerMemory,
        vals: [res],
        storagePtr: subtaskCallMeta.resultPtr,
        componentIdx: callerComponentIdx,
        stringEncoding: subtaskCallMeta.stringEncoding,
      });
      
    });
    
    subtask.setOnProgressFn(() => {
      subtask.setPendingEvent(() => {
        if (subtask.isResolved()) { subtask.deliverResolve(); }
        const event = {
          code: ASYNC_EVENT_CODE.SUBTASK,
          payload0: subtask.waitableRep(),
          payload1: subtask.getStateNumber(),
        };
        return event;
      });
    });
    
    // Start the (event) driver loop that will resolve the subtask
    // in a new JS task
    setTimeout(async () => {
      _debugLog('[_asyncStartCall()] continuing started subtask (in JS task)', {
        taskID: preparedTask.id(),
        subtaskID: subtask.id(),
        callerComponentIdx,
        calleeComponentIdx,
      });
      
      let startRes = subtask.onStart({ startFnParams: params });
      startRes = Array.isArray(startRes) ? startRes : [startRes];
      
      if (calleeComponentState.isExclusivelyLocked()) {
        _debugLog('[_asyncStartCall()] during continuation callee is exclusively locked, suspending...', {
          taskID: preparedTask.id(),
          subtaskID: subtask.id(),
          callerComponentIdx,
          calleeComponentIdx,
        });
        await calleeComponentState.suspendTask({
          task: preparedTask,
          readyFn: () => !calleeComponentState.isExclusivelyLocked(),
        });
      }
      
      const started = await preparedTask.enter();
      if (!started) {
        _debugLog('[_asyncStartCall()] task failed early', {
          taskID: preparedTask.id(),
          subtaskID: subtask.id(),
        });
        throw new Error("task failed to start");
        return;
      }
      
      let callbackResult;
      try {
        let jspiCallee = WebAssembly.promising(callee);
        callbackResult = await _withGlobalCurrentTaskMetaAsync({
          taskID: preparedTask.id(),
          componentIdx: preparedTask.componentIdx(),
          fn: () => {
            return jspiCallee.apply(null, startRes);
          }
        });
      } catch(err) {
        _debugLog("[_asyncStartCall()] initial subtask callee run failed", err);
        // NOTE: a good place to rejectt the parent task, if rejection API is enabled
        // subtask.reject(err);
        // subtask.getParentTask().reject(err);
        
        subtask.getParentTask().setErrored(err);
        
        return;
      }
      
      // If there was no callback function, we're dealing with a sync function
      // that was lifted as async without one, there is only the callee.
      if (!callbackFn) {
        _debugLog("[_asyncStartCall()] no callback, resolving w/ callee result", {
          taskID: preparedTask.id(),
          componentIdx: preparedTask.componentIdx(),
          preparedTask,
          stateNumber: preparedTask.taskState(),
          isResolved: preparedTask.isResolved(),
          callbackFn,
        });
        preparedTask.resolve([callbackResult]);
        return;
      }
      
      let fnName = callbackFn.fnName;
      if (!fnName) {
        fnName = [
        '<task ',
        subtask.parentTaskID(),
        '/subtask ',
        subtask.id(),
        '/task ',
        preparedTask.id(),
        '>',
        ].join("");
      }
      
      try {
        _debugLog("[_asyncStartCall()] starting driver loop", {
          fnName,
          componentIdx: preparedTask.componentIdx(),
          subtaskID: subtask.id(),
          childTaskID: subtask.childTaskID(),
          parentTaskID: subtask.parentTaskID(),
        });
        
        await _driverLoop({
          componentState: calleeComponentState,
          task: preparedTask,
          fnName,
          isAsync: true,
          callbackResult,
          resolve,
          reject
        });
      } catch (err) {
        _debugLog("[AsyncStartCall] drive loop call failure", { err });
      }
      
    }, 0);
    
    const subtaskState = subtask.getStateNumber();
    if (subtaskState < 0 || subtaskState > 2**5) {
      throw new Error('invalid subtask state, out of valid range');
    }
    
    _debugLog('[_asyncStartCall()] returning subtask rep & state', {
      subtask: {
        rep: subtask.waitableRep(),
        state: subtaskState,
      }
    });
    
    return Number(subtask.waitableRep()) << 4 | subtaskState;
  }
  
  function _syncStartCall(callbackIdx) {
    _debugLog('[_syncStartCall()] args', { callbackIdx });
    throw new Error('synchronous start call not implemented!');
  }
  
  class Waitable {
    #componentIdx;
    
    #pendingEventFn = null;
    
    #promise;
    #resolve;
    #reject;
    
    #waitableSet = null;
    
    #hasSyncWaiter = false;
    
    #idx = null; // to component-global waitables
    
    target;
    
    constructor(args) {
      const { componentIdx, target } = args;
      this.#componentIdx = componentIdx;
      this.target = args.target;
      this.#resetPromise();
    }
    
    componentIdx() { return this.#componentIdx; }
    isInSet() { return this.#waitableSet !== null; }
    
    idx() { return this.#idx; }
    setIdx(idx) {
      if (idx === 0) { throw new Error("waitable idx cannot be zero"); }
      this.#idx = idx;
    }
    
    setTarget(tgt) { this.target = tgt; }
    
    #resetPromise() {
      const { promise, resolve, reject } = promiseWithResolvers()
      this.#promise = promise;
      this.#resolve = resolve;
      this.#reject = reject;
    }
    
    resolve() { this.#resolve(); }
    reject(err) { this.#reject(err); }
    promise() { return this.#promise; }
    
    hasPendingEvent() {
      // _debugLog('[Waitable#hasPendingEvent()]', {
        //     componentIdx: this.#componentIdx,
        //     waitable: this,
        //     waitableSet: this.#waitableSet,
        //     hasPendingEvent: this.#pendingEventFn !== null,
        // });
        return this.#pendingEventFn !== null;
      }
      
      setPendingEvent(fn) {
        _debugLog('[Waitable#setPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
        });
        this.#pendingEventFn = fn;
      }
      
      getPendingEvent() {
        _debugLog('[Waitable#getPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
          hasPendingEvent: this.#pendingEventFn !== null,
        });
        if (this.#pendingEventFn === null) { return null; }
        const eventFn = this.#pendingEventFn;
        this.#pendingEventFn = null;
        const e = eventFn();
        this.#resetPromise();
        return e;
      }
      
      join(waitableSet) {
        _debugLog('[Waitable#join()] args', {
          waitable: this,
          waitableSet: waitableSet,
          isRemoval: waitableSet === null,
        });
        
        if (this.#waitableSet === undefined) {
          throw new TypeError('waitable set must be not be undefined');
        }
        
        if (this.#waitableSet) {
          this.#waitableSet.removeWaitable(this);
        }
        
        this.#waitableSet = waitableSet;
        
        if (waitableSet) {
          this.#waitableSet.addWaitable(this);
        }
      }
      
      drop() {
        _debugLog('[Waitable#drop()] args', {
          componentIdx: this.#componentIdx,
          waitable: this,
        });
        if (this.hasPendingEvent()) {
          throw new Error('waitables with pending events cannot be dropped');
        }
        this.join(null);
      }
      
      async waitForPendingEvent(args) {
        const { cstate } = args;
        if (!cstate) { throw new TypeError('missing component state'); }
        
        if (this.#waitableSet !== null || this.#hasSyncWaiter) {
          throw new Error("waitable is already in a set/has a sync waiter");
        }
        this.#hasSyncWaiter = true;
        await cstate.waitUntil({
          cancellable: false,
          readyFn: () => this.hasPendingEvent(),
        });
        this.#hasSyncWaiter = false;
      }
      
    }
    
    const ERR_CTX_TABLES = {};
    
    function toInt32(val) {
      
      return val >> 0;
    }
    
    
    function toUint32(val) {
      
      return val >>> 0;
    }
    
    
    function getCurrentTask(componentIdx, taskID) {
      let usedGlobal = false;
      if (componentIdx === undefined || componentIdx === null) {
        throw new Error('missing component idx'); // TODO(fix)
        // componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
        // usedGlobal = true;
      }
      
      const taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
      if (taskMetas === undefined || taskMetas.length === 0) { return undefined; }
      
      if (taskID) {
        return taskMetas.find(meta => meta.task.id() === taskID);
      }
      
      const taskMeta = taskMetas[taskMetas.length - 1];
      if (!taskMeta || !taskMeta.task) { return undefined; }
      
      return taskMeta;
    }
    
    function createNewCurrentTask(args) {
      _debugLog('[createNewCurrentTask()] args', args);
      const {
        componentIdx,
        isAsync,
        isManualAsync,
        entryFnName,
        parentSubtaskID,
        callbackFnName,
        getCallbackFn,
        getParamsFn,
        stringEncoding,
        errHandling,
        getCalleeParamsFn,
        resultPtr,
        callingWasmExport,
      } = args;
      if (componentIdx === undefined || componentIdx === null) {
        throw new Error('missing/invalid component instance index while starting task');
      }
      let taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
      const callbackFn = getCallbackFn ? getCallbackFn() : null;
      
      const newTask = new AsyncTask({
        componentIdx,
        isAsync,
        isManualAsync,
        entryFnName,
        callbackFn,
        callbackFnName,
        stringEncoding,
        getCalleeParamsFn,
        resultPtr,
        errHandling,
      });
      
      const newTaskID = newTask.id();
      const newTaskMeta = { id: newTaskID, componentIdx, task: newTask };
      
      // NOTE: do not track host tasks
      ASYNC_CURRENT_TASK_IDS.push(newTaskID);
      ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);
      
      if (!taskMetas) {
        taskMetas = [newTaskMeta];
        ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
      } else {
        taskMetas.push(newTaskMeta);
      }
      
      return [newTask, newTaskID];
    }
    const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
    
    class AsyncTask {
      static _ID = 0n;
      
      static State = {
        INITIAL: 'initial',
        CANCELLED: 'cancelled',
        CANCEL_PENDING: 'cancel-pending',
        CANCEL_DELIVERED: 'cancel-delivered',
        RESOLVED: 'resolved',
      }
      
      static BlockResult = {
        CANCELLED: 'block.cancelled',
        NOT_CANCELLED: 'block.not-cancelled',
      }
      
      #id;
      #componentIdx;
      #state;
      #isAsync;
      #isManualAsync;
      #entryFnName = null;
      
      #onResolveHandlers = [];
      #completionPromise = null;
      #rejected = false;
      
      #exitPromise = null;
      #onExitHandlers = [];
      
      #memoryIdx = null;
      #memory = null;
      
      #callbackFn = null;
      #callbackFnName = null;
      
      #postReturnFn = null;
      
      #getCalleeParamsFn = null;
      
      #stringEncoding = null;
      
      #parentSubtask = null;
      
      #errHandling;
      
      #backpressurePromise;
      #backpressureWaiters = 0n;
      
      #returnLowerFns = null;
      
      #subtasks = [];
      
      #entered = false;
      #exited = false;
      #errored = null;
      
      cancelled = false;
      cancelRequested = false;
      alwaysTaskReturn = false;
      
      returnCalls =  0;
      storage = [0, 0];
      borrowedHandles = {};
      
      tmpRetI64HighBits = 0|0;
      
      constructor(opts) {
        this.#id = ++AsyncTask._ID;
        
        if (opts?.componentIdx === undefined) {
          throw new TypeError('missing component id during task creation');
        }
        this.#componentIdx = opts.componentIdx;
        
        this.#state = AsyncTask.State.INITIAL;
        this.#isAsync = opts?.isAsync ?? false;
        this.#isManualAsync = opts?.isManualAsync ?? false;
        this.#entryFnName = opts.entryFnName;
        
        const {
          promise: completionPromise,
          resolve: resolveCompletionPromise,
          reject: rejectCompletionPromise,
        } = promiseWithResolvers();
        this.#completionPromise = completionPromise;
        
        this.#onResolveHandlers.push((results) => {
          if (this.#errored !== null) {
            rejectCompletionPromise(this.#errored);
            return;
          } else if (this.#rejected) {
            rejectCompletionPromise(results);
            return;
          }
          resolveCompletionPromise(results);
        });
        
        const {
          promise: exitPromise,
          resolve: resolveExitPromise,
          reject: rejectExitPromise,
        } = promiseWithResolvers();
        this.#exitPromise = exitPromise;
        
        this.#onExitHandlers.push(() => {
          resolveExitPromise();
        });
        
        if (opts.callbackFn) { this.#callbackFn = opts.callbackFn; }
        if (opts.callbackFnName) { this.#callbackFnName = opts.callbackFnName; }
        
        if (opts.getCalleeParamsFn) { this.#getCalleeParamsFn = opts.getCalleeParamsFn; }
        
        if (opts.stringEncoding) { this.#stringEncoding = opts.stringEncoding; }
        
        if (opts.parentSubtask) { this.#parentSubtask = opts.parentSubtask; }
        
        
        if (opts.errHandling) { this.#errHandling = opts.errHandling; }
      }
      
      taskState() { return this.#state; }
      id() { return this.#id; }
      componentIdx() { return this.#componentIdx; }
      entryFnName() { return this.#entryFnName; }
      
      completionPromise() { return this.#completionPromise; }
      exitPromise() { return this.#exitPromise; }
      
      isAsync() { return this.#isAsync; }
      isSync() { return !this.isAsync(); }
      
      getErrHandling() { return this.#errHandling; }
      
      hasCallback() { return this.#callbackFn !== null; }
      
      getReturnMemoryIdx() { return this.#memoryIdx; }
      setReturnMemoryIdx(idx) {
        if (idx === null) { return; }
        this.#memoryIdx = idx;
      }
      
      getReturnMemory() { return this.#memory; }
      setReturnMemory(m) {
        if (m === null) { return; }
        this.#memory = m;
      }
      
      setReturnLowerFns(fns) { this.#returnLowerFns = fns; }
      getReturnLowerFns() { return this.#returnLowerFns; }
      
      setParentSubtask(subtask) {
        if (!subtask || !(subtask instanceof AsyncSubtask)) { return }
        if (this.#parentSubtask) { throw new Error('parent subtask can only be set once'); }
        this.#parentSubtask = subtask;
      }
      
      getParentSubtask() { return this.#parentSubtask; }
      
      // TODO(threads): this is very inefficient, we can pass along a root task,
      // and ideally do not need this once thread support is in place
      getRootTask() {
        let currentSubtask = this.getParentSubtask();
        let task = this;
        while (currentSubtask) {
          task = currentSubtask.getParentTask();
          currentSubtask = task.getParentSubtask();
        }
        return task;
      }
      
      setPostReturnFn(f) {
        if (!f) { return; }
        if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
        this.#postReturnFn = f;
      }
      
      setCallbackFn(f, name) {
        if (!f) { return; }
        if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
        this.#callbackFn = f;
        this.#callbackFnName = name;
      }
      
      getCallbackFnName() {
        if (!this.#callbackFnName) { return undefined; }
        return this.#callbackFnName;
      }
      
      async runCallbackFn(...args) {
        if (!this.#callbackFn) { throw new Error('no callback function has been set for task'); }
        return _withGlobalCurrentTaskMetaAsync({
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          fn: () => { return this.#callbackFn.apply(null, args); }
        });
      }
      
      getCalleeParams() {
        if (!this.#getCalleeParamsFn) { throw new Error('missing/invalid getCalleeParamsFn'); }
        return this.#getCalleeParamsFn();
      }
      
      mayBlock() { return this.isAsync() || this.isResolvedState() }
      
      mayEnter(task) {
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        if (cstate.hasBackpressure()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
          return false;
        }
        if (!cstate.callingSyncImport()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
          return false;
        }
        const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
        if (!callingSyncExportWithSyncPending) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
          return false;
        }
        return true;
      }
      
      enterSync() {
        if (this.needsExclusiveLock()) {
          const cstate = getOrCreateAsyncState(this.#componentIdx);
          // TODO(???): it is *very possible* for a the line below to fail if
          // an async function is already running (and holding the exclusive lock)
          //
          // It's not really possible to fix this unless we turn every sync export into
          // an async export that will use the regular async enabled `enter()`.
          cstate.exclusiveLock();
        }
        return true;
      }
      
      async enter(opts) {
        _debugLog('[AsyncTask#enter()] args', {
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          subtaskID: this.getParentSubtask()?.id(),
          args: opts,
          entryFnName: this.#entryFnName,
        });
        
        if (this.#entered) {
          throw new Error(`task with ID [${this.#id}] should not be entered twice`);
        }
        
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        
        await cstate.nextTaskExecutionSlot({ task: this });
        
        // If a task is either synchronous or host-provided (e.g. a host import, whether sync or async)
        // then we can avoid component-relevant tracking and immediately enter
        if (this.isSync() || opts?.isHost) {
          this.#entered = true;
          
          // TODO(breaking): remove once manually-specifying async fns is removed
          // It is currently possible for an actually sync export to be specified
          // as async via JSPI
          if (this.#isManualAsync) {
            if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
          }
          
          return this.#entered;
        }
        
        // Perform intial backpressure check
        if (cstate.hasBackpressure() || this.needsExclusiveLock() && cstate.isExclusivelyLocked()) {
          cstate.addBackpressureWaiter();
          
          const result = await this.waitUntil({
            readyFn: () => {
              return !(cstate.hasBackpressure()
              || this.needsExclusiveLock() && cstate.isExclusivelyLocked());
            },
            cancellable: true,
          });
          
          cstate.removeBackpressureWaiter();
          
          if (result === AsyncTask.BlockResult.CANCELLED) {
            this.cancel();
            return false;
          }
        }
        
        // Lock the component state or keep trying until we can/do
        try {
          if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
        } catch {
          // Continuously attempt to lock until we can
          while (cstate.hasBackpressure() || this.needsExclusiveLock() && cstate.isExclusivelyLocked()) {
            try {
              if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
              break;
            } catch(err) {
              cstate.addBackpressureWaiter();
              const result = await this.waitUntil({
                readyFn: () => {
                  return !(cstate.hasBackpressure()
                  || this.needsExclusiveLock() && cstate.isExclusivelyLocked());
                },
                cancellable: true,
              });
              cstate.removeBackpressureWaiter();
              if (result === AsyncTask.BlockResult.CANCELLED) {
                this.cancel();
                return false;
              }
            }
          }
        }
        
        this.#entered = true;
        return this.#entered;
      }
      
      isRunningState() { return this.#state !== AsyncTask.State.RESOLVED; }
      isResolvedState() { return this.#state === AsyncTask.State.RESOLVED; }
      isResolved() { return this.#state === AsyncTask.State.RESOLVED; }
      
      async waitUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#waitUntil()] args', { taskID: this.#id, args: { cancellable } });
        
        // TODO(fix): check for cancel
        // TODO(fix): determinism
        // TODO(threads): add this thread to waiting list
        
        const keepGoing = await this.suspendUntil({
          readyFn,
          cancellable,
        });
        
        return keepGoing;
      }
      
      async yieldUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#yieldUntil()]', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const keepGoing = await this.suspendUntil({ readyFn, cancellable });
        if (keepGoing) {
          return {
            code: ASYNC_EVENT_CODE.NONE,
            payload0: 0,
            payload1: 0,
          };
        }
        
        return {
          code: ASYNC_EVENT_CODE.TASK_CANCELLED,
          payload0: 0,
          payload1: 0,
        };
      }
      
      async suspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#suspendUntil()] args', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const pendingCancelled = this.deliverPendingCancel({ cancellable });
        if (pendingCancelled) { return false; }
        
        const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
        return completed;
      }
      
      // TODO(threads): equivalent to thread.suspend_until()
      async immediateSuspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#immediateSuspendUntil()] args', {
          args: {
            cancellable,
            readyFn,
          },
          taskID: this.#id,
          componentIdx: this.#componentIdx,
        });
        
        const ready = readyFn();
        if (ready && ASYNC_DETERMINISM === 'random') {
          const coinFlip = _coinFlip();
          if (coinFlip) { return true }
        }
        
        const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
        return keepGoing;
      }
      
      async immediateSuspend(opts) { // NOTE: equivalent to thread.suspend()
      // TODO(threads): store readyFn on the thread
      const { cancellable, readyFn } = opts;
      _debugLog('[AsyncTask#immediateSuspend()] args', { cancellable, readyFn });
      
      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) { return false; }
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      const keepGoing = await cstate.suspendTask({ task: this, readyFn });
      return keepGoing;
    }
    
    deliverPendingCancel(opts) {
      const { cancellable } = opts;
      _debugLog('[AsyncTask#deliverPendingCancel()]', {
        args: { cancellable },
        taskID: this.#id,
        componentIdx: this.#componentIdx,
      });
      
      if (cancellable && this.#state === AsyncTask.State.PENDING_CANCEL) {
        this.#state = AsyncTask.State.CANCEL_DELIVERED;
        return true;
      }
      
      return false;
    }
    
    isCancelled() { return this.cancelled }
    
    cancel(args) {
      _debugLog('[AsyncTask#cancel()] args', { });
      if (this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] invalid task state [${this.taskState()}] for cancellation`);
      }
      if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
      this.cancelled = true;
      this.onResolve(args?.error ?? new Error('task cancelled'));
      this.#state = AsyncTask.State.RESOLVED;
    }
    
    onResolve(taskValue) {
      const handlers = this.#onResolveHandlers;
      this.#onResolveHandlers = [];
      for (const f of handlers) {
        try {
          f(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      if (this.#parentSubtask) {
        const meta = this.#parentSubtask.getCallMetadata();
        // Run the rturn fn if it has not already been called -- this *should* have happened in
        // `task.return`, but some paths do not go through task.return (e.g. async lower of sync fn
        // which goes through prepare + async-start-call)
        if (meta.returnFn && !meta.returnFnCalled) {
          _debugLog('[AsyncTask#onResolve()] running returnFn', {
            componentIdx: this.#componentIdx,
            taskID: this.#id,
            subtaskID: this.#parentSubtask.id(),
          });
          const memory = meta.getMemoryFn();
          meta.returnFn.apply(null, [taskValue, meta.resultPtr]);
          meta.returnFnCalled = true;
        }
      }
      
      if (this.#postReturnFn) {
        _debugLog('[AsyncTask#onResolve()] running post return ', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
        });
        try {
          this.#postReturnFn(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      if (this.#parentSubtask) {
        this.#parentSubtask.onResolve(taskValue);
      }
    }
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    isRejected() { return this.#rejected; }
    
    setErrored(err) {
      this.#errored = err;
    }
    
    reject(taskErr) {
      _debugLog('[AsyncTask#reject()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        parentSubtask: this.#parentSubtask,
        parentSubtaskID: this.#parentSubtask?.id(),
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
        errMsg: taskErr.message,
      });
      
      if (this.isResolvedState() || this.#rejected) { return; }
      
      for (const subtask of this.#subtasks) {
        subtask.reject(taskErr);
      }
      
      this.#rejected = true;
      this.cancelRequested = true;
      this.#state = AsyncTask.State.PENDING_CANCEL;
      const cancelled = this.deliverPendingCancel({ cancellable: true });
      
      // TODO: do cleanup here to reset the machinery so we can run again?
      
      this.cancel({ error: taskErr });
    }
    
    resolve(results) {
      _debugLog('[AsyncTask#resolve()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
      });
      
      if (this.#state === AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
      }
      
      if (this.borrowedHandles.length > 0) {
        throw new Error('task still has borrow handles');
      }
      
      this.#state = AsyncTask.State.RESOLVED;
      
      switch (results.length) {
        case 0:
        this.onResolve(undefined);
        break;
        case 1:
        this.onResolve(results[0]);
        break;
        default:
        _debugLog('[AsyncTask#resolve()] unexpected number of results', {
          componentIdx: this.#componentIdx,
          results,
          taskID: this.#id,
          subtaskID: this.#parentSubtask?.id(),
          entryFnName: this.#entryFnName,
          callbackFnName: this.#callbackFnName,
        });
        throw new Error('unexpected number of results');
      }
    }
    
    exit(args) {
      _debugLog('[AsyncTask#exit()]', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
      });
      
      if (this.#exited)  { throw new Error("task has already exited"); }
      
      if (this.#state !== AsyncTask.State.RESOLVED) {
        // TODO(fix): only fused, manually specified post returns seem to break this invariant,
        // as the TaskReturn trampoline is not activated it seems.
        //
        // see: test/p3/ported/wasmtime/component-async/post-return.js
        //
        // We *should* be able to upgrade this to be more strict and throw at some point,
        // which may involve rewriting the upstream test to surface task return manually somehow.
        //
        //throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
        _debugLog('[AsyncTask#exit()] task exited without resolution', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
          subtask: this.getParentSubtask(),
          subtaskID: this.getParentSubtask()?.id(),
        });
        this.#state = AsyncTask.State.RESOLVED;
      }
      
      if (this.borrowedHandles > 0) {
        throw new Error('task [${this.#id}] exited without clearing borrowed handles');
      }
      
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
      
      // Exempt the host from exclusive lock check
      if (this.#componentIdx !== -1 && !args?.skipExclusiveLockCheck) {
        if (this.needsExclusiveLock() && !state.isExclusivelyLocked()) {
          throw new Error(`task [${this.#id}] exit: component [${this.#componentIdx}] should have been exclusively locked`);
        }
      }
      
      state.exclusiveRelease();
      
      for (const f of this.#onExitHandlers) {
        try {
          f();
        } catch (err) {
          console.error("error during task exit handler", err);
          throw err;
        }
      }
      
      this.#exited = true;
      clearCurrentTask(this.#componentIdx, this.id());
    }
    
    needsExclusiveLock() {
      return !this.#isAsync || this.hasCallback();
    }
    
    createSubtask(args) {
      _debugLog('[AsyncTask#createSubtask()] args', args);
      const { componentIdx, childTask, callMetadata, fnName, isAsync, isManualAsync } = args;
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (!cstate) {
        throw new Error(`invalid/missing async state for component idx [${componentIdx}]`);
      }
      
      const waitable = new Waitable({
        componentIdx: this.#componentIdx,
        target: `subtask (internal ID [${this.#id}])`,
      });
      
      const newSubtask = new AsyncSubtask({
        componentIdx,
        childTask,
        parentTask: this,
        callMetadata,
        isAsync,
        isManualAsync,
        fnName,
        waitable,
      });
      this.#subtasks.push(newSubtask);
      newSubtask.setTarget(`subtask (internal ID [${newSubtask.id()}], waitable [${waitable.idx()}], component [${componentIdx}])`);
      waitable.setIdx(cstate.handles.insert(newSubtask));
      waitable.setTarget(`waitable for subtask (waitable id [${waitable.idx()}], subtask internal ID [${newSubtask.id()}])`);
      
      return newSubtask;
    }
    
    getLatestSubtask() {
      return this.#subtasks.at(-1);
    }
    
    getSubtaskByWaitableRep(rep) {
      if (rep === undefined) { throw new TypeError('missing rep'); }
      return this.#subtasks.find(s => s.waitableRep() === rep);
    }
    
    currentSubtask() {
      _debugLog('[AsyncTask#currentSubtask()]');
      if (this.#subtasks.length === 0) { return undefined; }
      return this.#subtasks.at(-1);
    }
    
    removeSubtask(subtask) {
      if (this.#subtasks.length === 0) { throw new Error('cannot end current subtask: no current subtask'); }
      this.#subtasks = this.#subtasks.filter(t => t !== subtask);
      return subtask;
    }
  }
  
  function _lowerImportBackwardsCompat(args) {
    const params = [...arguments].slice(1);
    _debugLog('[_lowerImportBackwardsCompat()] args', { args, params });
    const {
      functionIdx,
      componentIdx,
      isAsync,
      isManualAsync,
      paramLiftFns,
      resultLowerFns,
      hasResultPointer,
      funcTypeIsAsync,
      metadata,
      memoryIdx,
      getMemoryFn,
      getReallocFn,
      importFn,
      stringEncoding,
    } = args;
    
    let meta = _getGlobalCurrentTaskMeta(componentIdx);
    let createdTask;
    
    // Some components depend on initialization logic (i.e. `_initialize` or some such
    // core wasm export) that is embedded in the component, but is not executed or wizer'd
    // away before the transpiled component is attempted to be used.
    //
    // These components execut their initialization logic *when they are imported* in the
    // transpiled context -- so we may get a call to an export that is lowered without going
    // through `CallWasm` or `CallInterface`.
    //
    if (!meta) {
      if (funcTypeIsAsync || (isAsync && !isManualAsync)) {
        throw new Error('p3 async wasm exports cannot use backwards compat auto-task init');
      }
      
      const [newTask, newTaskID] = createNewCurrentTask({
        componentIdx,
        isAsync,
        isManualAsync,
        callingWasmExport: false,
      });
      createdTask = newTask;
      
      // Since we're managing the task creation ourselves we must clear ourselves
      createdTask.registerOnResolveHandler(() => {
        _clearCurrentTask({
          taskID: task.id(),
          componentIdx: task.componentIdx(),
        });
      });
      
      _setGlobalCurrentTaskMeta({
        componentIdx,
        taskID: newTaskID,
      });
      
      meta = _getGlobalCurrentTaskMeta(componentIdx);
    }
    
    const { taskID } = meta;
    
    const taskMeta = getCurrentTask(componentIdx, taskID);
    if (!taskMeta) {
      throw new Error('invalid/missing async task meta');
    }
    
    const task = taskMeta.task;
    if (!task) { throw new Error('invalid/missing async task'); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    // TODO: re-enable this check -- postReturn can call imports though,
    // and that breaks things.
    //
    // if (!cstate.mayLeave) {
      //     throw new Error(`cannot leave instance [${componentIdx}]`);
      // }
      
      if (!task.mayBlock() && funcTypeIsAsync && !isAsync) {
        throw new Error("non async exports cannot synchronously call async functions");
      }
      
      // If there is an existing task, this should be part of a subtask
      const memory = getMemoryFn();
      // Canonical ABI lower appends result storage as a trailing
      // param when async lower has any flat result, or sync lower
      // has more than one flat result.
      const resultPtr = hasResultPointer ? params[params.length - 1] : undefined;
      const subtask = task.createSubtask({
        componentIdx,
        parentTask: task,
        fnName: importFn.fnName,
        isAsync,
        isManualAsync,
        callMetadata: {
          memoryIdx,
          memory,
          realloc: getReallocFn?.(),
          getReallocFn,
          resultPtr,
          lowers: resultLowerFns,
          stringEncoding,
        }
      });
      task.setReturnMemoryIdx(memoryIdx);
      task.setReturnMemory(getMemoryFn());
      
      subtask.onStart();
      
      // If dealing with a sync lowered sync function, we can directly return results
      //
      // TODO(breaking): remove once we get rid of manual async import specification,
      // as func types cannot be detected in that case only (and we don't need that w/ p3)
      if (!isManualAsync && !isAsync && !funcTypeIsAsync) {
        if (createdTask) { createdTask.enterSync(); }
        
        const res = importFn(...params);
        
        // TODO(breaking): remove once we get rid of manual async import specification,
        // as func types cannot be detected in that case only (and we don't need that w/ p3)
        if (!funcTypeIsAsync && !subtask.isReturned()) {
          throw new Error('post-execution subtasks must either be async or returned');
        }
        
        const syncRes = subtask.getResult();
        if (createdTask) { createdTask.resolve([syncRes]); }
        
        return syncRes;
      }
      
      // Sync-lowered async functions requires async behavior because the callee *can* block,
      // but this call must *act* synchronously and return immediately with the result
      // (i.e. not returning until the work is done)
      //
      // TODO(breaking): remove checking for manual async specification here, once we can go p3-only
      //
      if (!isManualAsync && !isAsync && funcTypeIsAsync) {
        const { promise, resolve } = new Promise();
        queueMicrotask(async () => {
          if (!subtask.isResolvedState()) {
            await task.suspendUntil({ readyFn: () => task.isResolvedState() });
          }
          resolve(subtask.getResult());
        });
        return promise;
      }
      
      // NOTE: at this point we know that we are working with an async lowered import
      
      const subtaskState = subtask.getStateNumber();
      if (subtaskState < 0 || subtaskState >= 2**4) {
        throw new Error('invalid subtask state, out of valid range');
      }
      
      subtask.setOnProgressFn(() => {
        subtask.setPendingEvent(() => {
          if (subtask.isResolved()) { subtask.deliverResolve(); }
          const event = {
            code: ASYNC_EVENT_CODE.SUBTASK,
            payload0: subtask.waitableRep(),
            payload1: subtask.getStateNumber(),
          }
          return event;
        });
      });
      
      // This is a hack to maintain backwards compatibility with
      // manually-specified async imports, used in wasm exports that are
      // not actually async (but are specified as so).
      //
      // This is not normal p3 sync behavior but instead anticipating that
      // the caller that is doing manual async will be waiting for a promise that
      // resolves to the *actual* result.
      //
      // TODO(breaking): remove once manually specified async is removed
      //
      // There are a few cases:
      // 1. sync function with async types (e.g. `f: func() -> stream<u32>`)
      // 2. async function with async types (e.g. `f: async func() -> stream<u32>`)
      // 3. async function with sync types (e.g. `f: async func() -> list<u32>`)
      // 4. sync function with non-async types (e.g. `f: func() -> list<u32>`)
      //
      // This hack *only* applies to 4 -- the case where an async JS host function
      // is supplied to a Wasm export which does *not* need to do any async abi
      // lifting/lowering (async ABI did not exist when JSPI integratiton was
      // initially merged to enable asynchronously returning values from the host)
      //
      const requiresManualAsyncResult = !isAsync && !funcTypeIsAsync && isManualAsync;
      let manualAsyncResult;
      if (requiresManualAsyncResult) {
        manualAsyncResult = promiseWithResolvers();
      }
      
      queueMicrotask(async () => {
        try {
          _debugLog('[_lowerImportBackwardsCompat()] calling lowered import', { importFn, params });
          if (createdTask) { await createdTask.enter(); }
          
          const asyncRes = await importFn(...params);
          if (requiresManualAsyncResult) {
            manualAsyncResult.resolve(subtask.getResult());
          }
          
          if (createdTask) { createdTask.resolve([asyncRes]); }
          
          
        } catch (err) {
          _debugLog("[_lowerImportBackwardsCompat()] import fn error:", err);
          if (requiresManualAsyncResult) {
            manualAsyncResult.reject(err);
          }
          throw err;
        }
      });
      
      if (requiresManualAsyncResult) { return manualAsyncResult.promise; }
      
      return Number(subtask.waitableRep()) << 4 | subtaskState;
    }
    
    function _liftFlatS32(ctx) {
      _debugLog('[_liftFlatS32()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (s32 requires 4 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getInt32(ctx.storagePtr, true);
      ctx.storagePtr += 4;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatU32(ctx) {
      _debugLog('[_liftFlatU32()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i34 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u32 requires 4 bytes)`);
      }
      val = new DataView(ctx.memory.buffer).getUint32(ctx.storagePtr, true);
      ctx.storagePtr += 4;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatS64(ctx) {
      _debugLog('[_liftFlatS64()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least one single i64 argument'); }
        if (typeof ctx.params[0] !== 'bigint') { throw new Error('expected bigint'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 8) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (s64 requires 8 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getBigInt64(ctx.storagePtr, true);
      ctx.storagePtr += 8;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 8; }
      
      return [val, ctx];
    }
    
    
    function _lowerFlatS32(ctx) {
      _debugLog('[_lowerFlatS32()] args', { ctx });
      
      if (ctx.vals.length !== 1) {
        throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
      }
      
      const rem = ctx.storagePtr % 4;
      if (rem !== 0) { ctx.storagePtr += (4 - rem); }
      
      _requireValidNumericPrimitive.bind('s32', ctx.vals[0]);
      new DataView(ctx.memory.buffer).setInt32(ctx.storagePtr, ctx.vals[0], true);
      
      ctx.storagePtr += 4;
    }
    
    const STREAMS = new RepTable({ target: 'global stream map' });
    const ASYNC_STATE = new Map();
    
    function getOrCreateAsyncState(componentIdx, init) {
      if (!ASYNC_STATE.has(componentIdx)) {
        const newState = new ComponentAsyncState({ componentIdx });
        ASYNC_STATE.set(componentIdx, newState);
      }
      return ASYNC_STATE.get(componentIdx);
    }
    
    class ComponentAsyncState {
      static EVENT_HANDLER_EVENTS = [ 'backpressure-change' ];
      
      #componentIdx;
      #callingAsyncImport = false;
      #syncImportWait = promiseWithResolvers();
      #locked = false;
      #parkedTasks = new Map();
      #suspendedTasksByTaskID = new Map();
      #suspendedTaskIDs = [];
      #errored = null;
      
      #backpressure = 0;
      #backpressureWaiters = 0n;
      
      #handlerMap = new Map();
      #nextHandlerID = 0n;
      
      #tickLoop = null;
      #tickLoopInterval = null;
      
      #onExclusiveReleaseHandlers = [];
      
      mayLeave = true;
      
      handles;
      subtasks;
      
      constructor(args) {
        this.#componentIdx = args.componentIdx;
        this.handles = new RepTable({ target: `component [${this.#componentIdx}] handles (waitable objects)` });
        this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
      };
      
      componentIdx() { return this.#componentIdx; }
      
      errored() { return this.#errored !== null; }
      setErrored(err) {
        _debugLog('[ComponentAsyncState#setErrored()] component errored', { err, componentIdx: this.#componentIdx });
        if (this.#errored) { return; }
        if (!err) {
          err = new Error('error elswehere (see other component instance error)')
          err.componentIdx = this.#componentIdx;
        }
        this.#errored = err;
      }
      
      callingSyncImport(val) {
        if (val === undefined) { return this.#callingAsyncImport; }
        if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
        const prev = this.#callingAsyncImport;
        this.#callingAsyncImport = val;
        if (prev === true && this.#callingAsyncImport === false) {
          this.#notifySyncImportEnd();
        }
      }
      
      #notifySyncImportEnd() {
        const existing = this.#syncImportWait;
        this.#syncImportWait = promiseWithResolvers();
        existing.resolve();
      }
      
      async waitForSyncImportCallEnd() {
        await this.#syncImportWait.promise;
      }
      
      setBackpressure(v) {
        this.#backpressure = v;
        return this.#backpressure
      }
      getBackpressure() { return this.#backpressure; }
      
      incrementBackpressure() {
        const current = this.#backpressure;
        if (current < 0 || current > 2**16) {
          throw new Error(`invalid current backpressure value [${current}]`);
        }
        const newValue = this.getBackpressure() + 1;
        if (newValue >= 2**16) {
          throw new Error(`invalid new backpressure value [${newValue}], overflow`);
        }
        return this.setBackpressure(newValue);
      }
      
      decrementBackpressure() {
        const current = this.#backpressure;
        if (current < 0 || current > 2**16) {
          throw new Error(`invalid current backpressure value [${current}]`);
        }
        const newValue = Math.max(0, current - 1);
        if (newValue < 0) {
          throw new Error(`invalid new backpressure value [${newValue}], underflow`);
        }
        return this.setBackpressure(newValue);
      }
      hasBackpressure() { return this.#backpressure > 0; }
      
      waitForBackpressure() {
        let backpressureCleared = false;
        const cstate = this;
        cstate.addBackpressureWaiter();
        const handlerID = this.registerHandler({
          event: 'backpressure-change',
          fn: (bp) => {
            if (bp === 0) {
              cstate.removeHandler(handlerID);
              backpressureCleared = true;
            }
          }
        });
        return new Promise((resolve) => {
          const interval = setInterval(() => {
            if (backpressureCleared) { return; }
            clearInterval(interval);
            cstate.removeBackpressureWaiter();
            resolve(null);
          }, 0);
        });
      }
      
      registerHandler(args) {
        const { event, fn } = args;
        if (!event) { throw new Error("missing handler event"); }
        if (!fn) { throw new Error("missing handler fn"); }
        
        if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
          throw new Error(`unrecognized event handler [${event}]`);
        }
        
        const handlerID = this.#nextHandlerID++;
        let handlers = this.#handlerMap.get(event);
        if (!handlers) {
          handlers = [];
          this.#handlerMap.set(event, handlers)
        }
        
        handlers.push({ id: handlerID, fn, event });
        return handlerID;
      }
      
      removeHandler(args) {
        const { event, handlerID } = args;
        const registeredHandlers = this.#handlerMap.get(event);
        if (!registeredHandlers) { return; }
        const found = registeredHandlers.find(h => h.id === handlerID);
        if (!found) { return; }
        this.#handlerMap.set(event, this.#handlerMap.get(event).filter(h => h.id !== handlerID));
      }
      
      getBackpressureWaiters() { return this.#backpressureWaiters; }
      addBackpressureWaiter() { this.#backpressureWaiters++; }
      removeBackpressureWaiter() {
        this.#backpressureWaiters--;
        if (this.#backpressureWaiters < 0) {
          throw new Error("unexepctedly negative number of backpressure waiters");
        }
      }
      
      isExclusivelyLocked() { return this.#locked === true; }
      setLocked(locked) {
        this.#locked = locked;
      }
      
      exclusiveLock() {
        _debugLog('[ComponentAsyncState#exclusiveLock()]', {
          locked: this.#locked,
          componentIdx: this.#componentIdx,
        });
        this.setLocked(true);
      }
      
      exclusiveRelease() {
        _debugLog('[ComponentAsyncState#exclusiveRelease()] args', {
          locked: this.#locked,
          componentIdx: this.#componentIdx,
        });
        this.setLocked(false);
        
        this.#onExclusiveReleaseHandlers = this.#onExclusiveReleaseHandlers.filter(v => !!v);
        for (const [idx, f] of this.#onExclusiveReleaseHandlers.entries()) {
          try {
            this.#onExclusiveReleaseHandlers[idx] = null;
            f();
          } catch (err) {
            _debugLog("error while executing handler for next exclusive release", err);
            throw err;
          }
        }
      }
      
      onNextExclusiveRelease(fn) {
        _debugLog('[ComponentAsyncState#()onNextExclusiveRelease] registering');
        this.#onExclusiveReleaseHandlers.push(fn);
      }
      
      // nextTaskPromise & nextTaskQueue are used to await current task completion and queues
      // any tasks attempting to enter() and complete.
      //
      // see: nextTaskExecutionSlot()
      //
      // TODO(threads): this should be unnecessary once threads are properly implemented,
      // as the task.enter() logic should suffice (it should be guaranteed that we cannot re-enter
      // unless the task in question is the current task in the thread execution, and only one can
      // run at a time)
      #nextTaskPromise = Promise.resolve(true);
      #nextTaskQueue = [];
      
      async nextTaskExecutionSlot(args) {
        const { task } = args;
        
        const placeholder = {
          completed: false,
          task,
          promise: task.exitPromise().then(() => {
            placeholder.completed = true;
          }),
        };
        this.#nextTaskQueue.push(placeholder);
        
        let next;
        while (true) {
          await this.#nextTaskPromise;
          
          next = this.#nextTaskQueue.find(placeholder => !placeholder.completed);
          
          // This task is next in the queue, we can continue
          if (next === undefined || next === placeholder) {
            this.#nextTaskPromise = next.promise;
            if (this.#nextTaskQueue.length > 1000) {
              this.#nextTaskQueue = this.#nextTaskQueue.filter(p => !p.completed);
              if (this.#nextTaskQueue.length > 1000) {
                _debugLog('[ComponentAsyncState#()nextTaskExecutionSlot] next task queue length > 1000 even after cleanup, tasks may be leaking');
              }
            }
            break;
          }
          
          // If we get here, this task was *not* next in the queue, continue waiting
          // (at this point the task that *is* next will likely have already set itself
          // as this.#nextTaskPromise)
        }
      }
      
      #getSuspendedTaskMeta(taskID) {
        return this.#suspendedTasksByTaskID.get(taskID);
      }
      
      #removeSuspendedTaskMeta(taskID) {
        _debugLog('[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task', {
          taskID,
          componentIdx: this.#componentIdx,
        });
        const idx = this.#suspendedTaskIDs.findIndex(t => t === taskID);
        const meta = this.#suspendedTasksByTaskID.get(taskID);
        this.#suspendedTaskIDs[idx] = null;
        this.#suspendedTasksByTaskID.delete(taskID);
        return meta;
      }
      
      #addSuspendedTaskMeta(meta) {
        if (!meta) { throw new Error('missing task meta'); }
        const taskID = meta.taskID;
        this.#suspendedTasksByTaskID.set(taskID, meta);
        this.#suspendedTaskIDs.push(taskID);
        if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
          this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter(t => t !== null);
        }
      }
      
      // TODO(threads): readyFn is normally on the thread
      suspendTask(args) {
        const { task, readyFn } = args;
        const taskID = task.id();
        const componentIdx = task.componentIdx();
        _debugLog('[ComponentAsyncState#suspendTask()]', {
          taskID,
          componentIdx: this.#componentIdx,
          taskEntryFnName: task.entryFnName(),
          subtask: task.getParentSubtask(),
        });
        
        if (componentIdx !== this.#componentIdx) {
          throw new Error('assert: task component idx should match async state');
        }
        
        if (this.#getSuspendedTaskMeta(taskID)) {
          throw new Error(`task [${taskID}] already suspended`);
        }
        
        const { promise, resolve, reject } = promiseWithResolvers();
        this.#addSuspendedTaskMeta({
          task,
          taskID,
          readyFn,
          resume: () => {
            _debugLog('[ComponentAsyncState] resuming suspended task', {
              taskID,
              componentIdx: this.#componentIdx,
            });
            // TODO(threads): it's thread cancellation we should be checking for below, not task
            resolve(!task.isCancelled());
          },
        });
        
        this.runTickLoop();
        
        return promise;
      }
      
      resumeTaskByID(taskID) {
        const meta = this.#removeSuspendedTaskMeta(taskID);
        if (!meta) { return; }
        if (meta.taskID !== taskID) { throw new Error('task ID does not match'); }
        meta.resume();
      }
      
      async runTickLoop() {
        if (this.#tickLoop !== null) { return; }
        this.#tickLoop = 1;
        setTimeout(async () => {
          let done = this.tick();
          while (!done) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            done = this.tick();
          }
          this.#tickLoop = null;
        }, 10);
      }
      
      tick() {
        // _debugLog('[ComponentAsyncState#tick()]', { suspendedTaskIDs: this.#suspendedTaskIDs });
        
        const resumableTasks = this.#suspendedTaskIDs.filter(t => t !== null);
        for (const taskID of resumableTasks) {
          const meta = this.#suspendedTasksByTaskID.get(taskID);
          if (!meta || !meta.readyFn) {
            throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
          }
          
          // If the task failed via any means, allow the task to resume because
          // it's been cancelled -- the callback should immediately exit as well
          if (meta.task.isRejected()) {
            _debugLog('[ComponentAsyncState#tick()] detected task rejection, leaving early', { meta });
            this.resumeTaskByID(taskID);
            return;
          }
          
          const isReady = meta.readyFn();
          if (!isReady) { continue; }
          
          _debugLog('[ComponentAsyncState#tick()] resuming task via tick', {
            taskID,
            componentIdx: this.#componentIdx,
          });
          this.resumeTaskByID(taskID);
        }
        
        return this.#suspendedTaskIDs.filter(t => t !== null).length === 0;
      }
      
      addStreamEndToTable(args) {
        _debugLog('[ComponentAsyncState#addStreamEnd()] args', args);
        const { tableIdx, streamEnd } = args;
        if (typeof streamEnd === 'number') { throw new Error("INSERTING BAD STREAMEND"); }
        
        let { table, componentIdx } = STREAM_TABLES[tableIdx];
        if (componentIdx === undefined || !table) {
          throw new Error(`invalid global stream table state for table [${tableIdx}]`);
        }
        
        const handle = table.insert(streamEnd);
        streamEnd.setHandle(handle);
        streamEnd.setStreamTableIdx(tableIdx);
        
        const cstate = getOrCreateAsyncState(componentIdx);
        const waitableIdx = cstate.handles.insert(streamEnd);
        streamEnd.setWaitableIdx(waitableIdx);
        
        _debugLog('[ComponentAsyncState#addStreamEnd()] added stream end', {
          tableIdx,
          table,
          handle,
          streamEnd,
          destComponentIdx: componentIdx,
        });
        
        return { handle, waitableIdx };
      }
      
      createWaitable(args) {
        return new Waitable({ target: args?.target, });
      }
      
      createReadableStreamEnd(args) {
        _debugLog('[ComponentAsyncState#createStreamEnd()] args', args);
        const { tableIdx, elemMeta, hostInjectFn } = args;
        
        const { table: localStreamTable, componentIdx } = STREAM_TABLES[tableIdx];
        if (!localStreamTable) {
          throw new Error(`missing global stream table lookup for table [${tableIdx}] while creating stream`);
        }
        if (componentIdx !== this.#componentIdx) {
          throw new Error('component idx mismatch while creating stream');
        }
        
        const waitable = this.createWaitable();
        const streamEnd = new StreamReadableEnd({
          tableIdx,
          elemMeta,
          hostInjectFn,
          pendingBufferMeta: {},
          target: `stream read end (lowered, @init)`,
          waitable,
        });
        
        streamEnd.setWaitableIdx(this.handles.insert(streamEnd));
        streamEnd.setHandle(localStreamTable.insert(streamEnd));
        if (streamEnd.streamTableIdx() !== tableIdx) {
          throw new Error("unexpectedly mismatched stream table");
        }
        const streamEndWaitableIdx = streamEnd.waitableIdx();
        const streamEndHandle = streamEnd.handle();
        waitable.setTarget(`waitable for stream read end (lowered, waitable [${streamEndWaitableIdx}])`);
        streamEnd.setTarget(`stream read end (lowered, waitable [${streamEndWaitableIdx}])`);
        
        return {
          waitableIdx: streamEndWaitableIdx,
          handle: streamEndHandle,
          streamEnd,
        };
      }
      
      createStream(args) {
        _debugLog('[ComponentAsyncState#createStream()] args', args);
        const { tableIdx, elemMeta, hostInjectFn } = args;
        if (tableIdx === undefined) { throw new Error("missing table idx while adding stream"); }
        if (elemMeta === undefined) { throw new Error("missing element metadata while adding stream"); }
        
        const { table: localStreamTable, componentIdx } = STREAM_TABLES[tableIdx];
        if (!localStreamTable) {
          throw new Error(`missing global stream table lookup for table [${tableIdx}] while creating stream`);
        }
        if (componentIdx !== this.#componentIdx) {
          throw new Error('component idx mismatch while creating stream');
        }
        
        const readWaitable = this.createWaitable();
        const writeWaitable = this.createWaitable();
        
        const stream = new InternalStream({
          tableIdx,
          elemMeta,
          readWaitable,
          writeWaitable,
          hostInjectFn,
        });
        stream.setGlobalStreamMapRep(STREAMS.insert(stream));
        
        const writeEnd = stream.writeEnd();
        writeEnd.setWaitableIdx(this.handles.insert(writeEnd));
        writeEnd.setHandle(localStreamTable.insert(writeEnd));
        if (writeEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
        
        const writeEndWaitableIdx = writeEnd.waitableIdx();
        const writeEndHandle = writeEnd.handle();
        writeWaitable.setTarget(`waitable for stream write end (waitable [${writeEndWaitableIdx}])`);
        writeEnd.setTarget(`stream write end (waitable [${writeEndWaitableIdx}])`);
        
        const readEnd = stream.readEnd();
        readEnd.setWaitableIdx(this.handles.insert(readEnd));
        readEnd.setHandle(localStreamTable.insert(readEnd));
        if (readEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
        
        const readEndWaitableIdx = readEnd.waitableIdx();
        const readEndHandle = readEnd.handle();
        readWaitable.setTarget(`waitable for read end (waitable [${readEndWaitableIdx}])`);
        readEnd.setTarget(`stream read end (waitable [${readEndWaitableIdx}])`);
        
        return {
          writeEnd,
          writeEndWaitableIdx,
          writeEndHandle,
          readEndWaitableIdx,
          readEndHandle,
          readEnd,
        };
      }
      
      getStreamEnd(args) {
        _debugLog('[ComponentAsyncState#getStreamEnd()] args', args);
        const { tableIdx, streamEndHandle, streamEndWaitableIdx } = args;
        if (tableIdx === undefined) {
          throw new Error('missing table idx while getting stream end');
        }
        
        const { table, componentIdx } = STREAM_TABLES[tableIdx];
        const cstate = getOrCreateAsyncState(componentIdx);
        
        let streamEnd;
        if (streamEndWaitableIdx !== undefined) {
          streamEnd = cstate.handles.get(streamEndWaitableIdx);
        } else if (streamEndHandle !== undefined) {
          if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while getting stream end`); }
          streamEnd = table.get(streamEndHandle);
        } else {
          throw new TypeError("must specify either waitable idx or handle to retrieve stream");
        }
        
        if (!streamEnd) {
          throw new Error(`missing stream end (tableIdx [${tableIdx}], handle [${streamEndHandle}], waitableIdx [${streamEndWaitableIdx}])`);
        }
        if (tableIdx && streamEnd.streamTableIdx() !== tableIdx) {
          throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
        }
        
        return streamEnd;
      }
      
      deleteStreamEnd(args) {
        _debugLog('[ComponentAsyncState#deleteStreamEnd()] args', args);
        const { tableIdx, streamEndWaitableIdx } = args;
        if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
        if (streamEndWaitableIdx === undefined) { throw new Error("missing stream idx while removing stream end"); }
        
        const { table, componentIdx } = STREAM_TABLES[tableIdx];
        const cstate = getOrCreateAsyncState(componentIdx);
        
        const streamEnd = cstate.handles.get(streamEndWaitableIdx);
        if (!streamEnd) {
          throw new Error(`missing stream end [${streamEndWaitableIdx}] in component handles while deleting stream`);
        }
        if (streamEnd.streamTableIdx() !== tableIdx) {
          throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
        }
        
        let removed = cstate.handles.remove(streamEnd.waitableIdx());
        if (!removed) {
          throw new Error(`failed to remove stream end [${streamEndWaitableIdx}] waitable obj in component [${componentIdx}]`);
        }
        
        removed = table.remove(streamEnd.handle());
        if (!removed) {
          throw new Error(`failed to remove stream end with handle [${streamEnd.handle()}] from stream table [${tableIdx}] in component [${componentIdx}]`);
        }
        
        return streamEnd;
      }
      
      removeStreamEndFromTable(args) {
        _debugLog('[ComponentAsyncState#removeStreamEndFromTable()] args', args);
        
        const { tableIdx, streamWaitableIdx } = args;
        if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
        if (streamWaitableIdx === undefined) {
          throw new Error("missing stream end waitable idx while removing stream end");
        }
        
        const { table, componentIdx } = STREAM_TABLES[tableIdx];
        if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while removing stream end`); }
        
        const cstate = getOrCreateAsyncState(componentIdx);
        
        const streamEnd = cstate.handles.get(streamWaitableIdx);
        if (!streamEnd) {
          throw new Error(`missing stream end (handle [${streamWaitableIdx}], table [${tableIdx}])`);
        }
        const handle = streamEnd.handle();
        
        let removed = cstate.handles.remove(streamWaitableIdx);
        if (!removed) {
          throw new Error(`failed to remove streamEnd from handles (waitable idx [${streamWaitableIdx}]), component [${componentIdx}])`);
        }
        
        removed = table.remove(handle);
        if (!removed) {
          throw new Error(`failed to remove streamEnd from table (handle [${handle}]), table [${tableIdx}], component [${componentIdx}])`);
        }
        
        return streamEnd;
      }
      
      createFuture(args) {
        _debugLog('[ComponentAsyncState#createFuture()] args', args);
        const { tableIdx, elemMeta, hostInjectFn } = args;
        if (tableIdx === undefined) { throw new Error("missing table idx while adding future"); }
        if (elemMeta === undefined) { throw new Error("missing element metadata while adding future"); }
        
        const { table: futureTable, componentIdx } = FUTURE_TABLES[tableIdx];
        if (!futureTable) {
          throw new Error(`missing global future table lookup for table [${tableIdx}] while creating future`);
        }
        if (componentIdx !== this.#componentIdx) {
          throw new Error('component idx mismatch while creating future');
        }
        
        const readWaitable = this.createWaitable();
        const writeWaitable = this.createWaitable();
        
        const future = new InternalFuture({
          tableIdx,
          componentIdx: this.#componentIdx,
          elemMeta,
          readWaitable,
          writeWaitable,
          hostInjectFn,
        });
        future.setGlobalFutureMapRep(FUTURES.insert(future));
        
        const writeEnd = future.writeEnd();
        writeEnd.setWaitableIdx(this.handles.insert(writeEnd));
        writeEnd.setHandle(futureTable.insert(writeEnd));
        if (writeEnd.futureTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched future table"); }
        
        const writeEndWaitableIdx = writeEnd.waitableIdx();
        const writeEndHandle = writeEnd.handle();
        writeWaitable.setTarget(`waitable for future write end (waitable [${writeEndWaitableIdx}])`);
        writeEnd.setTarget(`future write end (waitable [${writeEndWaitableIdx}])`);
        
        const readEnd = future.readEnd();
        readEnd.setWaitableIdx(this.handles.insert(readEnd));
        readEnd.setHandle(futureTable.insert(readEnd));
        if (readEnd.futureTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched future table"); }
        
        const readEndWaitableIdx = readEnd.waitableIdx();
        const readEndHandle = readEnd.handle();
        readWaitable.setTarget(`waitable for read end (waitable [${readEndWaitableIdx}])`);
        readEnd.setTarget(`future read end (waitable [${readEndWaitableIdx}])`);
        
        return {
          writeEnd,
          writeEndWaitableIdx,
          writeEndHandle,
          readEndWaitableIdx,
          readEndHandle,
          readEnd,
        };
      }
      
      getFutureEnd(args) {
        _debugLog('[ComponentAsyncState#getFutureEnd()] args', args);
        const { tableIdx, futureEndHandle, futureEndWaitableIdx } = args;
        if (tableIdx === undefined) {
          throw new Error('missing table idx while getting future end');
        }
        
        const { table, componentIdx } = FUTURE_TABLES[tableIdx];
        const cstate = getOrCreateAsyncState(componentIdx);
        
        let futureEnd;
        if (futureEndWaitableIdx !== undefined) {
          futureEnd = cstate.handles.get(futureEndWaitableIdx);
        } else if (futureEndHandle !== undefined) {
          if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while getting future end`); }
          futureEnd = table.get(futureEndHandle);
        } else {
          throw new TypeError("must specify either waitable idx or handle to retrieve future");
        }
        
        if (!futureEnd) {
          throw new Error(`missing future end (tableIdx [${tableIdx}], handle [${futureEndHandle}], waitableIdx [${futureEndWaitableIdx}])`);
        }
        if (tableIdx && futureEnd.futureTableIdx() !== tableIdx) {
          throw new Error(`future end table idx [${futureEnd.futureTableIdx()}] does not match [${tableIdx}]`);
        }
        
        return futureEnd;
      }
      
      removeFutureEndFromTable(args) {
        _debugLog('[ComponentAsyncState#removeFutureEndFromTable()] args', args);
        
        const { tableIdx, futureWaitableIdx } = args;
        if (tableIdx === undefined) { throw new Error("missing table idx while removing future end"); }
        if (futureWaitableIdx === undefined) {
          throw new Error("missing future end waitable idx while removing future end");
        }
        
        const { table, componentIdx } = FUTURE_TABLES[tableIdx];
        if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while removing future end`); }
        
        const cstate = getOrCreateAsyncState(componentIdx);
        
        const futureEnd = cstate.handles.get(futureWaitableIdx);
        if (!futureEnd) {
          throw new Error(`missing future end (handle [${futureWaitableIdx}], table [${tableIdx}])`);
        }
        const handle = futureEnd.handle();
        
        let removed = cstate.handles.remove(futureWaitableIdx);
        if (!removed) {
          throw new Error(`failed to remove futureEnd from handles (waitable idx [${futureWaitableIdx}]), component [${componentIdx}])`);
        }
        
        removed = table.remove(handle);
        if (!removed) {
          throw new Error(`failed to remove futureEnd from table (handle [${handle}]), table [${tableIdx}], component [${componentIdx}])`);
        }
        
        return futureEnd;
      }
      
    }
    
    const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
    let _fs;
    async function fetchCompile (url) {
      if (isNode) {
        _fs = _fs || await import('node:fs/promises');
        return WebAssembly.compile(await _fs.readFile(url));
      }
      return fetch(url).then(WebAssembly.compileStreaming);
    }
    
    
    if (!getCoreModule) getCoreModule = (name) => fetchCompile(new URL(`./${name}`, import.meta.url));
    const module0 = getCoreModule('vfs.core.wasm');
    
    const { Downloader, Terminal } = imports['vfs:host/bridge'];
    
    if (Downloader=== undefined) {
      const err = new Error("unexpectedly undefined instance import 'Downloader', was 'Downloader' available at instantiation?");
      console.error("ERROR:", err.toString());
      throw err;
    }
    
    
    if (Terminal=== undefined) {
      const err = new Error("unexpectedly undefined instance import 'Terminal', was 'Terminal' available at instantiation?");
      console.error("ERROR:", err.toString());
      throw err;
    }
    
    const { Wasip1 } = imports['wasip1-vfs:host/virtual-file-system-wasip1-core'];
    
    if (Wasip1=== undefined) {
      const err = new Error("unexpectedly undefined instance import 'Wasip1', was 'Wasip1' available at instantiation?");
      console.error("ERROR:", err.toString());
      throw err;
    }
    
    const { Wasip1Threads } = imports['wasip1-vfs:host/virtual-file-system-wasip1-threads-import'];
    
    if (Wasip1Threads=== undefined) {
      const err = new Error("unexpectedly undefined instance import 'Wasip1Threads', was 'Wasip1Threads' available at instantiation?");
      console.error("ERROR:", err.toString());
      throw err;
    }
    
    let gen = (function* _initGenerator () {
      
      const _trampoline0 = function(arg0, arg1, arg2) {
        _debugLog('[iface="vfs:host/bridge", function="[static]terminal.terminal-write"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Terminal.terminalWrite',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Terminal.terminalWrite(arg0 >>> 0, arg1, arg2),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]terminal.terminal-write"][Instruction::Return]', {
          funcName: '[static]terminal.terminal-write',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline0.fnName = 'vfs:host/bridge#Terminal.terminalWrite';
      
      const _trampoline1 = function(arg0, arg1) {
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-get-next-file-meta"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Downloader.sysrootGetNextFileMeta',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Downloader.sysrootGetNextFileMeta(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-get-next-file-meta"][Instruction::Return]', {
          funcName: '[static]downloader.sysroot-get-next-file-meta',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline1.fnName = 'vfs:host/bridge#Downloader.sysrootGetNextFileMeta';
      
      const _trampoline2 = function(arg0, arg1) {
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-read-file-chunk"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Downloader.sysrootReadFileChunk',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Downloader.sysrootReadFileChunk(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-read-file-chunk"][Instruction::Return]', {
          funcName: '[static]downloader.sysroot-read-file-chunk',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline2.fnName = 'vfs:host/bridge#Downloader.sysrootReadFileChunk';
      
      const _trampoline3 = function(arg0) {
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-read-file-name"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Downloader.sysrootReadFileName',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Downloader.sysrootReadFileName(arg0),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-read-file-name"][Instruction::Return]', {
          funcName: '[static]downloader.sysroot-read-file-name',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline3.fnName = 'vfs:host/bridge#Downloader.sysrootReadFileName';
      
      const _trampoline4 = function(arg0, arg1) {
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-start-fetch"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Downloader.sysrootStartFetch',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Downloader.sysrootStartFetch(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.sysroot-start-fetch"][Instruction::Return]', {
          funcName: '[static]downloader.sysroot-start-fetch',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline4.fnName = 'vfs:host/bridge#Downloader.sysrootStartFetch';
      
      const _trampoline5 = function(arg0, arg1) {
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.download-file-start"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Downloader.downloadFileStart',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Downloader.downloadFileStart(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.download-file-start"][Instruction::Return]', {
          funcName: '[static]downloader.download-file-start',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline5.fnName = 'vfs:host/bridge#Downloader.downloadFileStart';
      
      const _trampoline6 = function(arg0, arg1) {
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.download-file-chunk"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Downloader.downloadFileChunk',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Downloader.downloadFileChunk(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.download-file-chunk"][Instruction::Return]', {
          funcName: '[static]downloader.download-file-chunk',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline6.fnName = 'vfs:host/bridge#Downloader.downloadFileChunk';
      
      const _trampoline7 = function() {
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.download-file-end"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Downloader.downloadFileEnd',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Downloader.downloadFileEnd(),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="vfs:host/bridge", function="[static]downloader.download-file-end"][Instruction::Return]', {
          funcName: '[static]downloader.download-file-end',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline7.fnName = 'vfs:host/bridge#Downloader.downloadFileEnd';
      
      const _trampoline8 = function(arg0, arg1, arg2, arg3) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-read-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdReadImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdReadImport(arg0, arg1, arg2, arg3),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-read-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-read-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline8.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdReadImport';
      
      const _trampoline9 = function(arg0, arg1, arg2, arg3) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-write-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdWriteImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdWriteImport(arg0, arg1, arg2, arg3),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-write-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-write-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline9.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdWriteImport';
      
      const _trampoline10 = function(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.random-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.randomGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.randomGetImport(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.random-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.random-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline10.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.randomGetImport';
      
      const _trampoline11 = function() {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.sched-yield-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.schedYieldImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.schedYieldImport(),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.sched-yield-import"][Instruction::Return]', {
          funcName: '[static]wasip1.sched-yield-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline11.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.schedYieldImport';
      
      const _trampoline12 = function(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.clock-res-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.clockResGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.clockResGetImport(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.clock-res-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.clock-res-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline12.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.clockResGetImport';
      
      const _trampoline13 = function(arg0, arg1, arg2) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.clock-time-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.clockTimeGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.clockTimeGetImport(arg0, arg1, arg2),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.clock-time-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.clock-time-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline13.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.clockTimeGetImport';
      
      const _trampoline14 = function(arg0) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-threads-import", function="[static]wasip1-threads.thread-spawn-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1Threads.threadSpawnImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1Threads.threadSpawnImport(arg0),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-threads-import", function="[static]wasip1-threads.thread-spawn-import"][Instruction::Return]', {
          funcName: '[static]wasip1-threads.thread-spawn-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline14.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-threads-import#Wasip1Threads.threadSpawnImport';
      
      const _trampoline15 = function(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.environ-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.environGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.environGetImport(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.environ-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.environ-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline15.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.environGetImport';
      
      const _trampoline16 = function(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.environ-sizes-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.environSizesGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.environSizesGetImport(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.environ-sizes-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.environ-sizes-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline16.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.environSizesGetImport';
      
      const _trampoline17 = function(arg0) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-close-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdCloseImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdCloseImport(arg0),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-close-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-close-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline17.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdCloseImport';
      
      const _trampoline18 = function(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-fdstat-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdFdstatGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdFdstatGetImport(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-fdstat-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-fdstat-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline18.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdFdstatGetImport';
      
      const _trampoline19 = function(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-filestat-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdFilestatGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdFilestatGetImport(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-filestat-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-filestat-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline19.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdFilestatGetImport';
      
      const _trampoline20 = function(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-prestat-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdPrestatGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdPrestatGetImport(arg0, arg1),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-prestat-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-prestat-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline20.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdPrestatGetImport';
      
      const _trampoline21 = function(arg0, arg1, arg2) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-prestat-dir-name-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdPrestatDirNameImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdPrestatDirNameImport(arg0, arg1, arg2),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-prestat-dir-name-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-prestat-dir-name-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline21.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdPrestatDirNameImport';
      
      const _trampoline22 = function(arg0, arg1, arg2, arg3, arg4) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-readdir-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.fdReaddirImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.fdReaddirImport(arg0, arg1, arg2, arg3, arg4),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.fd-readdir-import"][Instruction::Return]', {
          funcName: '[static]wasip1.fd-readdir-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline22.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.fdReaddirImport';
      
      const _trampoline23 = function(arg0, arg1, arg2) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.path-create-directory-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.pathCreateDirectoryImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.pathCreateDirectoryImport(arg0, arg1, arg2),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.path-create-directory-import"][Instruction::Return]', {
          funcName: '[static]wasip1.path-create-directory-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline23.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.pathCreateDirectoryImport';
      
      const _trampoline24 = function(arg0, arg1, arg2, arg3, arg4) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.path-filestat-get-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.pathFilestatGetImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.pathFilestatGetImport(arg0, arg1, arg2, arg3, arg4),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.path-filestat-get-import"][Instruction::Return]', {
          funcName: '[static]wasip1.path-filestat-get-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline24.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.pathFilestatGetImport';
      
      const _trampoline25 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.path-open-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.pathOpenImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          ret = _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.pathOpenImport(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.path-open-import"][Instruction::Return]', {
          funcName: '[static]wasip1.path-open-import',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([toInt32(ret)]);
        task.exit();
        return toInt32(ret);
      }
      _trampoline25.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.pathOpenImport';
      
      const _trampoline26 = function(arg0) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.proc-exit-import"] [Instruction::CallInterface] (sync, @ enter)');
        const hostProvided = true;
        
        let parentTask;
        let task;
        let subtask;
        
        const createTask = () => {
          const results = createNewCurrentTask({
            componentIdx: -1,
            isAsync: false,
            entryFnName: 'Wasip1.procExitImport',
            getCallbackFn: () => null,
            callbackFnName: null,
            errHandling: 'none',
            callingWasmExport: false,
          });
          task = results[0];
        };
        
        taskCreation: {
          parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID,
          )?.task;
          
          if (!parentTask) {
            createTask();
            break taskCreation;
          }
          
          createTask();
          
          if (hostProvided) {
            subtask = parentTask.getLatestSubtask();
            if (!subtask) {
              throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
            }
            task.setParentSubtask(subtask);
          }
        }
        
        const started = task.enterSync();
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            componentIdx: task.componentIdx(),
            taskID: task.id(),
            fn: () => Wasip1.procExitImport(arg0),
          })
          ;
        } catch (err) {
          
          _debugLog('[Instruction::CallInterface] error during sync call', {
            taskID: task.id(),
            subtaskID: currentSubtask?.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-core", function="[static]wasip1.proc-exit-import"][Instruction::Return]', {
          funcName: '[static]wasip1.proc-exit-import',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      _trampoline26.fnName = 'wasip1-vfs:host/virtual-file-system-wasip1-core#Wasip1.procExitImport';
      let exports0;
      let exports0FlushToVfs;
      
      function flushToVfs() {
        _debugLog('[iface="flush-to-vfs", function="flush-to-vfs"][Instruction::CallWasm] enter', {
          funcName: 'flush-to-vfs',
          paramCount: 0,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'exports0FlushToVfs',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => exports0FlushToVfs(),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="flush-to-vfs", function="flush-to-vfs"][Instruction::Return]', {
          funcName: 'flush-to-vfs',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      let exports0FlushFromVfs;
      
      function flushFromVfs() {
        _debugLog('[iface="flush-from-vfs", function="flush-from-vfs"][Instruction::CallWasm] enter', {
          funcName: 'flush-from-vfs',
          paramCount: 0,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'exports0FlushFromVfs',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => exports0FlushFromVfs(),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="flush-from-vfs", function="flush-from-vfs"][Instruction::Return]', {
          funcName: 'flush-from-vfs',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      let exports0Dispatch;
      
      function dispatch(arg0, arg1, arg2, arg3) {
        _debugLog('[iface="dispatch", function="dispatch"][Instruction::CallWasm] enter', {
          funcName: 'dispatch',
          paramCount: 4,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'exports0Dispatch',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => exports0Dispatch(toUint32(arg0), toUint32(arg1), toUint32(arg2), toUint32(arg3)),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="dispatch", function="dispatch"][Instruction::Return]', {
          funcName: 'dispatch',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      let exports0AllocBuf;
      
      function allocBuf(arg0) {
        _debugLog('[iface="alloc-buf", function="alloc-buf"][Instruction::CallWasm] enter', {
          funcName: 'alloc-buf',
          paramCount: 1,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'exports0AllocBuf',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          ret =   _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => exports0AllocBuf(toUint32(arg0)),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="alloc-buf", function="alloc-buf"][Instruction::Return]', {
          funcName: 'alloc-buf',
          paramCount: 1,
          async: false,
          postReturn: false
        });
        task.resolve([ret >>> 0]);
        task.exit();
        return ret >>> 0;
      }
      let exports0FreeBuf;
      
      function freeBuf(arg0, arg1) {
        _debugLog('[iface="free-buf", function="free-buf"][Instruction::CallWasm] enter', {
          funcName: 'free-buf',
          paramCount: 2,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'exports0FreeBuf',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => exports0FreeBuf(toUint32(arg0), toUint32(arg1)),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="free-buf", function="free-buf"][Instruction::Return]', {
          funcName: 'free-buf',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      let exports0Init;
      
      function init() {
        _debugLog('[iface="init", function="init"][Instruction::CallWasm] enter', {
          funcName: 'init',
          paramCount: 0,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'exports0Init',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => exports0Init(),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="init", function="init"][Instruction::Return]', {
          funcName: 'init',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      let exports0Main;
      
      function main() {
        _debugLog('[iface="main", function="main"][Instruction::CallWasm] enter', {
          funcName: 'main',
          paramCount: 0,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'exports0Main',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => exports0Main(),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="main", function="main"][Instruction::Return]', {
          funcName: 'main',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      let virtualFileSystemWasip1ThreadsExportWasiThreadStart;
      
      function wasiThreadStart(arg0, arg1) {
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-threads-export", function="wasi-thread-start"][Instruction::CallWasm] enter', {
          funcName: 'wasi-thread-start',
          paramCount: 2,
          async: false,
          postReturn: false,
        });
        const hostProvided = false;
        
        const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          isManualAsync: false,
          entryFnName: 'virtualFileSystemWasip1ThreadsExportWasiThreadStart',
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: 'none',
          callingWasmExport: true,
        });
        
        const started = task.enterSync();
        
        if (null!== null) {
          task.setReturnMemoryIdx(null);
          task.setReturnMemory(() => null());
        }
        
        
        let ret;
        
        try {
          _withGlobalCurrentTaskMeta({
            taskID: task.id(),
            componentIdx: task.componentIdx(),
            fn: () => virtualFileSystemWasip1ThreadsExportWasiThreadStart(toInt32(arg0), toInt32(arg1)),
          });
        } catch (err) {
          
          _debugLog('[Instruction::CallWasm] error during sync call', {
            taskID: task.id(),
            err,
          });
          task.setErrored(err);
          task.reject(err);
          task.exit();
          throw err;
          
        }
        
        _debugLog('[iface="wasip1-vfs:host/virtual-file-system-wasip1-threads-export", function="wasi-thread-start"][Instruction::Return]', {
          funcName: 'wasi-thread-start',
          paramCount: 0,
          async: false,
          postReturn: false
        });
        task.resolve([ret]);
        task.exit();
      }
      let trampoline0 = _trampoline0.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 0,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline0.manuallyAsync,
        paramLiftFns: [_liftFlatU32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline0,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 0,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline0.manuallyAsync,
        paramLiftFns: [_liftFlatU32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline0,
      },
      );
      let trampoline1 = _trampoline1.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 1,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline1.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline1,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 1,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline1.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline1,
      },
      );
      let trampoline2 = _trampoline2.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 2,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline2.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline2,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 2,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline2.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline2,
      },
      );
      let trampoline3 = _trampoline3.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 3,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline3.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline3,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 3,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline3.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline3,
      },
      );
      let trampoline4 = _trampoline4.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 4,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline4.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline4,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 4,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline4.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline4,
      },
      );
      let trampoline5 = _trampoline5.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 5,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline5.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline5,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 5,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline5.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline5,
      },
      );
      let trampoline6 = _trampoline6.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 6,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline6.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline6,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 6,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline6.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline6,
      },
      );
      let trampoline7 = _trampoline7.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 7,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline7.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline7,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 7,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline7.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline7,
      },
      );
      let trampoline8 = _trampoline8.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 8,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline8.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline8,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 8,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline8.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline8,
      },
      );
      let trampoline9 = _trampoline9.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 9,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline9.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline9,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 9,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline9.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline9,
      },
      );
      let trampoline10 = _trampoline10.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 10,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline10.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline10,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 10,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline10.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline10,
      },
      );
      let trampoline11 = _trampoline11.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 11,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline11.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline11,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 11,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline11.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline11,
      },
      );
      let trampoline12 = _trampoline12.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 12,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline12.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline12,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 12,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline12.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline12,
      },
      );
      let trampoline13 = _trampoline13.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 13,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline13.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS64,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline13,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 13,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline13.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS64,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline13,
      },
      );
      let trampoline14 = _trampoline14.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 14,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline14.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline14,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 14,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline14.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline14,
      },
      );
      let trampoline15 = _trampoline15.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 15,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline15.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline15,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 15,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline15.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline15,
      },
      );
      let trampoline16 = _trampoline16.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 16,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline16.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline16,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 16,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline16.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline16,
      },
      );
      let trampoline17 = _trampoline17.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 17,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline17.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline17,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 17,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline17.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline17,
      },
      );
      let trampoline18 = _trampoline18.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 18,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline18.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline18,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 18,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline18.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline18,
      },
      );
      let trampoline19 = _trampoline19.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 19,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline19.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline19,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 19,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline19.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline19,
      },
      );
      let trampoline20 = _trampoline20.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 20,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline20.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline20,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 20,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline20.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline20,
      },
      );
      let trampoline21 = _trampoline21.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 21,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline21.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline21,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 21,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline21.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline21,
      },
      );
      let trampoline22 = _trampoline22.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 22,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline22.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS64,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline22,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 22,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline22.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS64,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline22,
      },
      );
      let trampoline23 = _trampoline23.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 23,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline23.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline23,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 23,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline23.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline23,
      },
      );
      let trampoline24 = _trampoline24.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 24,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline24.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline24,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 24,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline24.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline24,
      },
      );
      let trampoline25 = _trampoline25.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 25,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline25.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS64,_liftFlatS64,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline25,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 25,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline25.manuallyAsync,
        paramLiftFns: [_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS32,_liftFlatS64,_liftFlatS64,_liftFlatS32,_liftFlatS32],
        resultLowerFns: [_lowerFlatS32],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline25,
      },
      );
      let trampoline26 = _trampoline26.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 26,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline26.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline26,
      },
      )) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 26,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline26.manuallyAsync,
        paramLiftFns: [_liftFlatS32],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: 'utf8',
        getMemoryFn: () => null,
        getReallocFn: undefined,
        importFn: _trampoline26,
      },
      );
      ({ exports: exports0 } = yield instantiateCore(yield module0, {
        'vfs:host/bridge': {
          '[static]downloader.download-file-chunk': trampoline6,
          '[static]downloader.download-file-end': trampoline7,
          '[static]downloader.download-file-start': trampoline5,
          '[static]downloader.sysroot-get-next-file-meta': trampoline1,
          '[static]downloader.sysroot-read-file-chunk': trampoline2,
          '[static]downloader.sysroot-read-file-name': trampoline3,
          '[static]downloader.sysroot-start-fetch': trampoline4,
          '[static]terminal.terminal-write': trampoline0,
        },
        'wasip1-vfs:host/virtual-file-system-wasip1-core': {
          '[static]wasip1.clock-res-get-import': trampoline12,
          '[static]wasip1.clock-time-get-import': trampoline13,
          '[static]wasip1.environ-get-import': trampoline15,
          '[static]wasip1.environ-sizes-get-import': trampoline16,
          '[static]wasip1.fd-close-import': trampoline17,
          '[static]wasip1.fd-fdstat-get-import': trampoline18,
          '[static]wasip1.fd-filestat-get-import': trampoline19,
          '[static]wasip1.fd-prestat-dir-name-import': trampoline21,
          '[static]wasip1.fd-prestat-get-import': trampoline20,
          '[static]wasip1.fd-read-import': trampoline8,
          '[static]wasip1.fd-readdir-import': trampoline22,
          '[static]wasip1.fd-write-import': trampoline9,
          '[static]wasip1.path-create-directory-import': trampoline23,
          '[static]wasip1.path-filestat-get-import': trampoline24,
          '[static]wasip1.path-open-import': trampoline25,
          '[static]wasip1.proc-exit-import': trampoline26,
          '[static]wasip1.random-get-import': trampoline10,
          '[static]wasip1.sched-yield-import': trampoline11,
        },
        'wasip1-vfs:host/virtual-file-system-wasip1-threads-import': {
          '[static]wasip1-threads.thread-spawn-import': trampoline14,
        },
      }));
      exports0FlushToVfs = exports0['flush-to-vfs'];
      exports0FlushFromVfs = exports0['flush-from-vfs'];
      exports0Dispatch = exports0.dispatch;
      exports0AllocBuf = exports0['alloc-buf'];
      exports0FreeBuf = exports0['free-buf'];
      exports0Init = exports0.init;
      exports0Main = exports0.main;
      virtualFileSystemWasip1ThreadsExportWasiThreadStart = exports0['wasip1-vfs:host/virtual-file-system-wasip1-threads-export#wasi-thread-start'];
      const virtualFileSystemWasip1ThreadsExport = {
        wasiThreadStart: wasiThreadStart,
        
      };
      
      return { virtualFileSystemWasip1ThreadsExport, allocBuf, dispatch, flushFromVfs, flushToVfs, freeBuf, init, main, 'wasip1-vfs:host/virtual-file-system-wasip1-threads-export': virtualFileSystemWasip1ThreadsExport,  };
    })();
    let promise, resolve, reject;
    function runNext (value) {
      try {
        let done;
        do {
          ({ value, done } = gen.next(value));
        } while (!(value instanceof Promise) && !done);
        if (done) {
          if (resolve) return resolve(value);
          else return value;
        }
        if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
        value.then(nextVal => done ? resolve() : runNext(nextVal), reject);
      }
      catch (e) {
        if (reject) reject(e);
        else throw e;
      }
    }
    const maybeSyncReturn = runNext(null);
    return promise || maybeSyncReturn;
  };
  