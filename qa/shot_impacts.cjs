// Compare both contact-reporting modes at the same positions and in the same order.
const assert = require("node:assert/strict");
require("../game/straight_shots.js");

const pool = globalThis.VSProjectiles;
function collide(firstHitOnly) {
  pool.reset();
  // One grazing survivor and one expired shot exercise compaction and lifetime order.
  pool.spawn(10, 0, 0, 0, 4, 4, 4);
  pool.spawn(0, 0, 0, 0, 4, 0.001, 4);
  for (let i = 0; i < 30000; i++) {
    pool.spawn((i % 11) - 5, (i % 7) - 3, 0, 0, 4, 4, 4);
  }
  const contacts = new Float32Array(pool.step(1 / 60, 0, 0, 1, firstHitOnly));
  return {
    first: Array.from(contacts.subarray(0, 5)), bytes: contacts.byteLength,
    alive: pool.audit(), hits: pool.hits(), expired: pool.expired(), fired: pool.fired(),
    survivor: pool.id[0]
  };
}

const compact = collide(true);
assert.equal(pool.events.byteLength, 0);
const complete = collide(false);
assert.deepEqual({...compact, bytes: complete.bytes}, complete);
assert.deepEqual(compact, {
  first: [-5, -3, 4, 0, 0], bytes: 20,
  alive: 1, hits: 30000, expired: 1, fired: 30002, survivor: 1
});
assert.equal(complete.bytes, 30000 * 5 * 4);

// Rect2 includes left/top and excludes right/bottom. A wall sharing the
// player's position wins, but expiry precedes both and a removed wall is gone.
pool.reset();
pool.setWalls(JSON.stringify([[0, 0, 10, 10], [40, 30, 3, 2]]));
for (const [x, y] of [[0, 0], [9, 9], [10, 0], [0, 10], [40, 30]]) {
  pool.spawn(x, y, 0, 0, 4, 4, 4);
}
pool.spawn(0, 0, 0, 0, 4, 0.001, 4);
pool.step(1 / 60, 0, 0, 1, true);
const impactBytes = pool.wallImpactPositions();
const walls = Array.from(new Float32Array(impactBytes.buffer, 0, impactBytes.byteLength / 4));
assert.deepEqual(walls, [0, 0, 9, 9, 40, 30]);
assert.equal(pool.blocked("manual"), 3);
assert.equal(pool.hits(), 0);
assert.equal(pool.expired(), 1);
assert.equal(pool.audit(), 2);
pool.setWalls([]);
pool.spawn(0, 0, 0, 0, 4, 4, 4);
pool.step(1 / 60, 0, 0, 1, true);
assert.equal(pool.hits(), 1);
assert.equal(pool.wallImpactPositions().byteLength, 0);
assert.equal(pool.fired(), pool.audit() + pool.expired() + pool.blocked() + pool.hits() + pool.cleared());
pool.setWalls([[-32, -32, 32, 32], [1024, 1024, 16, 16]]);
assert.ok(pool.blockedAt(-32, -32) && pool.blockedAt(-0.5, -0.5) && pool.blockedAt(1039, 1039));
assert.ok(!pool.blockedAt(0, 0) && !pool.blockedAt(1040, 1040) && !pool.blockedAt(1, 1));

// Three thousand live shots share 100 snapped cells. The last instance in
// each must occupy its original painter position relative to other cells.
pool.reset();
for (let i = 0; i < 3000; i++) {
  pool.spawn(i % 100 + ((i / 5000) % 1), 5.25, 0, 0, 4, 4, 4);
}
pool.prepareRender(5.2, 3.8, 320, 180, 10.5, true);
assert.equal(pool.audit(), 3000);
assert.equal(pool.layerCount("hate"), 100);
assert.equal(pool.pixelCullCount, 2900);
const visible = new Float32Array(pool.layerBuffer("hate", 100).buffer);
for (let i = 0; i < 100; i++) assert.equal(visible[i * 8 + 3], pool.x[2900 + i]);
pool.prepareRender(5.2, 3.8, 320, 180, 10.5, false);
assert.equal(pool.layerCount("hate"), 3000);
console.log(JSON.stringify({compact, fullContactBytes: complete.bytes, wallImpacts: walls.length / 2, hiddenAtSamePixel: 2900}));
