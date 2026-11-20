import {buildReviewPack} from "./pack.js?v=mixed-r7";

const build = "mixed-r7";
const commit = "1ca4d9f926535de42690583d28cb931c10e718b8";
const upstream = "https://raw.githubusercontent.com/vtuber-survival/vtuber-survival.github.io/" + commit + "/";
const hashes = {
  "index.pck": "3b5f7d840e13c620f9578e0b012584f4258c0c92e08d64ea298c8990fc58f949",
  "index.wasm": "fc74679e3b97f76878947fcd4fbe1268cbfa6188182a2e33bbc3f5dc9bfa57d0",
  "index.js": "33c94cb3175f3333b82e2a3be5e8e86f77986f0aa2042b1631f6367a4e5bb6ba",
  "index.audio.worklet.js": "5b476a9c9ce642c0ee4256436d1bc31d9c38f868aca0f9a8e2a57c18d2dec2a3",
  "index.audio.position.worklet.js": "be33985bc7160d6bf9646f259cd86b259cd67b02ccb297ee5c44f8ac84327bc8",
};
const element = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const count = [300, 10000, 12000, 100000].includes(Number(params.get("count"))) ? Number(params.get("count")) : 100000;
const requestedSeed = Number(params.get("seed"));
const seed = Number.isInteger(requestedSeed) && requestedSeed >= 1 && requestedSeed <= 2147483646 ? requestedSeed : 7;
const mode = params.get("mode") === "original" ? "original" : "optimized";
const scenario = params.get("scenario") === "normal" ? "normal" : "stress";
const legacyLink = !params.has("preset") && /^100k-r[1-5]$/.test(params.get("v") || "");
const preset = params.get("preset") === "single" || legacyLink ? "single" : "mixed";
const wallFx = params.get("wallfx") === "native" ? "native" : "batch";
const sceneName = scenario === "normal" ? "normal_scene.tscn" : "review_scene.tscn";
const resources = [
  "first_use.gd",
  ...(scenario === "normal" ? ["normal_game.gd", "normal_scene.gd"] : [
    "optimized_game.gd", "crowd_target.gd", "crowd_renderer.gd", "crowd_aura.gd", "stress_aura.gd",
    "hostile_shot_batch.gd", "stock_debug_game.gd", "stress_game.gd", "native_boss.gd", "mixed_roster.gd",
    "wall_sparks.gd", "finish_wave.gd", "review_scene.gd",
  ]),
  sceneName,
];
const config = Object.freeze({mode, count, seed, commit, scenario, build, preset, mixed: preset === "mixed", wallFx});
const samples = [];
const frames = [];
const rolling = [];
const format = new Intl.NumberFormat("ko-KR");
let latest = null;
let lastFrame = null;
let lastPaint = 0;
let startError = "";
let droppedFrames = 0;
let droppedSamples = 0;
let lastSamplePhase = "";
let readyAt = Infinity;
let nextCommandId = 1;
let lastAcknowledged = 0;
const commands = [];
const areaFrames = [];
let lastAnimation = null;
let pendingArea = null;
let repeatRun = null;
let lastRepeat = null;
let lastDetailSample = null;
let catalog = [];
let catalogNames = new Map();
const rosterRows = new Map();
const bossRows = new Map();
const eliteRows = new Map();
const eliteNames = {spam: "도배형", hate: "악플형", backseat: "훈수형", multi: "다계정형", flirt: "추파형"};
const commandLabels = {
  fill: "일반 적 10만 마리 배치", clear: "일반 적 삭제", projectiles: "투사체 500발 추가",
  projectiles10k: "투사체 1만 발 추가",
  clearProjectiles: "투사체 삭제", boss: "보스 소환", pattern: "특수 패턴 발동", nova: "광역기 발동",
  allEnemies: "전 종류 몬스터 배치", bosses10: "보스 10종 소환", patterns10: "10종 동시 패턴",
  sustainShots: "적탄 하한 유지", stopSustain: "적탄 유지 끄기", combinedPeak: "복합 최대 부하 재현", finishWave: "현재 무리 연속 공격",
};
const bossKinds = Array.from(element("boss-kind").options, option => option.value);
const bossNames = new Map(Array.from(element("boss-kind").options, option => [option.value, option.textContent.split(" · ")[0]]));

function queue(action, options = {}, fromRepeat = false) {
  if (!Object.hasOwn(commandLabels, action)) throw new Error("알 수 없는 전투 조작입니다.");
  if (scenario === "normal") throw new Error("디버그 조작은 대규모 전투 화면에서 사용할 수 있습니다.");
  if (repeatRun && !fromRepeat) finishRepeat("다른 조작으로 다음 반복을 중단했습니다.", true);
  if (action === "nova" && pendingArea) return pendingArea.id;
  const command = {id: nextCommandId++, action};
  if (action === "fill") command.count = 100000;
  if (action === "projectiles") command.count = 500;
  if (action === "projectiles10k") command.count = 10000;
  if (action === "allEnemies") command.count = 100000;
  if (action === "sustainShots") {
    const floor = Number(options.count ?? 10000);
    if (floor !== 10000 && floor !== 30000) throw new Error("적탄 하한은 1만 발 또는 3만 발입니다.");
    command.count = floor;
  }
  if (action === "boss" || action === "pattern") {
    const kind = options.kind ?? element("boss-kind").value;
    if (!bossKinds.includes(kind)) throw new Error("지원하지 않는 보스입니다.");
    command.kind = kind;
  }
  if (action === "nova") {
    pendingArea = {id: command.id, queuedAt: performance.now(), ackAt: null, postFrames: 0, maxMs: 0, hidden: document.hidden};
    element("area-attack").disabled = true;
  }
  commands.push(command);
  element("command-status").textContent = commandLabels[action] + " 요청 중…";
  return command.id;
}

function repeatStatus(message) {
  const output = element("repeat-status");
  output.hidden = false;
  setText(output, message);
}

function finishRepeat(message, cancelPending = false) {
  if (!repeatRun) return;
  if (cancelPending) {
    const index = commands.findIndex(command => command.id === repeatRun.id);
    if (index !== -1) {
      const [removed] = commands.splice(index, 1);
      if (pendingArea?.id === removed.id) { pendingArea = null; element("area-attack").disabled = false; }
      setText(element("command-status"), "대기 중인 반복 요청을 취소했습니다.");
    }
  }
  lastRepeat = {results: repeatRun.results.slice(), message};
  repeatRun = null;
  element("repeat-peak").disabled = false;
  element("cancel-repeat").hidden = true;
  repeatStatus(message);
}

function requestPeak() {
  const run = repeatRun;
  run.phase = "peak";
  run.id = queue("combinedPeak", {}, true);
  run.deadline = performance.now() + 90000;
  repeatStatus((run.results.length + 1) + "/2 · 실제 생존 수와 탄막 하한을 확인하는 중");
}

function startRepeat() {
  if (repeatRun) return;
  if (pendingArea || latest?.finishWave?.status === "running") { feedback("진행 중인 공격이 끝나면 다시 누르세요."); return; }
  repeatRun = {phase: "", id: 0, deadline: 0, results: []};
  element("repeat-peak").disabled = true;
  element("cancel-repeat").hidden = false;
  requestPeak();
}

function advanceRepeat(data) {
  const run = repeatRun;
  if (!run || document.hidden) return;
  if (performance.now() > run.deadline) { finishRepeat("반복 중단 · 제한 시간 안에 다음 전투 조건을 확인할 수 없었습니다.", true); return; }
  if (!(data.commandId >= run.id)) return;
  if (run.phase === "peak") {
    const bosses = aliveBosses(data);
    const allTypesSeen = catalog.length > 0 && catalog.every(item => data.speciesSpawned?.[item.id] > 0);
    if (!data.ready || !(data.alive >= 100000) || !bosses || bosses.length < 10 ||
        !(data.hostileProjectiles >= 30000) || !allTypesSeen || pendingArea) return;
    run.peak = {alive: data.alive, distinctBosses: bosses.length, hostileShots: data.hostileProjectiles, speciesSeen: catalog.length};
    run.phase = "nova";
    run.id = queue("nova", {}, true);
    run.deadline = performance.now() + 90000;
    repeatStatus((run.results.length + 1) + "/2 · 광역기 처리 중");
  } else if (data.nova?.id === run.id && !pendingArea) {
    const result = {peak: run.peak, nova: data.nova, frame: areaFrames.findLast(frame => frame.id === run.id) || null};
    run.results.push(result);
    if (run.results.length === 2) {
      const summary = run.results.map((r, i) => (i + 1) + "회 " + format.format(r.nova.kills) + "처치 · 경험치 " + format.format(r.nova.xpAwarded));
      finishRepeat("반복 완료 · " + summary.join(" / "));
    } else requestPeak();
  }
}

function urlFor(nextMode = mode, nextCount = count, nextSeed = seed, nextScenario = scenario, nextPreset = preset) {
  const url = new URL(location.href);
  url.search = new URLSearchParams({v: build, mode: nextMode, count: String(nextCount), seed: String(nextSeed)});
  url.searchParams.set("preset", nextPreset);
  if (nextScenario === "normal") url.searchParams.set("scenario", "normal");
  if (params.has("wallfx")) url.searchParams.set("wallfx", wallFx);
  if (params.get("render") === "sync") url.searchParams.set("render", "sync");
  url.hash = "";
  return url.href;
}

function retain(records, entry, maximum) {
  records.push(entry);
  if (records.length <= maximum) return 0;
  const trim = Math.floor(maximum / 10);
  records.splice(0, trim);
  return trim;
}

function recentMetrics() {
  if (!rolling.length) return {fps: null, p95: null, max: null, n: 0};
  const values = rolling.map(f => f.ms).sort((a, b) => a - b);
  const elapsed = values.reduce((a, b) => a + b, 0);
  return {
    fps: elapsed > 0 ? values.length * 1000 / elapsed : null,
    p95: values[Math.ceil(values.length * .95) - 1],
    max: values[values.length - 1],
    n: values.length,
  };
}

function nonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? format.format(value) : "—";
}

function setText(node, text) {
  const value = String(text);
  if (node.textContent !== value) node.textContent = value;
}

function aliveBosses(data) {
  if (Array.isArray(data.bossKindsAlive)) return [...new Set(data.bossKindsAlive)];
  if (data.bosses === 0) return [];
  return data.bosses === 1 && data.bossKind ? [data.bossKind] : null;
}

function syncRowSet(tableId, rows, ids, values) {
  const body = element(tableId);
  const keep = new Set(ids);
  for (const [key, row] of rows) {
    if (!keep.has(key)) { row.remove(); rows.delete(key); }
  }
  for (const id of ids) {
    let row = rows.get(id);
    if (!row) {
      row = document.createElement("tr");
      const name = document.createElement("th");
      name.scope = "row";
      row.append(name, document.createElement("td"), document.createElement("td"));
      rows.set(id, row);
      body.append(row);
    }
    const columns = values(id);
    columns.forEach((value, i) => setText(row.children[i], value));
  }
}

function showDetails(data, force = false) {
  if (!data || (!force && lastDetailSample === data)) return;
  lastDetailSample = data;
  const counts = data.speciesAlive || {};
  const spawned = data.speciesSpawned || {};
  const ids = catalog.length ? catalog.map(entry => entry.id) : Object.keys(counts);
  const observed = ids.length ? ids : Array.isArray(data.enemyKinds) ? data.enemyKinds : [];
  const present = Number.isFinite(data.speciesPresent) ? data.speciesPresent : data.speciesAlive ? Object.values(counts).filter(n => n > 0).length : observed.length;
  setText(element("species-present"), nonnegative(present));
  setText(element("catalog-count"), catalog.length ? format.format(catalog.length) : "—");
  setText(element("species-summary"), catalog.length ? "생존 " + present + " / " + catalog.length + "종" : "관측 " + present + "종");
  if (element("species-detail").open) {
    syncRowSet("species-rows", rosterRows, observed, id => [
      catalogNames.get(id) || id, nonnegative(data.speciesAlive ? counts[id] ?? 0 : null),
      nonnegative(data.speciesSpawned ? spawned[id] ?? 0 : null),
    ]);
  }
  element("elite-detail").hidden = !data.nativeEliteCounts;
  if (element("species-detail").open && element("elite-detail").open && data.nativeEliteCounts) {
    syncRowSet("elite-rows", eliteRows, Object.keys(eliteNames), id => [
      eliteNames[id], nonnegative(data.nativeEliteCounts[id] ?? 0),
      nonnegative(data.nativeEliteSpawned ? data.nativeEliteSpawned[id] ?? 0 : null),
    ]);
    setText(element("heart-count"), "추파형 하트 · 생존 " + nonnegative(data.heartAlive) +
      " · 누적 " + nonnegative(data.heartSpawned) + " · 플레이어 접촉 " + nonnegative(data.heartContacts));
  }
  const bossIds = aliveBosses(data);
  setText(element("boss-distinct"), bossIds ? format.format(bossIds.length) : "—");
  setText(element("boss-summary"), bossIds ? "생존 " + bossIds.length + "종" : "집계 대기");
  if (element("boss-detail").open) {
    const states = data.bossPatternStates || {};
    const events = data.bossPatternEvents || {};
    syncRowSet("boss-rows", bossRows, bossIds || [], id => {
      const state = states[id] || (id === data.bossKind ? data.bossState : "");
      const detail = data.bossPatternDetails?.[id];
      const effects = detail ? [["탄", detail.shots], ["소환", detail.summons], ["장판", detail.zones], ["전환", detail.transitions]]
        .filter(([, n]) => Number.isFinite(n) && n > 0).map(([name, n]) => name + " " + format.format(n)) : [];
      const label = (bossNames.get(id) || id) + (data.bossCounts?.[id] > 1 ? " ×" + data.bossCounts[id] : "");
      return [label, state === "walk" ? "이동 (walk)" : state || "—", effects.length ? effects.join(" · ") : nonnegative(events[id])];
    });
    element("last-pattern").hidden = !data.lastPattern;
    if (data.lastPattern) setText(element("last-pattern"), "최근 관측 · " + data.lastPattern);
  }
}

function paint() {
  const data = latest || {};
  for (const [id, key] of [
    ["alive", "alive"], ["visible-count", "visible"], ["updated", "updated"], ["projectiles", "projectiles"],
    ["bosses", "bosses"], ["boss-projectiles", "bossProjectiles"], ["zones", "zones"],
    ["nodes", "nodes"], ["kills", "kills"],
  ]) {
    element(id).textContent = Number.isFinite(data[key]) ? format.format(data[key]) : "—";
  }
  for (const [id, key] of [
    ["hostile-total", "hostileProjectiles"], ["manual-shots", "manualProjectiles"], ["shot-floor", "shotFloor"],
    ["player-shots", "playerProjectiles"], ["pattern-events", "patternEvents"],
    ["shot-fired", "manualShotsFired"], ["shot-hits", "manualShotHits"], ["shot-expired", "manualShotExpired"],
    ["shot-cleared", "manualShotCleared"], ["shot-damage", "manualShotHpDamage"], ["shot-blocked", "manualShotBlocked"],
    ["shot-drawn", "manualSubmitted"], ["shot-hidden", "manualHiddenCopies"],
    ["floor-observed-ticks", "shotFloorTicks"],
  ]) setText(element(id), nonnegative(data[key]));
  setText(element("floor-observed-min"), data.shotFloorTicks > 0 ? nonnegative(data.shotFloorMinTick) : "—");
  element("spark-audit-row").hidden = !Number.isFinite(data.wallSparks?.spawned);
  if (Number.isFinite(data.wallSparks?.spawned)) {
    setText(element("spark-totals"), nonnegative(data.wallSparks.spawned) + " / " + nonnegative(data.wallSparks.active));
  }
  const aiShots = Number.isFinite(data.hostileProjectiles) && Number.isFinite(data.manualProjectiles)
    ? data.hostileProjectiles - data.manualProjectiles : null;
  setText(element("ai-shots"), nonnegative(aiShots));
  for (const [id, value] of [["floor-off", 0], ["floor-10000", 10000], ["floor-30000", 30000]]) {
    const control = element(id);
    const active = String(Number.isFinite(data.shotFloor) && data.shotFloor === value);
    if (control.getAttribute("aria-pressed") !== active) control.setAttribute("aria-pressed", active);
  }
  if (latest) showDetails(latest);
  element("drawn-bodies").textContent = Number.isFinite(data.submittedBodies) && data.submittedBodies >= 0 ? format.format(data.submittedBodies) : "—";
  element("crowd-hz").textContent = Number.isFinite(data.crowdDisplayHz) ? Math.round(data.crowdDisplayHz) : "—";
  const metrics = recentMetrics();
  element("fps").textContent = metrics.fps == null ? "—" : Math.round(metrics.fps);
  element("p95").textContent = metrics.p95 == null ? "—" : metrics.p95.toFixed(1);
  element("max-frame").textContent = metrics.max == null ? "—" : metrics.max.toFixed(1);
  const graph = element("plot");
  const ctx = graph.getContext("2d");
  const width = graph.width, height = graph.height;
  ctx.clearRect(0, 0, width, height);
  const ceiling = Math.max(32, Math.min(160, metrics.p95 || 16) * 1.4);
  const y = ms => height - 2 - Math.min(ms / ceiling, 1) * (height - 4);
  ctx.strokeStyle = "#4d5848";
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, y(1000 / 60)); ctx.lineTo(width, y(1000 / 60)); ctx.stroke();
  ctx.setLineDash([]);
  if (!rolling.length) return;
  const end = performance.now();
  ctx.strokeStyle = "#c5e987";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  rolling.forEach(({at, ms}, i) => {
    const x = width * (1 - (end - at) / 5000);
    if (!i) ctx.moveTo(x, y(ms)); else ctx.lineTo(x, y(ms));
  });
  ctx.stroke();
}

function animationFrame(ts) {
  if (pendingArea && !document.hidden) {
    if (lastAnimation !== null && ts > lastAnimation) pendingArea.maxMs = Math.max(pendingArea.maxMs, ts - lastAnimation);
    if (pendingArea.ackAt !== null && ts > pendingArea.ackAt) pendingArea.postFrames++;
    if (pendingArea.postFrames >= 2) {
      const result = {id: pendingArea.id, queuedAt: pendingArea.queuedAt, ackAt: pendingArea.ackAt, maxMs: pendingArea.hidden ? null : pendingArea.maxMs};
      retain(areaFrames, result, 100);
      pendingArea = null;
      element("area-attack").disabled = false;
      showArea(latest?.nova);
    }
  }
  lastAnimation = document.hidden ? null : ts;
  const active = latest?.ready && ts >= readyAt && !document.hidden && !startError;
  if (active && lastFrame !== null && ts > lastFrame) {
    const point = {at: ts, ms: ts - lastFrame};
    droppedFrames += retain(frames, point, 90000);
    rolling.push(point);
    while (rolling.length && rolling[0].at < ts - 5000) rolling.shift();
  }
  lastFrame = active ? ts : null;
  if (ts - lastPaint >= 250) { paint(); lastPaint = ts; }
  requestAnimationFrame(animationFrame);
}

function showArea(nova) {
  if (!nova || !Number.isInteger(nova.id) || nova.id < 1) return;
  element("area-result").hidden = false;
  element("area-kills").textContent = "직전 " + format.format(nova.before) + " · 처치 " + format.format(nova.kills) + " · 남은 적 " + format.format(nova.after);
  element("area-experience").textContent = "적중 " + format.format(nova.hits) + "회 · 피해 " + nonnegative(nova.damage) + " · 발생 경험치 " + format.format(nova.xpAwarded);
  const survivors = nova.survivorsByKind || nova.speciesSurvivors;
  const remaining = survivors && Object.entries(survivors).filter(([, n]) => n > 0).map(([id, n]) => (catalogNames.get(id) || id) + " " + format.format(n));
  element("area-survivors").hidden = !remaining?.length;
  if (remaining?.length) {
    const reasons = nova.survivorReasons || {};
    const notes = [["잠복·비대상", reasons.untargetable], ["벽 피해 제한", reasons.wallDamageCap], ["엘리트 체력", reasons.eliteHP], ["방어", reasons.curlArmor]]
      .filter(([, n]) => Number.isFinite(n) && n > 0).map(([name, n]) => name + " " + format.format(n));
    setText(element("area-survivors"), "생존 · " + remaining.join(", ") + (notes.length ? " (" + notes.join(" · ") + ")" : ""));
  }
  const measured = areaFrames.findLast(entry => entry.id === nova.id);
  const frameLabel = measured
    ? (measured.maxMs === null ? "탭이 숨겨져 프레임 측정 제외" : "최장 프레임 " + measured.maxMs.toFixed(1) + " ms")
    : "다음 프레임 측정 중";
  element("area-timing").textContent = "공격 처리 " + Number(nova.ms).toFixed(1) + " ms · " + frameLabel;
}

function showFinish(result) {
  if (!result || !result.id) return;
  const statuses = {running: "연속 공격 중", complete: "처치 완료", withDepartures: "자연 이탈 포함 종료", timeout: "시간 종료", cancelled: "중단"};
  element("finish-result").hidden = false;
  element("finish-wave").disabled = result.status === "running";
  setText(element("finish-state"), statuses[result.status] || result.status);
  setText(element("finish-cohort"), "처음 " + nonnegative(result.before) + " · 실제 처치 " + nonnegative(result.killed) +
    " · 자연 이탈 " + nonnegative(result.vanished) + " · 남은 적 " + nonnegative(result.remaining));
  setText(element("finish-reward"), "광역기 " + nonnegative(result.casts) + "회 · 발생 경험치 " + nonnegative(result.xpAwarded) +
    (Number.isFinite(result.elapsed) ? " · " + result.elapsed.toFixed(1) + "초" : ""));
  setText(element("finish-arrivals"), "시작 뒤 등장 " + nonnegative(result.newSpawned) + " · 그중 처치 " + nonnegative(result.newKilled));
  const survivors = Object.entries(result.survivorsByKind || {}).filter(([, n]) => n > 0);
  element("finish-survivors").hidden = survivors.length === 0;
  if (survivors.length) setText(element("finish-survivors"), "남은 종류 · " +
    survivors.map(([id, n]) => (catalogNames.get(id) || id) + " " + nonnegative(n)).join(", "));
}

function onSample(json) {
  const data = JSON.parse(json);
  if (Array.isArray(data.speciesCatalog) && data.speciesCatalog.length) {
    const list = data.speciesCatalog;
    if (catalog.length !== list.length || list.some((entry, i) => catalog[i]?.id !== entry.id || catalog[i]?.name !== entry.name)) {
      catalog = list;
      catalogNames = new Map(list.map(entry => [entry.id, entry.name]));
    }
    data.speciesCatalog = catalog;
  }
  const renderer = mode === "optimized" && scenario === "stress" ? globalThis.VSRender?.stats() : null;
  const point = {...data, at: performance.now(), ...(renderer ? {
    crowdDisplayHz: renderer.hz, crowdDisplayFrames: renderer.applied, crowdFrameAgeMs: renderer.ageMs,
    crowdPrepareMs: renderer.workMs, crowdLagMs: renderer.lagMs, crowdPipeline: renderer.mode,
  } : {})};
  if (!data.ready) readyAt = Infinity;
  else if (!latest?.ready || data.phase !== lastSamplePhase) readyAt = point.at;
  latest = point;
  droppedSamples += retain(samples, point, 6000);
  if (!data.ready || lastSamplePhase !== data.phase) {
    lastFrame = null;
    rolling.length = 0;
  }
  lastSamplePhase = data.phase;
  if (data.nova?.id) {
    if (pendingArea?.id === data.nova.id && pendingArea.ackAt === null) pendingArea.ackAt = point.at;
    showArea(data.nova);
  }
  showFinish(data.finishWave);
  advanceRepeat(point);
  element("cover").hidden = true;
  if (data.phase === "spawning") {
    element("run-status").textContent = "일반 적 배치 중 · " + format.format(data.alive || 0) + " / " + format.format(data.target ?? count);
  } else {
    const labels = {playing: "전투 중", paused: "일시 정지", ended: "전투 종료", levelup: "레벨업 선택"};
    element("run-status").textContent = "공원 · 조하구 · " + (data.levelup ? "레벨업 선택" : (labels[data.phase] || "전투 준비 중"));
  }
  if (data.commandId > lastAcknowledged) {
    lastAcknowledged = data.commandId;
    if (lastAcknowledged === nextCommandId - 1) element("command-status").textContent = data.commandMessage || "조작을 적용했습니다.";
  } else if (nextCommandId === 1) {
    element("command-status").textContent = scenario === "normal" ? "원작의 웨이브 진행 중" : (data.phase === "spawning" ? "적을 배치하고 있습니다." : "전투 중에 조작할 수 있습니다.");
  }
}

window.VSReview = {
  ...config,
  config,
  sample: onSample,
  queue,
  takeCommands: () => commands.length ? JSON.stringify(commands.splice(0)) : "[]",
  snapshot: () => ({config, ready: !!latest?.ready, sample: latest, frame: recentMetrics(), render: globalThis.VSRender?.stats(), areaFrame: areaFrames.at(-1) || null, samples: samples.length, startError}),
  exportMetrics: () => ({config, speciesCatalog: catalog, samples: samples.slice(), frames: frames.slice(), areaFrames: areaFrames.slice(), repeat: lastRepeat, droppedFrames, droppedSamples, startError}),
};
document.addEventListener("visibilitychange", () => {
  lastFrame = null; lastAnimation = null; rolling.length = 0;
  if (document.hidden && pendingArea) pendingArea.hidden = true;
});
requestAnimationFrame(animationFrame);

for (const [id, action] of [
  ["fill-enemies", "fill"], ["clear-enemies", "clear"], ["add-projectiles", "projectiles"],
  ["add-projectiles-10k", "projectiles10k"], ["clear-projectiles", "clearProjectiles"],
  ["add-boss", "boss"], ["trigger-pattern", "pattern"], ["area-attack", "nova"],
  ["all-enemies", "allEnemies"], ["spawn-bosses-10", "bosses10"], ["trigger-patterns-10", "patterns10"],
  ["floor-off", "stopSustain"], ["combined-peak", "combinedPeak"], ["finish-wave", "finishWave"],
]) {
  element(id).addEventListener("click", () => {
    queue(action);
    element("game").focus({preventScroll: true});
  });
}

element("normal-play").href = urlFor(mode, count, seed, "normal");
for (const value of [10000, 30000]) element("floor-" + value).addEventListener("click", () => {
  queue("sustainShots", {count: value});
  element("game").focus({preventScroll: true});
});
for (const id of ["species-detail", "boss-detail", "elite-detail"]) element(id).addEventListener("toggle", () => showDetails(latest, true));
element("repeat-peak").addEventListener("click", startRepeat);
element("cancel-repeat").addEventListener("click", () => finishRepeat("사용자가 다음 반복을 중단했습니다.", true));
element("debug-play").href = urlFor(mode, 100000, seed, "stress");
if (scenario === "normal") {
  document.body.classList.add("normal-wave");
  element("normal-play").hidden = true;
  element("debug-play").hidden = false;
  element("initial-population").hidden = true;
  element("initial-preset").hidden = true;
  element("peak-controls").hidden = true;
  element("shot-detail").hidden = true;
  element("scene-title").textContent = "일반 웨이브 플레이";
  element("scene-description").textContent = "공원 4분 50초부터 조하구로 플레이하세요. 레벨업을 직접 선택하고 5분 보스와 싸울 수 있습니다.";
} else if (preset === "single") {
  element("scene-title").textContent = "쪼랭이 단일 전투 디버그";
  element("scene-description").textContent = "공원에서 같은 쪼랭이 배치로 두 구현을 비교하세요. 보스와 탄막은 직접 추가할 수 있습니다.";
  document.querySelector(".single-boss-control").open = true;
}
for (const name of ["original", "optimized"]) {
  const link = element(name);
  link.href = urlFor(name);
  if (name === mode) link.setAttribute("aria-current", "true");
}
element("count").value = String(count);
element("preset").value = preset;
element("preset").addEventListener("change", event => { location.assign(urlFor(mode, count, seed, scenario, event.target.value)); });
element("seed").value = String(seed);
element("retry").href = urlFor();
element("count").addEventListener("change", event => { location.assign(urlFor(mode, Number(event.target.value))); });
element("seed-form").addEventListener("submit", event => {
  event.preventDefault();
  location.assign(urlFor(mode, count, Number(element("seed").value)));
});
let feedbackTimeout;
function feedback(message) {
  element("feedback").textContent = message;
  clearTimeout(feedbackTimeout);
  feedbackTimeout = setTimeout(() => { element("feedback").textContent = ""; }, 2300);
}
element("share").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(urlFor()); feedback("현재 조건의 링크를 복사했습니다."); }
  catch { window.prompt("이 링크를 복사하세요.", urlFor()); }
});
element("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await element("session").requestFullscreen();
    element("game").focus({preventScroll: true});
  } catch { feedback("이 브라우저에서는 전체 화면을 지원하지 않습니다."); }
});

function fail(error) {
  if (startError) return;
  startError = String(error?.message || error);
  element("cover").hidden = false;
  element("cover").classList.add("failed");
  element("status-title").textContent = "게임을 열 수 없습니다";
  element("status-detail").textContent = startError;
  element("run-status").textContent = "실행 오류";
  element("retry").hidden = false;
  console.error("Review launch:", startError);
}

async function verified(bytes, name) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, x => x.toString(16).padStart(2, "0")).join("");
  if (hex !== hashes[name]) throw new Error(name + " 파일이 고정된 배포본과 다릅니다.");
  return bytes;
}

async function fetchBytes(url) {
  const response = await fetch(url, {credentials: "omit", referrerPolicy: "no-referrer"});
  if (!response.ok) throw new Error("게임 파일을 읽을 수 없습니다 (" + response.status + ", " + new URL(url, location.href).pathname.split("/").pop() + ").");
  return new Uint8Array(await response.arrayBuffer());
}
const getOriginal = async name => verified(await fetchBytes(upstream + name), name);
const jsURL = bytes => URL.createObjectURL(new Blob([bytes], {type: "application/javascript"}));
function loadScript(bytes) {
  const url = jsURL(bytes);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => { URL.revokeObjectURL(url); resolve(); };
    script.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Godot 실행기를 읽을 수 없습니다.")); };
    document.head.append(script);
  });
}

async function boot() {
  const probe = document.createElement("canvas");
  const probeContext = probe.getContext("webgl2");
  if (!window.WebAssembly || !window.crypto?.subtle || !probeContext) {
    throw new Error("WebGL 2와 WebAssembly를 지원하는 최신 브라우저에서 열어 주세요.");
  }
  probeContext.getExtension("WEBGL_lose_context")?.loseContext();
  const packedPromise = Promise.all([
    getOriginal("index.pck"),
    Promise.all(resources.map(async name => ({name, content: await fetchBytes("./game/" + name + "?v=" + build)}))),
  ]).then(([original, files]) => buildReviewPack(original, files, "res://review/" + sceneName));
  const [packed, audio, positionAudio] = await Promise.all([
    packedPromise, getOriginal("index.audio.worklet.js"), getOriginal("index.audio.position.worklet.js"),
    getOriginal("index.js").then(loadScript),
  ]);
  const worklets = {
    "godot.audio.worklet.js": jsURL(audio),
    "godot.audio.position.worklet.js": jsURL(positionAudio),
  };
  element("status-detail").textContent = "원작 게임 엔진을 준비하고 있습니다.";
  const engine = new window.Engine({
    executable: "index", canvas: element("game"), canvasResizePolicy: 0, focusCanvas: false,
    locale: "ko_KR", persistentPaths: [], ensureCrossOriginIsolationHeaders: false,
    fileSizes: {[upstream + "index.wasm"]: 39514754},
    onPrint: (...parts) => console.log(...parts),
    onPrintError: (...parts) => {
      const line = parts.join(" ");
      console.error(...parts);
      if (!latest && /Parse Error|Failed to load script|Failed loading scene|Failed to instantiate/i.test(line)) fail(line);
    },
  });
  // The pinned export exposes Emscripten's module callbacks through its configuration.
  // Raw GitHub serves scripts as plain text. Typed blob URLs preserve working audio modules.
  const getModuleConfig = engine.config.getModuleConfig.bind(engine.config);
  engine.config.getModuleConfig = (base, wasmResponse) => {
    const options = getModuleConfig(base, wasmResponse);
    const locateFile = options.locateFile;
    options.locateFile = (name, dir) => worklets[name] || locateFile(name, dir);
    options.instantiateWasm = (imports, success) => {
      wasmResponse.arrayBuffer()
        .then(bytes => verified(bytes, "index.wasm"))
        .then(bytes => WebAssembly.instantiate(bytes, imports))
        .then(result => success(result.instance, result.module))
        .catch(fail);
      return {};
    };
    return options;
  };
  await Promise.all([engine.init(upstream + "index"), engine.preloadFile(packed, "review.pck")]);
  element("status-detail").textContent = "공원 전투 장면을 여는 중입니다.";
  // Cloud's built-in --check mode disables telemetry and save synchronization.
  await engine.start({args: ["--main-pack", "review.pck", "--", "--check"]});
  element("game").focus({preventScroll: true});
}

boot().catch(fail);
