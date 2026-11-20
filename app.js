import {buildReviewPack} from "./pack.js";

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
const sceneName = scenario === "normal" ? "normal_scene.tscn" : "review_scene.tscn";
const resources = [
  "optimized_game.gd", "crowd_target.gd", "crowd_renderer.gd", "crowd_aura.gd", "stress_aura.gd",
  ...(scenario === "normal" ? ["normal_game.gd", "normal_scene.gd"] : ["stock_debug_game.gd", "review_scene.gd"]),
  sceneName,
];
const config = {mode, count, seed, commit, scenario};
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
const commandLabels = {
  fill: "일반 적 10만 마리 배치", clear: "일반 적 삭제", projectiles: "투사체 추가",
  clearProjectiles: "투사체 삭제", boss: "보스 소환", pattern: "특수 패턴 발동", nova: "광역기 발동",
};
const bossKinds = Array.from(element("boss-kind").options, option => option.value);

function queue(action, options = {}) {
  if (!Object.hasOwn(commandLabels, action)) throw new Error("알 수 없는 전투 조작입니다.");
  if (scenario === "normal") throw new Error("디버그 조작은 대규모 전투 화면에서 사용할 수 있습니다.");
  if (action === "nova" && pendingArea) return pendingArea.id;
  const command = {id: nextCommandId++, action};
  if (action === "fill") command.count = 100000;
  if (action === "projectiles") command.count = 500;
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

function urlFor(nextMode = mode, nextCount = count, nextSeed = seed, nextScenario = scenario) {
  const url = new URL(location.href);
  url.search = new URLSearchParams({mode: nextMode, count: String(nextCount), seed: String(nextSeed)});
  if (nextScenario === "normal") url.searchParams.set("scenario", "normal");
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

function paint() {
  const data = latest || {};
  for (const [id, key] of [
    ["alive", "alive"], ["visible-count", "visible"], ["updated", "updated"], ["projectiles", "projectiles"],
    ["bosses", "bosses"], ["boss-projectiles", "bossProjectiles"], ["zones", "zones"],
    ["nodes", "nodes"], ["kills", "kills"],
  ]) {
    element(id).textContent = Number.isFinite(data[key]) ? format.format(data[key]) : "—";
  }
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
  element("area-experience").textContent = "적중 " + format.format(nova.hits) + "회 · 발생 경험치 " + format.format(nova.xpAwarded);
  const measured = areaFrames.findLast(entry => entry.id === nova.id);
  const frameLabel = measured
    ? (measured.maxMs === null ? "탭이 숨겨져 프레임 측정 제외" : "최장 프레임 " + measured.maxMs.toFixed(1) + " ms")
    : "다음 프레임 측정 중";
  element("area-timing").textContent = "공격 처리 " + Number(nova.ms).toFixed(1) + " ms · " + frameLabel;
}

function onSample(json) {
  const data = JSON.parse(json);
  const point = {...data, at: performance.now()};
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
  sample: onSample,
  queue,
  takeCommands: () => commands.length ? JSON.stringify(commands.splice(0)) : "[]",
  snapshot: () => ({config, ready: !!latest?.ready, sample: latest, frame: recentMetrics(), areaFrame: areaFrames.at(-1) || null, samples: samples.length, startError}),
  exportMetrics: () => ({config, samples: samples.slice(), frames: frames.slice(), areaFrames: areaFrames.slice(), droppedFrames, droppedSamples, startError}),
};
document.addEventListener("visibilitychange", () => {
  lastFrame = null; lastAnimation = null; rolling.length = 0;
  if (document.hidden && pendingArea) pendingArea.hidden = true;
});
requestAnimationFrame(animationFrame);

for (const [id, action] of [
  ["fill-enemies", "fill"], ["clear-enemies", "clear"], ["add-projectiles", "projectiles"],
  ["clear-projectiles", "clearProjectiles"], ["add-boss", "boss"], ["trigger-pattern", "pattern"], ["area-attack", "nova"],
]) {
  element(id).addEventListener("click", () => {
    queue(action);
    element("game").focus({preventScroll: true});
  });
}

element("normal-play").href = urlFor(mode, count, seed, "normal");
element("debug-play").href = urlFor(mode, 100000, seed, "stress");
if (scenario === "normal") {
  document.body.classList.add("normal-wave");
  element("normal-play").hidden = true;
  element("debug-play").hidden = false;
  element("initial-population").hidden = true;
  element("scene-title").textContent = "일반 웨이브 플레이";
  element("scene-description").textContent = "공원 4분 50초부터 조하구로 플레이하세요. 레벨업을 직접 선택하고 5분 보스와 싸울 수 있습니다.";
}
for (const name of ["original", "optimized"]) {
  const link = element(name);
  link.href = urlFor(name);
  if (name === mode) link.setAttribute("aria-current", "true");
}
element("count").value = String(count);
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
    Promise.all(resources.map(async name => ({name, content: await fetchBytes("./game/" + name)}))),
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
