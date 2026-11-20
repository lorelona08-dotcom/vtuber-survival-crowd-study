/* The Park's ordinary enemies share dense storage. Each live slot owns an
 * original species, position, health, velocity and status timers. */
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
  const KIND_KEYS = ["jjorang", "gyeoul", "sodasi", "bee", "frendi", "zzebi", "pochikun", "motaku",
    "swipsaekki", "mimic_s", "sentry", "cookie_s", "bookworm_s", "alien_s", "gaetteok"];
  // Four turns through the roster retain equal long-run weights. The source
  // spawns Motaku four at once; keep its four slots next to each other.
  const ROSTER_ORDER = [];
  for (let turn = 0; turn < 4; turn++) {
    KIND_KEYS.forEach((key, i) => {
      if (key !== "motaku") ROSTER_ORDER.push(i);
      else if (turn === 0) ROSTER_ORDER.push(i, i, i, i);
    });
  }
  const MINIONS = new Set(["mimic_s", "cookie_s", "bookworm_s", "alien_s"]);
  const MOVES = {run: 0, tank: 0, pack: 0, hop: 1, float: 2, zigzag: 3, beat: 4, orbit: 5, lunge: 6};

  // Native pixel snapping and depth order let us keep only one moving
  // 32-row band of body coverage per column. The full mask is kept for shadows.
  class NativeCoverage {
    constructor(pixels, sheetWidth, sheetHeight, baseWidth, baseHeight, scales) {
      const width = sheetWidth / 4;
      const kinds = scales.length;
      const height = sheetHeight / kinds;
      this.valid = scales.every(k => Number.isInteger(k * baseWidth) && Number.isInteger(k * baseHeight) &&
        k * baseWidth <= 32 && k * baseHeight <= 32 && k * baseWidth > 0 && k * baseHeight > 0);
      if (!this.valid) return;
      this.poses = [];
      this.extents = [];
      for (let sprite = 0; sprite < kinds * 2; sprite++) {
        const frame = sprite & 1, kind = sprite >>> 1;
        const worldWidth = baseWidth * scales[kind], worldHeight = baseHeight * scales[kind];
        for (let flip = 0; flip < 2; flip++) {
          const columns = new Int32Array(worldWidth);
          const visible = new Int32Array(worldWidth);
          let partial = false;
          let left = worldWidth, right = 0;
          for (let x = 0; x < worldWidth; x++) {
            const u = (flip ? worldWidth - x - 0.5 : x + 0.5) / worldWidth;
            const sx = Math.min(width - 1, Math.floor(u * width + 0.0001));
            for (let y = 0; y < worldHeight; y++) {
              const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / worldHeight + 0.0001));
              const alpha = pixels.charCodeAt(((sy + kind * height) * sheetWidth + frame * width + sx) * 4 + 3);
              if (alpha > 0) visible[x] |= 1 << y;
              if (alpha !== 0 && alpha !== 255) partial = true;
              if (alpha === 255) columns[x] |= 1 << y;
            }
            if (visible[x]) { left = Math.min(left, x); right = x + 1; }
          }
          let silhouette = 0;
          for (let x = left; x < right; x++) silhouette |= visible[x];
          const firstY = silhouette ? 31 - Math.clz32(silhouette & -silhouette) : 0;
          const lastY = 32 - Math.clz32(silhouette);
          const length = Math.max(0, right - left);
          const bandCount = 33 - (lastY - firstY);
          const solid = new Int32Array(length * bandCount);
          const ink = partial ? new Int32Array(length * bandCount) : solid;
          for (let dy = 0; dy < bandCount; dy++) {
            for (let j = 0; j < length; j++) {
              solid[dy * length + j] = (columns[left + j] >>> firstY) << dy;
              if(partial) ink[dy * length + j] = (visible[left + j] >>> firstY) << dy;
            }
          }
          this.extents.push({kind, scale: scales[kind], top: firstY - worldHeight / 2, bottom: lastY - worldHeight / 2});
          this.poses.push({left, firstY, length, bandCount, solid, ink, halfW: worldWidth / 2, halfH: worldHeight / 2});
        }
      }
    }

    begin(cx, cy, halfWidth, halfHeight, margin, bodyOffset, rowScale, hopping) {
      this.pad = Math.ceil(2 * margin + 16);
      this.left = cx - halfWidth;
      this.top = cy - halfHeight;
      this.width = Math.ceil(2 * halfWidth) + 2 * this.pad + 4;
      this.height = Math.ceil(2 * halfHeight) + 2 * this.pad + 4;
      const len = this.width * (Math.ceil(this.height / 32) + 1);
      if (!this.bits || this.bits.length < len) this.bits = new Int32Array(len);
      else this.bits.fill(0, 0, len);
      if (!this.columns || this.columns.length < this.width) this.columns = new Int32Array(this.width);
      else this.columns.fill(0, 0, this.width);
      let top = Infinity, bottom = -Infinity;
      for (const e of this.extents) {
        top = Math.min(top, bodyOffset * e.scale + e.top - (hopping[e.kind] ? 3 : 0));
        bottom = Math.max(bottom, bodyOffset * e.scale + e.bottom);
      }
      this.topRelative = top;
      this.rolling = Math.ceil(bottom - top + 1 / rowScale) <= 32;
      this.bandTop = -1;
    }

    nextDepthRow(minY) {
      if (!this.rolling) return;
      const top = Math.floor(minY + this.topRelative - this.top + 0.5) + this.pad;
      if (this.bandTop === -1) { this.bandTop = top; return; }
      const shift = this.bandTop - top;
      if (shift === 0) return;
      if (shift < 0) {
        this.flushBand(32);
        this.rolling = false;
        return;
      }
      this.flushBand(Math.min(32, shift));
      this.bandTop = top;
    }

    flushBand(count) {
      // Finalize the bottom pixels that the next, farther depth row cannot
      // cover. The full image bitmap is later used to test every shadow.
      const start = 32 - count, y = this.bandTop + start;
      const shift = y & 31, width = this.width, base = (y >>> 5) * width;
      const bits = this.bits, columns = this.columns;
      const spill = shift + count > 32;
      for (let x = 0; x < width; x++) {
        const old = columns[x], leaving = old >>> start;
        bits[base + x] |= leaving << shift;
        if (spill) bits[base + width + x] |= leaving >>> (32 - shift);
        columns[x] = count === 32 ? 0 : old << count;
      }
    }

    stamp(x, y, frame, flip) {
      const pose = this.poses[2 * frame + flip];
      const px = Math.floor(x - pose.halfW - this.left + 0.5) + this.pad + pose.left;
      const py = Math.floor(y - pose.halfH - this.top + 0.5) + this.pad;
      if (this.rolling) {
        const dy = py + pose.firstY - this.bandTop;
        if (dy >= 0 && dy < pose.bandCount) {
          const columns = this.columns, solid = pose.solid, ink = pose.ink;
          const end = px + pose.length, offset = dy * pose.length - px;
          let j = px;
          while (j < end && !(ink[offset + j] & ~columns[j])) j++;
          if (j === end) return false;
          for (; j < end; j++) columns[j] |= solid[offset + j];
          return true;
        }
        // Other artwork or a nonstandard projection can exceed one band.
        // Keeping the sprite is conservative; it never hides another body.
      }
      return true;
    }

    finish(shadowWidth) {
      if (!this.rolling) return;
      if (this.bandTop !== -1) this.flushBand(32);
      // A horizontal run with the shadow's half-open width can be covered by
      // two overlapping power-of-two intervals. Precompute their bitwise AND.
      const span = 2 ** Math.floor(Math.log2(Math.max(1, Math.floor(shadowWidth))));
      this.span = span;
      const len = this.width * Math.ceil(this.height / 32);
      if (!this.reduceA || this.reduceA.length < len) {
        this.reduceA = new Int32Array(len);
        this.reduceB = new Int32Array(len);
      }
      let src = this.bits;
      let dest = this.reduceA;
      this.shadowMaskHalf = this.bits;
      for (let offset = 1; offset < span; offset *= 2) {
        // Queries stay within the padded image; unused right-edge entries
        // can read into the next band without contributing to a result.
        for (let i = 0; i < len - offset; i++) dest[i] = src[i] & src[i + offset];
        this.shadowMaskHalf = src;
        src = dest;
        dest = dest === this.reduceA ? this.reduceB : this.reduceA;
      }
      this.shadowMask = src;
    }

    coversShadow(x, y, hw, hh) {
      if (!this.rolling) return false;
      const l = Math.floor(x - hw - this.left + 0.5) + this.pad;
      const r = Math.floor(x + hw - this.left + 0.5) + this.pad;
      const top = Math.floor(y - hh - this.top + 0.5) + this.pad;
      const bottom = Math.floor(y + hh - this.top + 0.5) + this.pad - 1;
      const band = top >>> 5, lastBand = bottom >>> 5, w = this.width;
      const lo = -1 << (top & 31), hi = (-1 >>> (31 - (bottom & 31))) | 0;
      const smaller = r - l < this.span;
      const data = smaller ? this.shadowMaskHalf : this.shadowMask;
      const span = smaller ? Math.max(1, this.span / 2) : this.span;
      const first = band * w + l, last = band * w + r - span;
      const common = data[first] & data[last];
      if (band === lastBand) return (common & lo & hi) === (lo & hi);
      return (common & lo) === lo && (data[first + w] & data[last + w] & hi) === hi;
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
      this.kind = new Uint8Array(size);
      this.lungeTime = new Float64Array(size);
      this.lockX = new Float32Array(size);
      this.lockY = new Float32Array(size);
      this.rosterCounter = 0;
      this.packMembers = 0;
      this.mixed = false;
      this.moves = Uint8Array.of(MOVES.hop);
      this.radii = Float32Array.of(RADIUS);
      this.experience = Float32Array.of(1);
      this.resistance = Float32Array.of(1);
      this.renderHop = Uint8Array.of(1);
      this.renderScale = Float32Array.of(1);
      this.admittedKinds = new Float64Array(KIND_KEYS.length);
      this.walls = [];
      this.wallBuckets = null;
      this.maxRadius = RADIUS;
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

    bulkKeys() { return JSON.stringify(KIND_KEYS); }
    activeKeys() { return JSON.stringify(this.mixed ? KIND_KEYS : KIND_KEYS.slice(0, 1)); }
    isMinionSpecies(key) { return MINIONS.has(key); }

    configureRoster(dataJSON, mixed) {
      const source = JSON.parse(dataJSON);
      const keys = mixed ? KIND_KEYS : KIND_KEYS.slice(0, 1);
      this.mixed = !!mixed;
      this.rosterSource = dataJSON;
      this.rosterCounter = 0;
      this.packMembers = 0;
      this.baseHp = Float32Array.from(keys, k => source[k].hp * (MINIONS.has(k) ? 0.4 : 1));
      this.baseSpeed = Float32Array.from(keys, k => source[k].speed);
      this.radii = Float32Array.from(keys, k => source[k].r * (MINIONS.has(k) ? 0.8 : 1));
      this.experience = Float32Array.from(keys, k => MINIONS.has(k) ? 1 : source[k].xp);
      this.resistance = Float32Array.from(keys, k => source[k].move === "tank" ? 0.25 : 1);
      this.moves = Uint8Array.from(keys, k => MOVES[source[k].move]);
      this.renderHop = Uint8Array.from(keys, k => Number(["hop", "beat"].includes(source[k].move)));
      this.renderScale = Float32Array.from(keys, k => MINIONS.has(k) ? 0.75 : 1);
      this.maxRadius = Math.max(...this.radii);
    }

    speciesOf(id) { return KIND_KEYS[this.kind[id]] || ""; }

    composition() {
      const counts = new Uint32Array(KIND_KEYS.length), out = {};
      for (let i = 0; i < this.capacity; i++) if (this.live[i] && this.hp[i] > 0) counts[this.kind[i]]++;
      counts.forEach((n, i) => { if (n) out[KIND_KEYS[i]] = n; });
      return JSON.stringify(out);
    }

    spawnedComposition() {
      const out = {};
      this.admittedKinds.forEach((n, i) => { if (n) out[KIND_KEYS[i]] = n; });
      return JSON.stringify(out);
    }

    setWalls(json) {
      this.walls = JSON.parse(json);
      this.wallBuckets = this.walls.length ? new Array(SIDE * SIDE) : null;
      const margin = this.maxRadius * 0.6;
      for (let i = 0; i < this.walls.length; i++) {
        const [x, y, w, h] = this.walls[i];
        const x0 = Math.floor((x - margin) / CELL), y0 = Math.floor((y - margin) / CELL);
        const x1 = Math.min(x0 + MASK, Math.floor((x + w + margin) / CELL));
        const y1 = Math.min(y0 + MASK, Math.floor((y + h + margin) / CELL));
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const bucket = (cx & MASK) + (cy & MASK) * SIDE;
            if (!this.wallBuckets[bucket]) this.wallBuckets[bucket] = [];
            this.wallBuckets[bucket].push(i);
          }
        }
      }
    }

    pushFromWalls(i, radius, bucket) {
      let list = this.wallBuckets[bucket];
      let last = -1;
      for (let j = 0; list && j < list.length; j++) {
        const wall = list[j];
        if (wall <= last) continue;
        const p = this.walls[wall], x = this.x[i], y = this.y[i];
        const l = p[0] - radius, t = p[1] - radius, r = p[0] + p[2] + radius, b = p[1] + p[3] + radius;
        if (x < l || x >= r || y < t || y >= b) continue;
        const left = x - l, right = r - x, up = y - t, down = b - y;
        const distance = Math.min(left, right, up, down);
        if (distance === left) this.x[i] = l;
        else if (distance === right) this.x[i] = r;
        else if (distance === up) this.y[i] = t;
        else this.y[i] = b;
        last = wall;
        const moved = this.bucket(this.x[i], this.y[i]);
        if (moved !== bucket) { bucket = moved; list = this.wallBuckets[moved]; j = -1; }
      }
      return bucket;
    }

    nextRosterSpawn(kind, px, py, initial) {
      const row = this.nextSpawn(px, py, initial, this.baseHp[kind], this.baseSpeed[kind]);
      if (KIND_KEYS[kind] === "motaku") {
        const previous = ROSTER_ORDER[(this.rosterCounter + ROSTER_ORDER.length - 2) % ROSTER_ORDER.length];
        if (previous !== kind || this.packMembers === 0 || this.packInitial !== initial) {
          this.packX = row[0]; this.packY = row[1];
          this.packMembers = 4;
          this.packInitial = initial;
        }
        const angle = this.placementRandom() * Math.PI * 2;
        const radius = this.placementRandom() * 14;
        row[0] = this.packX + Math.cos(angle) * radius;
        row[1] = this.packY + Math.sin(angle) * radius;
        this.packMembers--;
      }
      return row;
    }

    spawnRosterRows(n, px, py, initial) {
      const rows = new Float32Array(Math.max(0, Math.trunc(n)) * 6);
      for (let offset = 0; offset < rows.length; offset += 6) {
        const kind = this.mixed ? ROSTER_ORDER[this.rosterCounter++ % ROSTER_ORDER.length] : 0;
        rows.set(this.nextRosterSpawn(kind, px, py, initial), offset);
        rows[offset + 5] = kind;
        this.admittedKinds[kind]++;
      }
      return rows.buffer;
    }

    fillRoster(targetCount, px, py, initial) {
      const missing = Math.max(0, Math.min(this.capacity, Math.trunc(targetCount)) - this.aliveCount());
      for (let i = 0; i < missing; i++) {
        const kind = this.mixed ? ROSTER_ORDER[this.rosterCounter++ % ROSTER_ORDER.length] : 0;
        const r = this.nextRosterSpawn(kind, px, py, initial);
        this.spawn(r[0], r[1], r[2], r[3], r[4], kind);
      }
      return missing;
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
        if (this.rosterSource) scratch.configureRoster(this.rosterSource, this.mixed);
        for (let i = 0; i < 5; i++) {
          if (scratch.baseHp) scratch.fillRoster(2048, 0, 0, true);
          else scratch.fill(2048, 0, 0, true, 8, 34);
          scratch.pulse(0, 0, 96, 4, 0.7, 0.5, 0.1, 2, 0, 0);
          scratch.pulseAll(0, 0, 1000, 0.7, 0.5, 0.1, 2, 0.001, 0.001);
        }
        this.warmed = true;
      }
      if (this.rewardBins.length < 5 * 100 * 100) this.rewardBins = new Float64Array(5 * 100 * 100);
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

    spawn(x, y, hp, speed, phase, kind = 0) {
      if (!this.freeCount) return -1;
      const id = this.free[--this.freeCount];
      this.x[id] = x;
      this.y[id] = y;
      this.hp[id] = hp;
      this.speed[id] = speed;
      this.phase[id] = phase;
      this.kind[id] = kind;
      this.admittedKinds[kind]++;
      this.lungeTime[id] = this.lockX[id] = this.lockY[id] = 0;
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

    configureAtlas(sheetWidth, sheetHeight, worldWidth, worldHeight, rgba64, shadowWidth, shadowHeight, hopFlags = "1", scales = "1") {
      const pixels = atob(rgba64);
      this.shadowHalfWidth = shadowWidth / 2 + 0.01;
      this.shadowHalfHeight = shadowHeight / 2 + 0.01;
      this.renderHop = Uint8Array.from(String(hopFlags).split(","), Number);
      this.renderScale = Float32Array.from(String(scales).split(","), Number);
      this.native = new NativeCoverage(pixels, sheetWidth, sheetHeight, worldWidth, worldHeight, this.renderScale);
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
            const minDistance = (this.radii[this.kind[a]] + this.radii[this.kind[b]]) * 0.8;
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

    step(delta, px, py, speedMultiplier, playerHitRadius, gameClock = this.seconds + delta, physicsHz = 0, timeScale = 1) {
      // The Godot Web bridge rounds a floating argument to float32 on this
      // export. Restore its fixed-step ratio so a strict "time > 2.5" charge
      // begins on the same engine tick as the original GDScript.
      const rate = physicsHz > 0 ? physicsHz : Math.round(1 / delta);
      const fixed = (physicsHz > 0 ? timeScale : 1) / rate;
      if (rate > 0 && Number.isFinite(rate) && Math.abs(delta - fixed) < 1e-8) delta = fixed;
      this.separate();
      this.head.fill(-1);
      this.tail.fill(-1);
      const beatScale = 1 + 0.25 * Math.cos((gameClock % 0.9) * (2 * Math.PI / 0.9));
      const orbitNorm = 1 / Math.hypot(0.85, 0.55);
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
          let speed = this.speed[i] * speedMultiplier *
            (slowed ? this.slowFactor[i] : 1);
          const dirX = distance > 0.01 ? dx / distance : 1;
          const dirY = distance > 0.01 ? dy / distance : 0;
          const kind = this.kind[i], phase = this.phase[i];
          const age = this.seconds + delta - this.born[i];
          let vx = dirX, vy = dirY;
          let drift = 0;
          switch (this.moves[kind]) {
            case MOVES.hop: speed *= 1.05; break;
            case MOVES.float:
              drift = Math.sin(age * 2.2 + phase) * 18;
              break;
            case MOVES.zigzag: {
              const sway = Math.sin(age * 5 + phase) * 0.9;
              const norm = 1 / Math.sqrt(1 + sway * sway);
              vx = (dirX - dirY * sway) * norm;
              vy = (dirY + dirX * sway) * norm;
              break;
            }
            case MOVES.beat: speed *= beatScale; break;
            case MOVES.orbit: {
              const side = (Math.trunc(phase * 10) & 1) ? -0.85 : 0.85;
              vx = (0.55 * dirX - side * dirY) * orbitNorm;
              vy = (0.55 * dirY + side * dirX) * orbitNorm;
              break;
            }
            case MOVES.lunge: {
              let time = this.lungeTime[i] + delta;
              if (time > 2.5 && distance < 160) {
                time = -0.45;
                this.lockX[i] = dirX; this.lockY[i] = dirY;
              }
              this.lungeTime[i] = time;
              if (time < 0) { vx = this.lockX[i]; vy = this.lockY[i]; speed *= 3.2; }
              break;
            }
          }
          const kx = this.knockX[i];
          const ky = this.knockY[i];
          this.x[i] += (vx * speed - dirY * drift + kx) * delta;
          this.y[i] += (vy * speed + dirX * drift + ky) * delta;
          if (kx || ky) {
            const length = Math.sqrt(kx * kx + ky * ky);
            const fraction = Math.max(0, 1 - friction / length);
            this.knockX[i] = kx * fraction;
            this.knockY[i] = ky * fraction;
          }
          if (Math.abs(dx) > 2) this.flip[i] = Number((dx < 0) !== (kind === 2)); // Sodasi's art faces left.
          const contactRadius = this.radii[kind] + playerHitRadius;
          if (contact === -1 && d2 < contactRadius * contactRadius) contact = i;
        }
        let bucket = this.bucket(this.x[i], this.y[i]);
        if (this.wallBuckets && d2 <= 520 * 520 && this.wallBuckets[bucket]) {
          bucket = this.pushFromWalls(i, this.radii[this.kind[i]] * 0.6, bucket);
        }
        this.link(i, bucket);
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
      const resistance = this.resistance[this.kind[id]];
      this.knockX[id] += knockX * resistance;
      this.knockY[id] += knockY * resistance;
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

    pulseWeapon(cx, cy, reach, amount, slowFactor, slowDuration, critChance, critMultiplier, cheeseChance, ticketChance) {
      return this.pulse(cx, cy, reach + RADIUS, amount, slowFactor, slowDuration,
        critChance, critMultiplier, cheeseChance, ticketChance);
    }

    pulse(cx, cy, r, amount, slowFactor, slowDuration, critChance, critMultiplier, cheeseChance, ticketChance, entireField = false) {
      const reach = r - RADIUS;
      r = reach + this.maxRadius;
      const left = Math.floor((cx - r) / CELL);
      const top = Math.floor((cy - r) / CELL);
      const right = Math.min(left + MASK, Math.floor((cx + r) / CELL));
      const bottom = Math.min(top + MASK, Math.floor((cy + r) / CELL));
      const tile = 16;
      const bx0 = Math.floor((cx - r) / tile);
      const by0 = Math.floor((cy - r) / tile);
      const cols = Math.floor((cx + r) / tile) - bx0 + 1;
      const rows = Math.floor((cy + r) / tile) - by0 + 1;
      const required = cols * rows * 5;
      if (this.rewardBins.length < required) this.rewardBins = new Float64Array(required);
      else this.rewardBins.fill(0, 0, required);
      const bins = this.rewardBins;
      let hits = 0, kills = 0, effective = 0, raw = 0, crits = 0, samples = 0, binCount = 0;
      let cheeseX = NaN, cheeseY = NaN, ticketX = NaN, ticketY = NaN;
      const visit = id => {
            const x = this.x[id], y = this.y[id];
            const dx = x - cx, dy = y - cy;
            const hitRadius = reach + this.radii[this.kind[id]];
            if (dx * dx + dy * dy < hitRadius * hitRadius) {
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
                const cell = ((Math.floor(y / tile) - by0) * cols + Math.floor(x / tile) - bx0) * 5;
                if (bins[cell + 2] === 0) binCount++;
                bins[cell] += x;
                bins[cell + 1] += y;
                bins[cell + 2]++;
                bins[cell + 4] += this.experience[this.kind[id]];
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
      for (let i = 0; i < required; i += 5) {
        const n = bins[i + 2];
        if (!n) continue;
        out[at++] = bins[i] / n;
        out[at++] = bins[i + 1] / n;
        out[at++] = bins[i + 4];
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
      let mask = !this.disableOcclusion && inView > 1500 && this.native && this.native.valid &&
        Math.abs(pitchX - 1) < 0.0001 && Math.abs(pitchY - 1) < 0.0001 ? this.native : null;
      if (mask) {
        mask.begin(cx, cy, halfWidth, halfHeight, margin, bodyOffset, rowScale, this.renderHop);
        if (!mask.rolling) mask = null;
      }
      this.lastSpacing = mask ? 1 : 0;
      for (let row = ROWS + lastRow; row >= 0; row--) {
        if (row === ROWS - 1) row = lastRow;
        if (mask && this.rowHead[row] !== -1) mask.nextDepthRow(top + (row % ROWS) / rowScale);
        for (let i = this.rowHead[row]; i !== -1; i = this.rowNext[i]) {
          const age = this.seconds - this.born[i];
          const phase = this.phase[i];
          const frame = Math.floor(age * 6 + phase) & 1;
          const t = age * 2.6 + phase;
          const d = Math.abs(t - Math.floor(t) - 0.5);
          // Exact integer rounding of 3*sin(pi*fract(t)) used by the source.
          const kind = this.kind[i];
          const hop = !this.renderHop[kind] || d > 0.4466996209618863 ? 0 : (d > 1 / 3 ? 1 : (d > 0.1864294986773373 ? 2 : 3));
          this.pose[i] = frame | (hop << 1);
          if (mask && !mask.stamp(this.x[i], this.y[i] + bodyOffset * this.renderScale[kind] - hop, kind * 2 + frame, this.flip[i])) continue;
          this.bodyIds[bodies++] = i;
        }
      }
      if (mask) mask.finish(2 * this.shadowHalfWidth);
      const shadows = this.layers[0];
      for (let k = 0; k < inView; k++) {
        const i = this.shadowIds[k];
        const x = this.x[i], y = this.y[i];
        const scale = this.renderScale[this.kind[i]];
        if (mask && mask.coversShadow(x, y, this.shadowHalfWidth * scale, this.shadowHalfHeight * scale)) continue;
        const j = this.layerSizes[0]++ * SHADOW_STRIDE;
        shadows[j] = shadows[j + 5] = scale;
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
        const scale = this.renderScale[this.kind[i]];
        body[index] = body[index + 5] = scale;
        body[index + 3] = this.x[i];
        body[index + 7] = y + bodyOffset * scale - (this.pose[i] >>> 1);
        body[index + 8] = this.kind[i] * 4 + (this.pose[i] & 1);
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
