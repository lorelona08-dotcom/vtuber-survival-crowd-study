/* A bounded read-only render job using the same estimator and atlas as the
 * synchronous path. The three resulting MultiMesh buffers go back to Godot. */
"use strict";
const release = encodeURIComponent(new URL(self.location.href).searchParams.get("v") || "100k-r5");
importScripts("./swarm.js?v=" + release, "./render_pipeline.js?v=" + release);

const strides = [8, 12, 12];
let atlas;
function allocate(capacity) {
  if (VSCrowd.capacity === capacity) return;
  VSCrowd.reset(capacity, 1);
  if (atlas) VSCrowd.configureAtlas(...atlas);
}

self.onmessage = event => {
  try {
    const job = event.data;
    if (job.type === "configure") {
      atlas = job.parameters;
      if (VSCrowd.capacity !== job.capacity) allocate(job.capacity);
      else VSCrowd.configureAtlas(...atlas);
      return;
    }
    if (job.type !== "draw") return;
    const started = performance.now();
    allocate(job.capacity);
    Object.assign(VSCrowd, VSRenderSnapshot.views(job.snapshot, job.capacity));
    VSCrowd.freeCount = job.capacity - job.alive;
    VSCrowd.seconds = job.seconds;
    VSCrowd.disableOcclusion = job.disableOcclusion;
    VSCrowd.disableDensityLod = job.disableDensityLod;
    VSCrowd.prepareRender(...job.view);
    const counts = VSCrowd.layerSizes.slice();
    const buffers = [];
    for (let i = 0; i < 3; i++) {
      const count = counts[i];
      const allocated = Math.min(job.capacity, Math.max(count, Math.min(count * 4, job.desiredSlots[i] || 0)));
      const nextPower = allocated > 0 ? Math.max(32, 2 ** Math.ceil(Math.log2(allocated))) : 0;
      const length = Math.min(job.capacity, nextPower) * strides[i] * 4;
      const recycled = job.output[i];
      const buffer = recycled && recycled.byteLength >= length ? recycled : new ArrayBuffer(length);
      if (count) new Float32Array(buffer, 0, count * strides[i]).set(VSCrowd.layers[i].subarray(0, count * strides[i]));
      buffers.push(buffer);
    }
    const result = {type: "frame", generation: job.generation, sequence: job.sequence, revision: job.revision,
      sentAt: job.sentAt, bodies: VSCrowd.renderedCount(), spacing: VSCrowd.renderSampleSpacing(), counts, buffers,
      snapshot: job.snapshot, workerMs: performance.now() - started};
    self.postMessage(result, [job.snapshot, ...buffers]);
  } catch (error) {
    self.postMessage({type: "error", message: error.message || String(error)});
  }
};
