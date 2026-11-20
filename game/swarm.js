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

  // The native Godot 2D viewport snaps transformed quad vertices to whole
  // pixels. Precompute the opaque pixels the nearest sampler will actually
  // fetch. A four-row coverage hierarchy rejects enclosed spans cheaply.
  class NativeCoverage {
    constructor(pixels, sheetWidth, height, worldWidth, worldHeight) {
      const width = sheetWidth / 4;
      this.valid = Number.isInteger(worldWidth) && Number.isInteger(worldHeight) &&
        worldWidth <= 32 && worldWidth > 0 && worldHeight > 0;
      if (!this.valid) return;
      this.halfW = worldWidth / 2;
      this.halfH = worldHeight / 2;
      this.poses = [];
      for (let frame = 0; frame < 2; frame++) {
        for (let flip = 0; flip < 2; flip++) {
          const nativeRows = [];
          let first = -1, end = 0;
          for (let y = 0; y < worldHeight; y++) {
            const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / worldHeight + 0.0001));
            let mask = 0;
            for (let x = 0; x < worldWidth; x++) {
              const u = (flip ? worldWidth - x - 0.5 : x + 0.5) / worldWidth;
              const sx = Math.min(width - 1, Math.floor(u * width + 0.0001));
              const alpha = pixels.charCodeAt((sy * sheetWidth + frame * width + sx) * 4 + 3);
              if (alpha !== 0 && alpha !== 255) this.valid = false;
              if (alpha === 255) mask |= 1 << x;
            }
            nativeRows.push(mask);
            if (mask) {
              if (first === -1) first = y;
              end = y + 1;
            }
          }
          first = Math.max(0, first);
          const shifts = [];
          for (let s = 0; s < 32; s++) {
            const lo = new Int32Array(end - first);
            const hi = new Int32Array(end - first);
            for (let j = first; j < end; j++) {
              lo[j - first] = nativeRows[j] << s;
              hi[j - first] = s ? nativeRows[j] >>> (32 - s) : 0;
            }
            const layouts = [];
            for (let a = 0; a < 4; a++) {
              const groups = [];
              for (let j = 0; j < lo.length;) {
                const from = j;
                const stop = Math.min(lo.length, j + 4 - ((j + a) & 3));
                let lm = 0, hm = 0;
                while (j < stop) {
                  lm |= lo[j];
                  hm |= hi[j++];
                }
                groups.push({from, stop, lm, hm});
              }
              layouts.push(groups);
            }
            shifts.push({lo, hi, layouts});
          }
          this.poses.push({first, shifts});
        }
      }
    }

    begin(cx, cy, halfWidth, halfHeight, margin) {
      const pad = Math.ceil(2 * margin + 16);
      this.left = cx - halfWidth;
      this.top = cy - halfHeight;
      this.pad = pad;
      this.words = Math.ceil((Math.ceil(2 * halfWidth) + 2 * pad) / 32) + 2;
      const rows = 4 * Math.ceil((Math.ceil(2 * halfHeight) + 2 * pad + 8) / 4);
      const len = rows * this.words;
      if (!this.bits || this.bits.length < len) {
        this.bits = new Uint32Array(len);
        this.blocks = new Uint32Array(len / 4);
      } else {
        this.bits.fill(0, 0, len);
        this.blocks.fill(0, 0, len / 4);
      }
    }

    stamp(x, y, frame, flip) {
      const px = Math.floor(x - this.halfW - this.left + 0.5) + this.pad;
      const pose = this.poses[2 * frame + flip];
      const py = Math.floor(y - this.halfH - this.top + 0.5) + this.pad + pose.first;
      const shape = pose.shifts[px & 31];
      const groups = shape.layouts[py & 3];
      const w = this.words, col = px >>> 5;
      const bits = this.bits, blocks = this.blocks, lo = shape.lo, hi = shape.hi;
      let changed = 0;
      for (let g = 0; g < groups.length; g++) {
        const block = groups[g];
        const row = py + block.from;
        const floor = (row >>> 2) * w + col;
        if (!(block.lm & ~blocks[floor]) && !(block.hm & ~blocks[floor + 1])) continue;
        let dl = 0, dh = 0;
        for (let j = block.from, k = row * w + col; j < block.stop; j++, k += w) {
          const l = lo[j], h = hi[j];
          dl |= l & ~bits[k];
          dh |= h & ~bits[k + 1];
          bits[k] |= l;
          bits[k + 1] |= h;
        }
        const aligned = (row & ~3) * w + col;
        if (dl) blocks[floor] = bits[aligned] & bits[aligned + w] & bits[aligned + 2 * w] & bits[aligned + 3 * w];
        if (dh) blocks[floor + 1] = bits[aligned + 1] & bits[aligned + w + 1] & bits[aligned + 2 * w + 1] & bits[aligned + 3 * w + 1];
        changed |= dl | dh;
      }
      return changed !== 0;
    }

    coversShadow(x, y, hw, hh) {
      const l = Math.floor(x - hw - this.left + 0.5) + this.pad;
      const r = Math.floor(x + hw - this.left + 0.5) + this.pad - 1;
      const t = Math.floor(y - hh - this.top + 0.5) + this.pad;
      const b = Math.floor(y + hh - this.top + 0.5) + this.pad;
      const lw = l >>> 5, rw = r >>> 5, lo = -1 << (l & 31), hi = -1 >>> (31 - (r & 31));
      const mask = lo & hi, bits = this.bits, w = this.words;
      for (let a = t * w, last = b * w; a < last; a += w) {
        if (lw === rw) {
          if ((bits[a + lw] & mask) !== mask) return false;
        } else if ((bits[a + lw] & lo) !== lo || (bits[a + rw] & hi) !== (hi | 0)) {
          return false;
        }
      }
      return true;
    }
  }

  class Swarm {
    reset(capacity, seed) {
      if (globalThis.VSCrowd === this) globalThis.VSRender?.invalidate();
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
      this.rowHead = new Int32Array(2 * ROWS);
      this.rowNext = new Int32Array(size);
      this.bodyIds = new Int32Array(size);
      this.pose = new Uint8Array(size);
      this.shadowIds = new Int32Array(size);
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
      if (globalThis.VSCrowd === this) globalThis.VSRender?.invalidate();
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

    auditSignature() {
      let hash = 2166136261, count = 0;
      for (let i = 0; i < this.capacity; i++) {
        if (!this.live[i] || this.hp[i] <= 0) continue;
        const id = i + 1;
        for (let shift = 0; shift < 32; shift += 8) {
          hash = Math.imul(hash ^ ((id >>> shift) & 255), 16777619);
        }
        count++;
      }
      return count ? (hash >>> 0).toString(16).padStart(8, "0") : "00000000";
    }

    warmCombat() {
      // Exercise the actual combat paths while the page is still loading,
      // isolated from the player's seed, health, drops and audit counters.
      if (!this.warmed) {
        const scratch = new Swarm();
        scratch.reset(2048, 137);
        for (let i = 0; i < 5; i++) {
          scratch.fill(2048, 0, 0, true, 8, 34);
          scratch.pulse(0, 0, 96, 4, 0.7, 0.5, 0.1, 2, 0, 0);
          scratch.pulseAll(0, 0, 1000, 0.7, 0.5, 0.1, 2, 0.001, 0.001);
        }
        this.warmed = true;
      }
      if (this.rewardBins.length < 4 * 100 * 100) this.rewardBins = new Float64Array(4 * 100 * 100);
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
    renderSampleSpacing() { return this.lastSpacing || 0; }
    revision() { return this.version; }
    clock() { return this.seconds; }
    ticks() { return this.totalSteps; }

    configureAtlas(sheetWidth, sheetHeight, worldWidth, worldHeight, rgba64, shadowWidth, shadowHeight) {
      const pixels = atob(rgba64);
      this.shadowHalfWidth = shadowWidth / 2 + 0.01;
      this.shadowHalfHeight = shadowHeight / 2 + 0.01;
      this.native = new NativeCoverage(pixels, sheetWidth, sheetHeight, worldWidth, worldHeight);
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
        if (this.freeCount === this.capacity && globalThis.VSCrowd === this) globalThis.VSRender?.invalidate();
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
      if (kills && this.freeCount === this.capacity && globalThis.VSCrowd === this) globalThis.VSRender?.invalidate();
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

    prepareRender(cx, cy, halfWidth, halfHeight, splitY, bodyOffset, margin, pitchX = 1, pitchY = 1) {
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
        const layer = this.y[i] > splitY ? ROWS : 0;
        const row = layer + Math.min(lastRow, Math.max(0, Math.floor((this.y[i] - top) * rowScale)));
        this.rowNext[i] = this.rowHead[row];
        this.rowHead[row] = i;
        this.shadowIds[inView++] = i;
      }
      let bodies = 0;
      // Exact native-pixel coverage. Other raster scales submit the full
      // view, including all overlaps. The combat index never reads this mask.
      const mask = !this.disableOcclusion && inView > 1500 && this.native && this.native.valid &&
        Math.abs(pitchX - 1) < 0.0001 && Math.abs(pitchY - 1) < 0.0001 ? this.native : null;
      this.lastSpacing = mask ? 1 : 0;
      if (mask) mask.begin(cx, cy, halfWidth, halfHeight, margin);
      for (let row = ROWS + lastRow; row >= 0; row--) {
        if (row === ROWS - 1) row = lastRow;
        for (let i = this.rowHead[row]; i !== -1; i = this.rowNext[i]) {
          const age = this.seconds - this.born[i];
          const phase = this.phase[i];
          const frame = Math.floor(age * 6 + phase) & 1;
          const t = age * 2.6 + phase;
          const d = Math.abs(t - Math.floor(t) - 0.5);
          // Exact integer rounding of 3*sin(pi*fract(t)) used by the source.
          const hop = d > 0.4466996209618863 ? 0 : (d > 1 / 3 ? 1 : (d > 0.1864294986773373 ? 2 : 3));
          this.pose[i] = frame | (hop << 1);
          if (mask && !mask.stamp(this.x[i], this.y[i] + bodyOffset - hop, frame, this.flip[i])) continue;
          this.bodyIds[bodies++] = i;
        }
      }
      const shadows = this.layers[0];
      for (let k = 0; k < inView; k++) {
        const i = this.shadowIds[k];
        const x = this.x[i], y = this.y[i];
        if (mask && mask.coversShadow(x, y, this.shadowHalfWidth, this.shadowHalfHeight)) continue;
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
        body[index + 8] = this.pose[i] & 1;
        body[index + 9] = this.flip[i];
        body[index + 10] = this.flashUntil[i] > this.seconds ? 2 :
          (this.slowUntil[i] > this.seconds ? 1 : 0);
        body[index + 11] = this.pose[i] >>> 1;
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
