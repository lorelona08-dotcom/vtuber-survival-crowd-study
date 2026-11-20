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

  // A tile is marked only when every world point in its 2×2 area is behind
  // opaque atlas texels. This remains conservative at any window resolution.
  class Coverage {
    begin(cx, cy, halfWidth, halfHeight, margin) {
      const padding = 2 * margin + 8;
      this.x = Math.floor((cx - halfWidth - padding) / 2) * 2;
      this.y = Math.floor((cy - halfHeight - padding) / 2) * 2;
      this.columns = Math.ceil((halfWidth + padding + 2) * 1.0);
      this.rows = Math.ceil((halfHeight + padding + 2) * 1.0);
      this.words = Math.ceil(this.columns / 32);
      const n = this.rows * this.words;
      if (!this.bits || this.bits.length < n) this.bits = new Uint32Array(n);
      else this.bits.fill(0, 0, n);
    }

    covered(left, top, right, bottom) {
      const x0 = Math.floor((left - this.x) * 0.5);
      const x1 = Math.ceil((right - this.x) * 0.5) - 1;
      const y0 = Math.floor((top - this.y) * 0.5);
      const y1 = Math.ceil((bottom - this.y) * 0.5);
      if (x0 < 0 || x1 >= this.columns || y0 < 0 || y1 > this.rows) return false;
      const w0 = x0 >>> 5, w1 = x1 >>> 5, words = this.words;
      const lo = -1 << (x0 & 31), hi = -1 >>> (31 - (x1 & 31));
      const data = this.bits;
      if (w0 === w1) {
        const mask = lo & hi;
        for (let a = y0 * words + w0, end = y1 * words + w0; a < end; a += words) {
          if ((data[a] & mask) !== mask) return false;
        }
      } else {
        for (let y = y0; y < y1; y++) {
          const a = y * words;
          if ((data[a + w0] & lo) !== lo || (data[a + w1] & hi) !== (hi | 0)) return false;
          for (let w = w0 + 1; w < w1; w++) if (data[a + w] !== 0xffffffff) return false;
        }
      }
      return true;
    }

    paint(left, top, right, bottom) {
      const x0 = Math.max(0, Math.ceil((left - this.x) * 0.5));
      const x1 = Math.min(this.columns, Math.floor((right - this.x) * 0.5)) - 1;
      const y0 = Math.max(0, Math.ceil((top - this.y) * 0.5));
      const y1 = Math.min(this.rows, Math.floor((bottom - this.y) * 0.5));
      if (x0 > x1 || y0 >= y1) return;
      const w0 = x0 >>> 5, w1 = x1 >>> 5, words = this.words;
      const lo = -1 << (x0 & 31), hi = -1 >>> (31 - (x1 & 31));
      const data = this.bits;
      for (let y = y0; y < y1; y++) {
        const a = y * words;
        if (w0 === w1) data[a + w0] |= lo & hi;
        else {
          data[a + w0] |= lo;
          for (let w = w0 + 1; w < w1; w++) data[a + w] = 0xffffffff;
          data[a + w1] |= hi;
        }
      }
    }
  }

  class Swarm {
    reset(capacity, seed) {
      this.capacity = Math.max(1, Math.trunc(capacity));
      this.seed = (seed >>> 0) || 1;
      this.placementSeed = this.seed;
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
      this.spawnRow = new Float32Array(5);
      this.rewardBins = new Float64Array(4 * 256);
      this.feedback = new Float32Array(5 * 4);
      this.rowHead = new Int32Array(ROWS);
      this.rowNext = new Int32Array(size);
      this.bodyIds = new Int32Array(size);
      this.shadowIds = new Int32Array(size);
      this.coverage = new Coverage();
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

    placementRandom() {
      this.placementSeed = (Math.imul(this.placementSeed, 1664525) + 1013904223) >>> 0;
      return this.placementSeed / 4294967296;
    }

    nextSpawn(px, py, initial, hp, baseSpeed) {
      const row = this.spawnRow;
      let x, y;
      if (initial) {
        do {
          x = (2 * this.placementRandom() - 1) * 286;
          y = (2 * this.placementRandom() - 1) * 148;
        } while (x * x + y * y < 46 * 46);
      } else {
        const a = this.placementRandom() * Math.PI * 2;
        x = Math.cos(a) * 286;
        y = Math.sin(a) * 148;
      }
      row[0] = px + x;
      row[1] = py + y;
      row[2] = hp;
      row[3] = baseSpeed * (0.92 + 0.16 * this.placementRandom());
      row[4] = Math.PI * 2 * this.placementRandom();
      return row;
    }

    // The ordinary Godot-node comparison uses exactly the same seeded rows.
    spawnRows(n, px, py, initial, hp, baseSpeed) {
      const rows = new Float32Array(Math.max(0, Math.trunc(n)) * 5);
      for (let offset = 0; offset < rows.length; offset += 5) {
        rows.set(this.nextSpawn(px, py, initial, hp, baseSpeed), offset);
      }
      return rows.buffer;
    }

    fill(targetCount, px, py, initial, hp, baseSpeed) {
      const missing = Math.max(0, Math.min(this.capacity, Math.trunc(targetCount)) - this.aliveCount());
      for (let i = 0; i < missing; i++) {
        const r = this.nextSpawn(px, py, initial, hp, baseSpeed);
        this.spawn(r[0], r[1], r[2], r[3], r[4]);
      }
      return missing;
    }

    clear() {
      const old = this.aliveCount();
      this.live.fill(0);
      this.hp.fill(0);
      this.head.fill(-1);
      this.tail.fill(-1);
      this.cellOf.fill(-1);
      for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
      this.freeCount = this.capacity;
      this.lastUpdated = 0;
      this.drawn = 0;
      this.layerSizes.fill(0);
      this.version++;
      return old;
    }

    auditLiveCount() {
      let count = 0;
      for (let i = 0; i < this.capacity; i++) {
        if (this.live[i] && this.hp[i] > 0) count++;
      }
      return count;
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

    configureAtlas(sheetWidth, sheetHeight, worldWidth, worldHeight, rgba64, shadowWidth, shadowHeight) {
      // Inspect the downloaded game's own texture. Across both walk frames
      // and horizontal mirrors, find a box containing every contributing
      // texel and a rectangle made only of always-opaque texels.
      const pixels = atob(rgba64);
      const width = sheetWidth / 4, height = sheetHeight;
      const heights = new Int32Array(width);
      let x0 = width, x1 = 0, y0 = height, y1 = 0;
      let largest = 0, inner = [0, 0, 0, 0];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let solid = true, visible = false;
          for (let frame = 0; frame < 2; frame++) {
            const row = y * sheetWidth + frame * width;
            const a = pixels.charCodeAt((row + x) * 4 + 3);
            const b = pixels.charCodeAt((row + width - 1 - x) * 4 + 3);
            solid = solid && a === 255 && b === 255;
            visible = visible || a > 0 || b > 0;
          }
          heights[x] = solid ? heights[x] + 1 : 0;
          if (visible) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
          }
        }
        for (let left = 0; left < width; left++) {
          let h = heights[left];
          for (let right = left; right < width && h; right++) {
            h = Math.min(h, heights[right]);
            const area = (right + 1 - left) * h;
            if (area > largest) {
              largest = area;
              inner = [left, y + 1 - h, right + 1, y + 1];
            }
          }
        }
      }
      const sx = worldWidth / width, sy = worldHeight / height;
      const wx = n => (n - width / 2) * sx, wy = n => (n - height / 2) * sy;
      const epsilon = 0.04;
      // Hop ranges from -3 to zero; the outer envelope is the union and the
      // opaque interior is the intersection of all those possible poses.
      this.mask = {
        l: wx(x0) - epsilon, t: wy(y0) - 3 - epsilon,
        r: wx(x1) + epsilon, b: wy(y1) + epsilon,
        il: wx(inner[0]) + epsilon, it: wy(inner[1]) + epsilon,
        ir: wx(inner[2]) - epsilon, ib: wy(inner[3]) - 3 - epsilon,
        sw: shadowWidth / 2 + epsilon, sh: shadowHeight / 2 + epsilon
      };
      if (!largest) this.mask = null;
    }

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

    // The game supplies its actual Johagu aura radius, damage and timing. Each
    // target keeps its own HP and slow. Only cosmetic samples and pickup
    // positions are aggregated for the return trip across WebAssembly.
    pulseAll(cx, cy, amount, slowFactor, slowDuration, critChance, critMultiplier, cheeseChance, ticketChance, reach = 768) {
      // This is a real geometric weapon pulse. Positions beyond the reach of
      // the weapon plus the target's 8-unit hit radius still survive.
      return this.pulse(cx, cy, reach + RADIUS, amount, slowFactor, slowDuration,
        critChance, critMultiplier, cheeseChance, ticketChance, true);
    }

    pulse(cx, cy, r, amount, slowFactor, slowDuration, critChance, critMultiplier, cheeseChance, ticketChance, entireField = false) {
      const left = Math.floor((cx - r) / CELL);
      const top = Math.floor((cy - r) / CELL);
      const right = Math.min(left + MASK, Math.floor((cx + r) / CELL));
      const bottom = Math.min(top + MASK, Math.floor((cy + r) / CELL));
      const radius2 = r * r;
      const tile = 16;
      const bx0 = Math.floor((cx - r) / tile);
      const by0 = Math.floor((cy - r) / tile);
      const cols = Math.floor((cx + r) / tile) - bx0 + 1;
      const rows = Math.floor((cy + r) / tile) - by0 + 1;
      const required = cols * rows * 4;
      if (this.rewardBins.length < required) this.rewardBins = new Float64Array(required);
      else this.rewardBins.fill(0, 0, required);
      const bins = this.rewardBins;
      let hits = 0, kills = 0, effective = 0, raw = 0, crits = 0, samples = 0, binCount = 0;
      let cheeseX = NaN, cheeseY = NaN, ticketX = NaN, ticketY = NaN;
      const visit = id => {
            const x = this.x[id], y = this.y[id];
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy < radius2) {
              const crit = critChance > 0 && this.random() < critChance;
              const damage = crit ? amount * critMultiplier : amount;
              const before = this.hp[id];
              hits++;
              crits += Number(crit);
              effective += Math.min(damage, before);
              raw += damage;
              if (samples < 5) {
                const at = samples++ * 4;
                this.feedback[at] = x;
                this.feedback[at + 1] = y;
                this.feedback[at + 2] = damage;
                this.feedback[at + 3] = Number(crit);
              }
              const after = Math.max(0, before - damage);
              this.hp[id] = after;
              this.flashUntil[id] = this.seconds + 0.08;
              if (after > 0) {
                this.slow(id, slowFactor, slowDuration);
              } else {
                // Large field hits rebuild the spatial index once afterwards.
                if (!entireField) this.unlink(id);
                this.live[id] = 0;
                this.free[this.freeCount++] = id;
                kills++;
                const cell = ((Math.floor(y / tile) - by0) * cols + Math.floor(x / tile) - bx0) * 4;
                if (bins[cell + 2] === 0) binCount++;
                bins[cell] += x;
                bins[cell + 1] += y;
                bins[cell + 2]++;
                if (this.random() < 0.02) bins[cell + 3]++;
                if (cheeseChance > 0 && Number.isNaN(cheeseX) && this.random() < cheeseChance) {
                  cheeseX = x;
                  cheeseY = y;
                } else if (ticketChance > 0 && Number.isNaN(ticketX) && this.random() < ticketChance) {
                  ticketX = x;
                  ticketY = y;
                }
              }
            }
      };
      if (entireField) {
        for (let id = 0; id < this.capacity; id++) if (this.live[id]) visit(id);
        if (kills) {
          this.head.fill(-1);
          this.tail.fill(-1);
          if (this.aliveCount()) {
            for (let id = 0; id < this.capacity; id++) {
              if (this.live[id]) this.link(id, this.bucket(this.x[id], this.y[id]));
            }
          }
        }
      } else {
        for (let bx = left; bx <= right; bx++) {
          for (let by = top; by <= bottom; by++) {
            let id = this.head[(bx & MASK) + (by & MASK) * SIDE];
            while (id !== -1) {
              const next = this.next[id];
              visit(id);
              id = next;
            }
          }
        }
      }
      if (hits) this.version++;
      const out = new Float32Array(11 + (samples + binCount) * 4);
      out.set([hits, kills, effective, raw, crits, cheeseX, cheeseY, ticketX, ticketY, samples, binCount]);
      out.set(this.feedback.subarray(0, samples * 4), 11);
      let at = 11 + samples * 4;
      for (let i = 0; i < required; i += 4) {
        const n = bins[i + 2];
        if (!n) continue;
        out[at++] = bins[i] / n;
        out[at++] = bins[i + 1] / n;
        out[at++] = n;
        out[at++] = bins[i + 3];
      }
      return out.buffer;
    }

    prepareRender(cx, cy, halfWidth, halfHeight, splitY, bodyOffset, margin) {
      this.rowHead.fill(-1);
      const top = cy - halfHeight - margin;
      const height = Math.max(1, 2 * (halfHeight + margin));
      const rowScale = Math.min(1, (ROWS - 1) / height);
      const lastRow = Math.min(ROWS - 1, Math.ceil(height * rowScale));
      this.layerSizes.fill(0);
      let inView = 0;
      for (let i = 0; i < this.capacity; i++) {
        if (!this.live[i] || Math.abs(this.x[i] - cx) > halfWidth + margin ||
            Math.abs(this.y[i] - cy) > halfHeight + margin) continue;
        const row = Math.min(lastRow, Math.max(0, Math.floor((this.y[i] - top) * rowScale)));
        this.rowNext[i] = this.rowHead[row];
        this.rowHead[row] = i;
        this.shadowIds[inView++] = i;
      }
      let bodies = 0;
      const m = this.mask;
      const test = Boolean(m && inView > 1500 && !this.disableOcclusion);
      const cov = this.coverage;
      if (test) cov.begin(cx, cy, halfWidth, halfHeight, margin);
      // Inspect the nearest bodies first. Their opaque interiors form a
      // conservative visibility mask; hidden enemies remain fully simulated.
      for (let row = lastRow; row >= 0; row--) {
        for (let i = this.rowHead[row]; i !== -1; i = this.rowNext[i]) {
          const x = this.x[i], y = this.y[i] + bodyOffset;
          if (test) {
            if (cov.covered(x + m.l, y + m.t, x + m.r, y + m.b)) continue;
            cov.paint(x + m.il, y + m.it, x + m.ir, y + m.ib);
          }
          this.bodyIds[bodies++] = i;
        }
      }
      const shadows = this.layers[0];
      for (let k = 0; k < inView; k++) {
        const i = this.shadowIds[k];
        const x = this.x[i], y = this.y[i];
        if (test && cov.covered(x - m.sw, y - m.sh, x + m.sw, y + m.sh)) continue;
        const j = this.layerSizes[0]++ * SHADOW_STRIDE;
        shadows[j + 3] = x;
        shadows[j + 7] = y;
      }
      // The GPU blends the survivors back to front in the original order.
      for (let k = bodies - 1; k >= 0; k--) {
        const i = this.bodyIds[k];
        const y = this.y[i];
        const layer = y <= splitY ? 1 : 2;
        const index = this.layerSizes[layer]++ * BODY_STRIDE;
        const body = this.layers[layer];
        body[index + 3] = this.x[i];
        body[index + 7] = y + bodyOffset;
        body[index + 8] = this.phase[i];
        body[index + 9] = this.flip[i];
        body[index + 10] = this.flashUntil[i] > this.seconds ? 2 :
          (this.slowUntil[i] > this.seconds ? 1 : 0);
        body[index + 11] = this.born[i];
      }
      this.drawn = bodies;
    }

    layerCount(layer) { return this.layerSizes[layer]; }
    layerBuffer(layer, slots = this.capacity) {
      const stride = layer === 0 ? SHADOW_STRIDE : BODY_STRIDE;
      // Godot 4.7's JavaScriptBridge respects the offset/length of Uint8Array
      // views, while other TypedArray views are expanded to the full buffer.
      return new Uint8Array(this.layers[layer].buffer, 0, slots * stride * 4);
    }
  }

  globalThis.VSCrowd = new Swarm();
})();
