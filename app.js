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
const resources = ["review_scene.tscn", "review_scene.gd", "optimized_game.gd", "crowd_target.gd", "crowd_renderer.gd"];
const element = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const count = [300, 10000, 12000].includes(Number(params.get("count"))) ? Number(params.get("count")) : 10000;
const requestedSeed = Number(params.get("seed"));
const seed = Number.isInteger(requestedSeed) && requestedSeed >= 1 && requestedSeed <= 2147483646 ? requestedSeed : 7;
const mode = params.get("mode") === "original" ? "original" : "optimized";
const config = {mode, count, seed, commit};
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

function urlFor(nextMode = mode, nextCount = count, nextSeed = seed) {
  const url = new URL(location.href);
  url.search = new URLSearchParams({mode: nextMode, count: String(nextCount), seed: String(nextSeed)});
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
  for (const [id, key] of [["alive", "alive"], ["visible-count", "visible"], ["kills", "kills"]]) {
    element(id).textContent = Number.isFinite(data[key]) ? format.format(data[key]) : "—";
  }
  const metrics = recentMetrics();
  element("fps").textContent = metrics.fps == null ? "—" : Math.round(metrics.fps);
  element("p95").textContent = metrics.p95 == null ? "—" : metrics.p95.toFixed(1);
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
  const active = latest?.ready && !document.hidden && !startError;
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

function onSample(json) {
  const data = JSON.parse(json);
  const point = {...data, at: performance.now()};
  latest = point;
  droppedSamples += retain(samples, point, 6000);
  if (!data.ready || lastSamplePhase !== data.phase) {
    lastFrame = null;
    rolling.length = 0;
  }
  lastSamplePhase = data.phase;
  if (data.phase === "spawning") {
    element("status-title").textContent = "전투 준비 중";
    element("status-detail").textContent = format.format(data.alive || 0) + " / " + format.format(count) + "마리 배치";
    element("run-status").textContent = "적 배치 중";
  } else {
    element("cover").hidden = true;
    const labels = {playing: "전투 중", paused: "일시 정지", ended: "전투 종료"};
    element("run-status").textContent = "공원 · 조하구 · " + (labels[data.phase] || "전투 준비 중");
  }
}

window.VSReview = {
  ...config,
  sample: onSample,
  snapshot: () => ({config, ready: !!latest?.ready, sample: latest, frame: recentMetrics(), samples: samples.length, startError}),
  exportMetrics: () => ({config, samples: samples.slice(), frames: frames.slice(), droppedFrames, droppedSamples, startError}),
};
document.addEventListener("visibilitychange", () => { lastFrame = null; rolling.length = 0; });
requestAnimationFrame(animationFrame);

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
    else await element("stage").requestFullscreen();
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
  ]).then(([original, files]) => buildReviewPack(original, files));
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
