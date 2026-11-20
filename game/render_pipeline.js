/* The main thread owns combat. Only a read-only visual snapshot crosses to
 * the worker; neither live slots nor the game simulation ever change owners. */
(() => {
  "use strict";
  const fields = [
    ["slowUntil", Float64Array], ["flashUntil", Float64Array],
    ["x", Float32Array], ["y", Float32Array], ["phase", Float32Array], ["born", Float32Array],
    ["flip", Uint8Array], ["live", Uint8Array], ["kind", Uint8Array],
  ];
  function views(buffer, capacity) {
    const out = {};
    let offset = 0;
    for (const [name, Type] of fields) {
      out[name] = new Type(buffer, offset, capacity);
      offset += capacity * Type.BYTES_PER_ELEMENT;
    }
    return out;
  }
  const bytesPerSlot = fields.reduce((total, field) => total + field[1].BYTES_PER_ELEMENT, 0);
  globalThis.VSRenderSnapshot = {views, bytesPerSlot};
  if (typeof document === "undefined") return;

  const pipelineURL = new URL(document.currentScript.src);
  const workerURL = new URL("crowd_worker.js", pipelineURL);
  workerURL.searchParams.set("v", pipelineURL.searchParams.get("v") || "mixed-r6");
  const forceSync = new URLSearchParams(location.search).get("render") === "sync";
  const strides = [8, 12, 12];
  const empty = new Uint8Array(0);
  let worker, configured, disabled = forceSync || typeof Worker === "undefined";
  let generation = 0, sequence = 0, inFlight = false, needsBlank = true;
  let snapshotBuffer, reusableOutput, incoming, displayed;
  let lastRevision = -1, lastView = [], lastMode = "";
  let requestedView = null;
  let lastBodyCount = 0, lastSpacing = 0, lastWorkerMs = 0, lastLagMs = 0;
  let submitted = 0, applied = 0, ignored = 0;
  let frameTimes = [];
  let latestAppliedAt = 0;
  const desiredSlots = [0, 0, 0];
  const padding = [null, null, null];
  const source = () => globalThis.VSCrowd;

  function recycle(frame) {
    if (frame && frame.buffers) reusableOutput = frame.buffers;
  }
  function invalidate() {
    generation++;
    recycle(incoming || displayed);
    incoming = displayed = null;
    needsBlank = true;
    lastBodyCount = lastSpacing = 0;
    lastRevision = -1;
    lastView = [];
    requestedView = null;
    frameTimes = [];
    latestAppliedAt = 0;
    if (source()) { source().drawn = 0; source().lastSpacing = 0; }
  }
  function disableWorker(message) {
    if (disabled) return;
    disabled = true;
    if (worker) worker.terminate();
    worker = null;
    inFlight = false;
    snapshotBuffer = reusableOutput = null;
    invalidate();
    console.warn("군중 표시 워커를 사용할 수 없어 동기 렌더링을 사용합니다.", message);
  }
  function startWorker() {
    if (disabled || worker) return;
    try {
      worker = new Worker(workerURL, {name: "survival-crowd-render"});
      worker.onerror = event => disableWorker(event.message || "Worker error");
      worker.onmessageerror = () => disableWorker("Worker message error");
      worker.onmessage = event => {
        const frame = event.data;
        if (frame.type === "error") { disableWorker(frame.message); return; }
        if (frame.type !== "frame") return;
        inFlight = false;
        snapshotBuffer = frame.snapshot;
        frame.snapshot = null;
        if (frame.generation !== generation) {
          ignored++;
          recycle(frame);
          return;
        }
        // Godot has already copied the last applied buffers to GPU memory.
        // Keep at most one waiting result and immediately use an available
        // newer simulation snapshot, rather than waiting a full browser frame.
        recycle(incoming);
        incoming = frame;
        const swarm = source();
        if (lastMode === "worker" && requestedView && !document.hidden && swarm.aliveCount() >= 6000) {
          schedule(swarm, swarm.revision(), requestedView);
        }
      };
    } catch (error) { disableWorker(error.message); }
  }
  function configureAtlas(...parameters) {
    const swarm = source();
    swarm.configureAtlas(...parameters);
    configured = parameters;
    invalidate();
    startWorker();
    if (worker) worker.postMessage({type: "configure", capacity: swarm.capacity, parameters});
  }
  function changed(revision, view) {
    return lastRevision !== revision || view.length !== lastView.length || view.some((v, i) => v !== lastView[i]);
  }
  function remember(revision, view) { lastRevision = revision; lastView = view; }
  function schedule(swarm, revision, view) {
    if (!worker || inFlight || !changed(revision, view)) return;
    const capacity = swarm.capacity;
    const length = capacity * bytesPerSlot;
    const snapshot = snapshotBuffer?.byteLength === length ? snapshotBuffer : new ArrayBuffer(length);
    snapshotBuffer = null;
    const copy = views(snapshot, capacity);
    for (const [name] of fields) copy[name].set(swarm[name]);
    const output = reusableOutput || [];
    reusableOutput = null;
    const job = {type: "draw", generation, sequence: ++sequence, sentAt: performance.now(), revision, capacity,
      alive: swarm.aliveCount(), seconds: swarm.seconds, view, snapshot, output, desiredSlots,
      disableOcclusion: !!swarm.disableOcclusion, disableDensityLod: !!swarm.disableDensityLod};
    try {
      worker.postMessage(job, [snapshot, ...output]);
      inFlight = true;
      submitted++;
      remember(revision, view);
    } catch (error) { disableWorker(error.message); }
  }
  function appliedAt(now) {
    applied++;
    latestAppliedAt = now;
    frameTimes.push(now);
    while (frameTimes.length > 1 && frameTimes[0] < now - 2000) frameTimes.shift();
  }
  function prepare(...view) {
    const swarm = source();
    const alive = swarm.aliveCount();
    if (!alive) {
      if (lastBodyCount || incoming || lastMode !== "empty") invalidate();
      lastMode = "empty";
      const blank = needsBlank;
      needsBlank = false;
      return blank;
    }
    // Small groups cost less to draw directly than to transfer between threads.
    const mode = !disabled && configured && worker && alive >= 6000 ? "worker" : "sync";
    if (lastMode !== mode) {
      invalidate();
      lastMode = mode;
    }
    const revision = swarm.revision();
    if (mode === "sync") {
      if (!needsBlank && !changed(revision, view)) return false;
      needsBlank = false;
      const start = performance.now();
      swarm.prepareRender(...view);
      const end = performance.now();
      lastWorkerMs = end - start;
      lastLagMs = end - start;
      lastBodyCount = swarm.renderedCount();
      lastSpacing = swarm.renderSampleSpacing();
      remember(revision, view);
      appliedAt(end);
      return true;
    }
    requestedView = view;
    let upload = needsBlank;
    needsBlank = false;
    if (incoming) {
      recycle(displayed);
      displayed = incoming;
      incoming = null;
      const now = performance.now();
      lastBodyCount = swarm.drawn = displayed.bodies;
      lastSpacing = swarm.lastSpacing = displayed.spacing;
      lastWorkerMs = displayed.workerMs;
      lastLagMs = now - displayed.sentAt;
      appliedAt(now);
      upload = true;
    }
    schedule(swarm, revision, view);
    return upload;
  }
  function layerCount(layer) {
    if (lastMode === "sync") return source().layerCount(layer);
    return displayed ? displayed.counts[layer] : 0;
  }
  function layerBuffer(layer, slots) {
    desiredSlots[layer] = slots;
    if (lastMode === "sync") return source().layerBuffer(layer, slots);
    if (!displayed) return empty;
    const buffer = displayed.buffers[layer];
    const fullLength = slots * strides[layer] * 4;
    if (buffer.byteLength >= fullLength) return new Uint8Array(buffer, 0, fullLength);
    // During a layer-size transition Godot may retain a larger GPU allocation
    // than the worker predicted. The invisible tail only pads the upload size.
    if (!padding[layer] || padding[layer].byteLength < fullLength) padding[layer] = new Uint8Array(fullLength);
    const target = padding[layer].subarray(0, fullLength);
    target.set(new Uint8Array(buffer));
    return target;
  }
  function stats() {
    const now = performance.now();
    const n = frameTimes.length;
    const hz = n > 1 && now - latestAppliedAt < 500
      ? (n - 1) * 1000 / (frameTimes[n - 1] - frameTimes[0]) : 0;
    return {mode: lastMode || "idle", submitted, applied, ignored, inFlight, bodies: lastBodyCount,
      spacing: lastSpacing, hz, workMs: lastWorkerMs, lagMs: lastLagMs,
      ageMs: latestAppliedAt ? now - latestAppliedAt : 0, generation};
  }
  globalThis.VSRender = {configureAtlas, invalidate, prepare, layerCount, layerBuffer, stats,
    renderedCount: () => lastBodyCount, renderSampleSpacing: () => lastSpacing};
})();
