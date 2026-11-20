/* Ordinary straight hostile shots in the Park use the game's endpoint hit
 * test. The game still owns player damage, status effects and boss callbacks. */
(() => {
  "use strict";

  const HATE = 0;
  const REVERSE = 1;
  const MANUAL = 0;
  const BOSS = 1;
  const TRANSFORM = 8;
  const GOLDEN_ANGLE = 2.39996322972865;
  const EMPTY = new ArrayBuffer(0);
  const f32 = Math.fround;
  const fields = {
    id: Float64Array, x: Float32Array, y: Float32Array,
    vx: Float32Array, vy: Float32Array, life: Float64Array,
    damage: Float64Array, radius: Float32Array, kind: Uint8Array, source: Uint8Array
  };

  function sourceCode(source) {
    return source === "boss" || source === BOSS ? BOSS : MANUAL;
  }

  function kindCode(kind) {
    if (kind === "hate" || kind === HATE) return HATE;
    if (kind === "rev" || kind === REVERSE) return REVERSE;
    return -1;
  }

  function value(counters, source) {
    return source === undefined ? counters[0] + counters[1] : counters[sourceCode(source)];
  }

  class StraightShots {
    constructor() {
      this.capacity = 0;
      this.version = 0;
      this.layers = [new Float32Array(0), new Float32Array(0)];
      this.drawCount = [0, 0];
      this.reset();
    }

    reset() {
      this.count = 0;
      this.sequence = 0;
      this.liveBySource = [0, 0];
      this.firedBySource = [0, 0];
      this.hitBySource = [0, 0];
      this.expiredBySource = [0, 0];
      this.clearedBySource = [0, 0];
      this.drawCount.fill(0);
      this.reserve(16384);
      this.id.fill(0);
      this.life.fill(0);
      this.version++;
    }

    reserve(required) {
      if (required <= this.capacity) return;
      let next = Math.max(256, this.capacity);
      while (next < required) next *= 2;
      for (const [name, Storage] of Object.entries(fields)) {
        const grown = new Storage(next);
        if (this[name]) grown.set(this[name].subarray(0, this.count));
        this[name] = grown;
      }
      this.events = new Float32Array(next * 5);
      this.capacity = next;
    }

    insert(x, y, vx, vy, damage, life, radius, kind, source) {
      const index = this.count++;
      const id = ++this.sequence;
      this.id[index] = id;
      this.x[index] = x; this.y[index] = y;
      this.vx[index] = vx; this.vy[index] = vy;
      this.damage[index] = damage;
      this.life[index] = life;
      this.radius[index] = radius;
      this.kind[index] = kind;
      this.source[index] = source;
      this.liveBySource[source]++;
      this.firedBySource[source]++;
      return id;
    }

    spawn(x, y, vx, vy, damage, life, radius, kind = "hate", source = "manual") {
      const code = kindCode(kind);
      if (code < 0 || !(life > 0) || radius < 0) return -1;
      this.reserve(this.count + 1);
      this.version++;
      return this.insert(x, y, vx, vy, damage, life, radius, code, sourceCode(source));
    }

    spawnWave(n, px, py, startIndex) {
      n = Math.max(0, Math.trunc(n));
      if (!n) return 0;
      this.reserve(this.count + n);
      // A new pencil of 500 rotates as a whole. Thus 10,000 in one frame
      // have distinct trajectories; the first pencil matches the original.
      for (let i = startIndex; i < startIndex + n; i++) {
        const band = Math.floor(i / 100) % 5;
        const turn = (i % 100) * 2 * Math.PI / 100 +
          band * 0.075 + Math.floor(i / 500) * GOLDEN_ANGLE;
        const angle = f32(turn);
        const dx = f32(Math.cos(angle)), dy = f32(Math.sin(angle));
        const distance = 98 + 14 * band;
        const twist = f32(0.08 * (band - 2));
        const cosine = f32(Math.cos(twist)), sine = f32(Math.sin(twist));
        const speed = -(50 + 8 * band);
        const vx = f32(f32(dx * cosine) - f32(dy * sine)) * speed;
        const vy = f32(f32(dx * sine) + f32(dy * cosine)) * speed;
        this.insert(px + f32(dx * distance), py + f32(dy * distance),
          vx, vy, 4, 4, 4, HATE, MANUAL);
      }
      this.version++;
      return n;
    }

    clear() {
      const removed = this.count;
      this.id.fill(0, 0, removed);
      this.life.fill(0, 0, removed);
      this.clearedBySource[MANUAL] += this.liveBySource[MANUAL];
      this.clearedBySource[BOSS] += this.liveBySource[BOSS];
      this.liveBySource.fill(0);
      this.drawCount.fill(0);
      this.count = 0;
      this.version++;
      return removed;
    }

    aliveCount() { return this.count; }
    sourceCount(source) { return value(this.liveBySource, source); }
    fired(source) { return value(this.firedBySource, source); }
    hits(source) { return value(this.hitBySource, source); }
    expired(source) { return value(this.expiredBySource, source); }
    cleared(source) { return value(this.clearedBySource, source); }
    revision() { return this.version; }

    audit(source) {
      const match = source === undefined ? -1 : sourceCode(source);
      let living = 0;
      for (let i = 0; i < this.capacity; i++) {
        if (this.id[i] && this.life[i] > 0 && (match < 0 || this.source[i] === match)) living++;
      }
      return living;
    }

    step(delta, playerX, playerY, timeSlow) {
      const total = this.count;
      if (!total) return EMPTY;
      let keep = 0, hitWords = 0;
      const dt = f32(delta), slow = f32(timeSlow);
      for (let i = 0; i < total; i++) {
        const source = this.source[i];
        const remaining = this.life[i] - delta;
        if (remaining <= 0) {
          this.liveBySource[source]--;
          this.expiredBySource[source]++;
          continue;
        }
        const x = f32(this.x[i] + f32(f32(this.vx[i] * dt) * slow));
        const y = f32(this.y[i] + f32(f32(this.vy[i] * dt) * slow));
        const dx = f32(x - playerX), dy = f32(y - playerY);
        const distance2 = f32(f32(dx * dx) + f32(dy * dy));
        const reach = this.radius[i] + 6;
        // Godot's Vector2 distance is single precision. Preserve its strict
        // inequality at grazing edges, including values rounding to 10.0.
        if (distance2 < reach * reach && f32(Math.sqrt(distance2)) < reach) {
          this.events[hitWords++] = x;
          this.events[hitWords++] = y;
          this.events[hitWords++] = this.damage[i];
          this.events[hitWords++] = this.kind[i];
          this.events[hitWords++] = source;
          this.liveBySource[source]--;
          this.hitBySource[source]++;
          continue;
        }
        // Stable in-place compaction preserves the original admission/hit
        // order even when early bullets expire during this physics tick.
        if (keep !== i) {
          this.id[keep] = this.id[i];
          this.vx[keep] = this.vx[i]; this.vy[keep] = this.vy[i];
          this.damage[keep] = this.damage[i];
          this.radius[keep] = this.radius[i];
          this.source[keep] = source;
          this.kind[keep] = this.kind[i];
        }
        this.x[keep] = x; this.y[keep] = y;
        this.life[keep++] = remaining;
      }
      if (keep < total) {
        this.id.fill(0, keep, total);
        this.life.fill(0, keep, total);
      }
      this.count = keep;
      this.version++;
      return hitWords > 0 ? this.events.buffer.slice(0, hitWords * 4) : EMPTY;
    }

    reserveLayer(kind, required) {
      if (this.layers[kind].length >= required * TRANSFORM) return;
      let slots = 32;
      while (slots < required) slots *= 2;
      const buffer = new Float32Array(slots * TRANSFORM);
      for (let i = 0; i < buffer.length; i += TRANSFORM) {
        buffer[i] = 1;
        buffer[i + 5] = 1;
      }
      buffer.set(this.layers[kind]);
      this.layers[kind] = buffer;
    }

    prepareRender(cx, cy, halfWidth, halfHeight, margin = 20) {
      this.drawCount.fill(0);
      const w = halfWidth + margin, h = halfHeight + margin;
      for (let i = 0; i < this.count; i++) {
        const x = this.x[i], y = this.y[i];
        if (Math.abs(x - cx) > w || Math.abs(y - cy) > h) continue;
        const kind = this.kind[i];
        const slot = this.drawCount[kind]++;
        this.reserveLayer(kind, slot + 1);
        const buffer = this.layers[kind], at = slot * TRANSFORM;
        buffer[at + 3] = x;
        buffer[at + 7] = y;
      }
    }

    layerCount(kind = "hate") { return this.drawCount[kindCode(kind)] || 0; }

    layerBuffer(kind, allocated) {
      const code = kindCode(kind);
      this.reserveLayer(code, allocated);
      return new Uint8Array(this.layers[code].buffer, 0, allocated * TRANSFORM * 4);
    }
  }

  globalThis.VSProjectiles = new StraightShots();
})();
