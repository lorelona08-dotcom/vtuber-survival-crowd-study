/* Public web-build adapter for the Park's ordinary hopping enemy. One live slot
 * owns one enemy's position, health, velocity and status timers. */
(() => {
  "use strict";

  const CELL = 40;
  const SIDE = 64;
  const MASK = SIDE - 1;
  const RADIUS = 8;
  const MAX_SEPARATED = 7;
  const ROWS = 1024;
  const BODY_STRIDE = 12;
  const SHADOW_STRIDE = 8;
  const EMPTY = new ArrayBuffer(0);

  class Swarm {
    reset(capacity, seed) {
      this.capacity = Math.max(1, Math.trunc(capacity));
      this.seed = (seed >>> 0) || 1;
      const size = this.capacity;
      this.x = new Float32Array(size);
      this.y = new Float32Array(size);
      this.hp = new Float32Array(size);
      this.speed = new Float32Array(size);
      this.phase = new Float32Array(size);
      this.born = new Float32Array(size);
      this.knockX = new Float32Array(size);
      this.knockY = new Float32Array(size);
      this.slowFactor = new Float32Array(size);
      this.slowUntil = new Float64Array(size);
      this.flashUntil = new Float64Array(size);
      this.flip = new Uint8Array(size);
      this.live = new Uint8Array(size);
      this.free = new Int32Array(size);
      for (let i = 0; i < size; i++) this.free[i] = size - 1 - i;
      this.freeCount = size;
      this.head = new Int32Array(SIDE * SIDE).fill(-1);
      this.tail = new Int32Array(SIDE * SIDE).fill(-1);
      this.cellOf = new Int32Array(size).fill(-1);
      this.next = new Int32Array(size).fill(-1);
      this.previous = new Int32Array(size).fill(-1);
      this.neighbors = new Int32Array(MAX_SEPARATED);
      this.results = new Float32Array(size * 4);
      this.one = new Float32Array(4);
      this.rowHead = new Int32Array(ROWS);
      this.rowNext = new Int32Array(size);
      this.layers = [
        new Float32Array(size * SHADOW_STRIDE),
        new Float32Array(size * BODY_STRIDE),
        new Float32Array(size * BODY_STRIDE)
      ];
      this.layerSizes = [0, 0, 0];
      // MultiMesh's TRANSFORM_2D memory layout has two padded rows of four.
      for (let layer = 0; layer < this.layers.length; layer++) {
        const data = this.layers[layer];
        const stride = layer === 0 ? SHADOW_STRIDE : BODY_STRIDE;
        for (let offset = 0; offset < data.length; offset += stride) {
          data[offset] = 1;
          data[offset + 5] = 1;
        }
      }
      this.seconds = 0;
      this.version = 0;
      this.lastUpdated = 0;
      this.drawn = 0;
      this.totalSteps = 0;
    }

    random() {
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
      return this.seed / 4294967296;
    }

    bucket(x, y) {
      return (Math.floor(x / CELL) & MASK) + (Math.floor(y / CELL) & MASK) * SIDE;
    }

    link(id, bucket) {
      const last = this.tail[bucket];
      if (last === -1) this.head[bucket] = id;
      else this.next[last] = id;
      this.previous[id] = last;
      this.next[id] = -1;
      this.tail[bucket] = id;
      this.cellOf[id] = bucket;
    }

    unlink(id) {
      const bucket = this.cellOf[id];
      const before = this.previous[id];
      const after = this.next[id];
      if (before === -1) this.head[bucket] = after;
      else this.next[before] = after;
      if (after === -1) this.tail[bucket] = before;
      else this.previous[after] = before;
      this.cellOf[id] = -1;
    }

    spawn(x, y, hp, speed, phase) {
      if (!this.freeCount) return -1;
      const id = this.free[--this.freeCount];
      this.x[id] = x;
      this.y[id] = y;
      this.hp[id] = hp;
      this.speed[id] = speed;
      this.phase[id] = phase;
      this.born[id] = this.seconds;
      this.flip[id] = 0;
      this.knockX[id] = this.knockY[id] = 0;
      this.slowFactor[id] = 1;
      this.slowUntil[id] = this.flashUntil[id] = 0;
      this.live[id] = 1;
      this.link(id, this.bucket(x, y));
      this.version++;
      return id;
    }

    aliveCount() { return this.capacity - this.freeCount; }
    updatedCount() { return this.lastUpdated; }
    renderedCount() { return this.drawn; }
    revision() { return this.version; }
    clock() { return this.seconds; }
    ticks() { return this.totalSteps; }

    visibleCount(cx, cy, halfWidth, halfHeight) {
      let count = 0;
      for (let i = 0; i < this.capacity; i++) {
        if (this.live[i] && Math.abs(this.x[i] - cx) <= halfWidth &&
            Math.abs(this.y[i] - cy) <= halfHeight) count++;
      }
      return count;
    }

    separate() {
      // The upstream game separates only the first seven enemies per cell.
      const minDistance = RADIUS * 2 * 0.8;
      for (let bucket = 0; bucket < this.head.length; bucket++) {
        let id = this.head[bucket];
        let count = 0;
        while (id !== -1 && count < MAX_SEPARATED) {
          this.neighbors[count++] = id;
          id = this.next[id];
        }
        for (let i = 0; i < count; i++) {
          const a = this.neighbors[i];
          for (let j = i + 1; j < count; j++) {
            const b = this.neighbors[j];
            const dx = this.x[a] - this.x[b];
            const dy = this.y[a] - this.y[b];
            const d2 = dx * dx + dy * dy;
            if (d2 >= minDistance * minDistance) continue;
            if (d2 <= 0.0001) {
              this.x[a] += this.random() * 2 - 1;
              this.y[a] += this.random() * 2 - 1;
              continue;
            }
            const distance = Math.sqrt(d2);
            const f = (minDistance - distance) * 0.5 / distance;
            this.x[a] += dx * f;
            this.y[a] += dy * f;
            this.x[b] -= dx * f;
            this.y[b] -= dy * f;
          }
        }
      }
    }

    step(delta, px, py, speedMultiplier, playerHitRadius) {
      this.separate();
      this.head.fill(-1);
      this.tail.fill(-1);
      const contactDistance = (RADIUS + playerHitRadius) ** 2;
      const friction = delta * 500;
      let contact = -1;
      let updated = 0;
      for (let i = 0; i < this.capacity; i++) {
        if (!this.live[i]) continue;
        updated++;
        const dx = px - this.x[i];
        const dy = py - this.y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 > 520 * 520) {
          // Four edges of the original 640×360 camera, grown by 26 units.
          const side = Math.floor(this.random() * 4);
          const t = this.random() * 2 - 1;
          this.x[i] = px + (side < 2 ? t * 346 : (side === 2 ? -346 : 346));
          this.y[i] = py + (side < 2 ? (side === 0 ? -206 : 206) : t * 206);
        } else {
          const distance = Math.sqrt(d2);
          const slowed = this.slowUntil[i] > this.seconds;
          const speed = this.speed[i] * 1.05 * speedMultiplier *
            (slowed ? this.slowFactor[i] : 1);
          const kx = this.knockX[i];
          const ky = this.knockY[i];
          this.x[i] += ((distance > 0.01 ? dx / distance : 1) * speed + kx) * delta;
          this.y[i] += ((distance > 0.01 ? dy / distance : 0) * speed + ky) * delta;
          if (kx || ky) {
            const length = Math.sqrt(kx * kx + ky * ky);
            const fraction = Math.max(0, 1 - friction / length);
            this.knockX[i] = kx * fraction;
            this.knockY[i] = ky * fraction;
          }
          if (Math.abs(dx) > 2) this.flip[i] = dx < 0 ? 1 : 0;
          if (contact === -1 && d2 < contactDistance) contact = i;
        }
        this.link(i, this.bucket(this.x[i], this.y[i]));
      }
      this.seconds += delta;
      this.lastUpdated = updated;
      this.totalSteps++;
      this.version++;
      return contact;
    }

    query(x, y, radius) {
      const left = Math.floor((x - radius) / CELL);
      const right = Math.floor((x + radius) / CELL);
      const top = Math.floor((y - radius) / CELL);
      const bottom = Math.floor((y + radius) / CELL);
      const rr = radius * radius;
      let offset = 0;
      // A wide query visits each wrapped bucket at most once. The distance
      // check rejects hash collisions, including queries outside the crowd.
      for (let cx = left; cx <= Math.min(right, left + MASK); cx++) {
        for (let cy = top; cy <= Math.min(bottom, top + MASK); cy++) {
          const bucket = (cx & MASK) + (cy & MASK) * SIDE;
          for (let i = this.head[bucket]; i !== -1; i = this.next[i]) {
            const dx = this.x[i] - x;
            const dy = this.y[i] - y;
            if (dx * dx + dy * dy > rr) continue;
            this.results[offset++] = i;
            this.results[offset++] = this.x[i];
            this.results[offset++] = this.y[i];
            this.results[offset++] = this.hp[i];
          }
        }
      }
      return offset ? this.results.buffer.slice(0, offset * 4) : EMPTY;
    }

    snapshot(id) {
      if (!this.live[id]) return EMPTY;
      this.one[0] = id;
      this.one[1] = this.x[id];
      this.one[2] = this.y[id];
      this.one[3] = this.hp[id];
      return this.one.buffer;
    }

    hurt(id, damage, knockX, knockY) {
      if (!this.live[id]) return -1;
      this.hp[id] = Math.max(0, this.hp[id] - damage);
      this.knockX[id] += knockX;
      this.knockY[id] += knockY;
      this.flashUntil[id] = this.seconds + 0.08;
      this.version++;
      if (this.hp[id] === 0) {
        this.unlink(id);
        this.live[id] = 0;
        this.free[this.freeCount++] = id;
      }
      return this.hp[id];
    }

    slow(id, factor, duration) {
      if (!this.live[id]) return;
      if (this.slowUntil[id] <= this.seconds || factor < this.slowFactor[id]) {
        this.slowFactor[id] = factor;
      }
      this.slowUntil[id] = Math.max(this.slowUntil[id], this.seconds + duration);
      this.version++;
    }

    prepareRender(cx, cy, halfWidth, halfHeight, splitY, bodyOffset, margin) {
      this.rowHead.fill(-1);
      const top = cy - halfHeight - margin;
      const height = Math.max(1, 2 * (halfHeight + margin));
      const rowScale = Math.min(1, (ROWS - 1) / height);
      const lastRow = Math.min(ROWS - 1, Math.ceil(height * rowScale));
      this.layerSizes.fill(0);
      for (let i = this.capacity - 1; i >= 0; i--) {
        if (!this.live[i] || Math.abs(this.x[i] - cx) > halfWidth + margin ||
            Math.abs(this.y[i] - cy) > halfHeight + margin) continue;
        const row = Math.min(lastRow, Math.max(0, Math.floor((this.y[i] - top) * rowScale)));
        this.rowNext[i] = this.rowHead[row];
        this.rowHead[row] = i;
      }
      const shadows = this.layers[0];
      for (let row = 0; row <= lastRow; row++) {
        for (let i = this.rowHead[row]; i !== -1; i = this.rowNext[i]) {
          const x = this.x[i];
          const y = this.y[i];
          const shadow = this.layerSizes[0]++ * SHADOW_STRIDE;
          shadows[shadow + 3] = x;
          shadows[shadow + 7] = y;
          const layer = y <= splitY ? 1 : 2;
          const index = this.layerSizes[layer]++ * BODY_STRIDE;
          const body = this.layers[layer];
          body[index + 3] = x;
          body[index + 7] = y + bodyOffset;
          body[index + 8] = this.phase[i];
          body[index + 9] = this.flip[i];
          body[index + 10] = this.flashUntil[i] > this.seconds ? 2 :
            (this.slowUntil[i] > this.seconds ? 1 : 0);
          body[index + 11] = this.born[i];
        }
      }
      this.drawn = this.layerSizes[0];
    }

    layerCount(layer) { return this.layerSizes[layer]; }
    layerBuffer(layer) { return this.layers[layer].buffer; }
  }

  globalThis.VSCrowd = new Swarm();
})();
