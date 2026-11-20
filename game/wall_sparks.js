/* Transient particles for manual straight shots blocked by real map walls.
 * Godot supplies the same random velocity and lifetime as its original FX. */
(() => {
  "use strict";
  const f32 = Math.fround;
  const STRIDE = 12;
  const DAMPING = f32(0.9);
  const TAIL = f32(0.035);
  const fields = {
    x: Float32Array, y: Float32Array, vx: Float32Array, vy: Float32Array,
    age: Float64Array, duration: Float64Array,
  };

  function decodeBase64(text) {
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(text);
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  function allocation(needed) {
    return needed <= 1024 ? Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, needed)))) : Math.ceil(needed / 1024) * 1024;
  }

  class WallSparks {
    constructor() {
      this.capacity = 0;
      this.draw = new Float32Array(0);
      this.reset();
    }
    reset() {
      this.count = this.submitted = this.impacts = this.spawned = this.expired = this.peak = 0;
    }
    reserve(needed) {
      if (this.capacity >= needed) return;
      this.capacity = Math.max(needed, this.capacity * 2, 128);
      for (const [name, Type] of Object.entries(fields)) {
        const grown = new Type(this.capacity);
        if (this[name]) grown.set(this[name].subarray(0, this.count));
        this[name] = grown;
      }
    }
    reserveDrawing(needed) {
      if (this.draw.length >= needed * STRIDE) return;
      const data = new Float32Array(allocation(needed) * STRIDE);
      data.set(this.draw);
      for (let i = this.draw.length; i < data.length; i += STRIDE) {
        data[i] = 1;
        data[i + 5] = 1;
      }
      this.draw = data;
    }
    emit(points, velocitiesAndLifetimes) {
      const impacts = points.length / 2;
      const added = impacts * 3;
      if (!Number.isInteger(impacts) || velocitiesAndLifetimes.length !== added * 3) {
        throw new Error("벽 접촉 위치와 불꽃 초기값 개수가 일치하지 않습니다.");
      }
      this.reserve(this.count + added);
      for (let j = 0; j < added; j++) {
        const id = this.count + j, pos = Math.floor(j / 3) * 2, ray = j * 3;
        this.x[id] = points[pos];
        this.y[id] = points[pos + 1];
        this.vx[id] = velocitiesAndLifetimes[ray];
        this.vy[id] = velocitiesAndLifetimes[ray + 1];
        this.age[id] = 0;
        this.duration[id] = velocitiesAndLifetimes[ray + 2];
      }
      this.count += added;
      this.impacts += impacts;
      this.spawned += added;
      this.peak = Math.max(this.peak, this.count);
      return added;
    }
    takeImpacts(encodedRays) {
      const bytes = globalThis.VSProjectiles.wallImpactPositions();
      const positions = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const rays = decodeBase64(encodedRays);
      return this.emit(positions, new Float64Array(rays.buffer, rays.byteOffset, rays.byteLength / 8));
    }
    advance(delta, left, top, right, bottom) {
      const dt = f32(delta), previous = this.count;
      this.reserveDrawing(previous);
      let keep = 0, drawCount = 0;
      for (let i = 0; i < previous; i++) {
        const age = this.age[i] + delta, duration = this.duration[i];
        if (age >= duration) continue;
        const x = f32(this.x[i] + f32(this.vx[i] * dt));
        const y = f32(this.y[i] + f32(this.vy[i] * dt));
        const vx = f32(this.vx[i] * DAMPING), vy = f32(this.vy[i] * DAMPING);
        this.x[keep] = x; this.y[keep] = y;
        this.vx[keep] = vx; this.vy[keep] = vy;
        this.age[keep] = age; this.duration[keep] = duration;
        keep++;
        if (x < left || x > right || y < top || y > bottom) continue;
        const offset = drawCount++ * STRIDE;
        this.draw[offset + 3] = x;
        this.draw[offset + 7] = y;
        this.draw[offset + 8] = f32(vx * TAIL);
        this.draw[offset + 9] = f32(vy * TAIL);
        this.draw[offset + 10] = 1 - age / duration;
      }
      this.expired += previous - keep;
      this.count = keep;
      this.submitted = drawCount;
      return drawCount;
    }
    buffer(slots) {
      this.reserveDrawing(slots);
      return new Uint8Array(this.draw.buffer, 0, slots * STRIDE * 4);
    }
  }
  globalThis.VSWallSparks = new WallSparks();
})();
