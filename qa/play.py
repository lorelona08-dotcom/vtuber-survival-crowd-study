"""Play the published comparison with real keyboard input and record browser frame times."""

import argparse
import bisect
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import sync_playwright


PAGES = "https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/"
RECORD = """
(() => {
    const record = { frames: [], times: [], longTasks: [], crowdIntervals: [], enabled: false,
        previous: null, lastCrowdSequence: null, lastCrowdAt: null, generation: null };
    window.reviewCapture = record;
    function tick(time) {
        if (record.enabled) {
            if (record.previous !== null) {
                record.frames.push(time - record.previous);
                record.times.push(time);
            }
            record.previous = time;
            const renderer = window.VSRender?.stats();
            if (renderer?.bodies > 0 && renderer.applied !== record.lastCrowdSequence) {
                const at = performance.now() - renderer.ageMs;
                if (renderer.generation === record.generation && record.lastCrowdAt !== null) {
                    record.crowdIntervals.push(at - record.lastCrowdAt);
                }
                record.lastCrowdAt = at;
                record.lastCrowdSequence = renderer.applied;
                record.generation = renderer.generation;
            }
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver(list => {
            if (record.enabled) for (const task of list.getEntries()) {
                record.longTasks.push({start: task.startTime, duration: task.duration});
            }
        }).observe({type: 'longtask'});
    }
})();
"""


def summarize(intervals):
    ordered = sorted(intervals)
    if not ordered:
        raise ValueError("The browser did not record animation frames")

    def percentile(fraction):
        return round(ordered[max(0, math.ceil(len(ordered) * fraction) - 1)], 2)

    return {
        "frames": len(ordered), "wallSeconds": round(sum(ordered) / 1000, 3),
        "browserFps": round(len(ordered) * 1000 / sum(ordered), 1),
        "p50ms": percentile(0.5), "p95ms": percentile(0.95), "p99ms": percentile(0.99),
        "maxMs": round(ordered[-1], 2), "over33ms": sum(t > 33.4 for t in ordered),
        "over50ms": sum(t > 50 for t in ordered),
    }


def capture(browser, args, output):
    config = {"mode": args.mode, "count": args.count, "seed": args.seed,
              "scenario": "normal" if args.case == "normal" else "stress"}
    if args.build:
        config["v"] = args.build
    if args.render:
        config["render"] = args.render
    url = args.url.rstrip("/") + "/?" + urlencode(config)
    context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1,
                                  locale="ko-KR", service_workers="block")
    context.add_init_script(RECORD)
    page = context.new_page()
    errors, requests = [], set()
    page.on("pageerror", lambda error: errors.append(str(error)[:500]))
    page.on("console", lambda msg: errors.append(msg.text[:500]) if (
        "SCRIPT ERROR" in msg.text or "Parse Error" in msg.text
    ) else None)
    page.on("response", lambda response: requests.add((urlsplit(response.url).netloc, response.status))
            if response.url.startswith("https:") else None)
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    started = time.monotonic()
    try:
        page.wait_for_function("""() => {
            const s = window.VSReview?.snapshot?.();
            return s?.startError || (s?.sample?.ready && s.sample.phase === 'playing');
        }""", polling=300, timeout=args.timeout * 1000)
        state = page.evaluate("() => window.VSReview.snapshot()")
        if state.get("startError"):
            raise RuntimeError(str(state["startError"]))
        if args.build and (state.get("config") or {}).get("build") != args.build:
            raise ValueError(f"Published release mismatch: {state.get('config')}")
        canvas = page.locator("#game")
        canvas.focus()
        canvas.click(position={"x": 8, "y": 8}, force=True)
        page.wait_for_timeout(900)
        if args.case in ("projectiles", "boss"):
            page.locator("#clear-enemies").click()
            page.wait_for_function("() => window.VSReview.snapshot()?.sample?.alive === 0", timeout=30000)
        boss_kinds = ("daebuntang", "doebaebot", "buffering", "glitch") if args.boss_kind == "all" else (args.boss_kind,)
        if args.case in ("boss", "combined"):
            for index, kind in enumerate(boss_kinds):
                page.locator("#boss-kind").select_option(kind)
                page.locator("#add-boss").click()
                page.wait_for_function("n => window.VSReview.snapshot()?.sample?.bosses >= n",
                                       arg=index + 1, timeout=30000)
        canvas.focus()
        if args.throttle > 1:
            context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": args.throttle})
        begin = page.evaluate("""() => {
            const r = window.reviewCapture;
            r.previous = null; r.enabled = true;
            return {at:performance.now(), sample:window.VSReview.snapshot().sample};
        }""")
        deadline = time.monotonic() + args.seconds
        movements = []
        next_wave = next_pattern = time.monotonic()
        finished_play = False
        # The sequence and hold duration are identical for both implementations.
        for step in range(1000):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if args.case in ("projectiles", "combined") and time.monotonic() >= next_wave:
                for _ in range(args.waves):
                    page.locator("#add-projectiles").evaluate("(button) => button.click()")
                next_wave = time.monotonic() + 3
            if args.case in ("boss", "combined") and time.monotonic() >= next_pattern:
                for kind in boss_kinds:
                    page.locator("#boss-kind").select_option(kind)
                    page.locator("#trigger-pattern").evaluate("(button) => button.click()")
                next_pattern = time.monotonic() + 4
            key = ("KeyD", "KeyS", "KeyA", "KeyW")[step % 4]
            wall = time.monotonic()
            if not args.stationary:
                page.keyboard.down(key)
            if args.case == "normal":
                # A longer kiting route gives regular enemies room to pursue.
                # A 1.3 s square would repeatedly walk into the same pack.
                hold_until = wall + min(7.5, remaining)
                while time.monotonic() < hold_until:
                    page.wait_for_timeout(160)
                    phase = page.evaluate("() => window.VSReview.snapshot()?.sample?.phase")
                    if phase == "ended":
                        finished_play = True
                        break
                    if phase == "levelup":
                        page.keyboard.press("Digit1")
            else:
                page.wait_for_timeout(int(1000 * min(1.3, remaining)))
            if not args.stationary:
                page.keyboard.up(key)
                movements.append([key, round(time.monotonic() - wall, 3)])
            if finished_play:
                break
        end = page.evaluate("""() => {
            const r = window.reviewCapture; r.enabled=false;
            const canvas = document.getElementById('game'), gl = canvas.getContext('webgl2');
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
            const metrics = window.VSReview.exportMetrics();
            return {at:performance.now(), sample:window.VSReview.snapshot().sample,
                samples:metrics.samples, visibility:document.visibilityState, gpu,
                canvas:[canvas.width,canvas.height], frames:r.frames, times:r.times, longTasks:r.longTasks,
                crowdIntervals:r.crowdIntervals};
        }""")
        samples = [s for s in end["samples"] if begin["at"] <= s["at"] <= end["at"]]
        active = [s for s in samples if s.get("phase") == "playing" and s.get("ready")]
        if not active:
            raise ValueError("No active game samples during recording")
        stats = summarize(end["frames"])
        if args.case == "normal":
            boundaries = [begin["at"]] + [s["at"] for s in samples] + [end["at"]]
            phases = [begin["sample"]["phase"]] + [s["phase"] for s in samples] + [end["sample"]["phase"]]
            combat_frames = []
            for at, interval in zip(end["times"], end["frames"]):
                index = max(0, bisect.bisect_right(boundaries, at) - 1)
                if (index + 1 < len(phases) and phases[index] == phases[index + 1] == "playing"
                        and at - interval >= boundaries[0]):
                    combat_frames.append(interval)
            if combat_frames:
                stats["activeCombat"] = summarize(combat_frames)
        for field in ("alive", "visible", "updated", "draws", "kills", "damage", "xp", "level", "hp", "x", "y",
                      "projectiles", "hostileProjectiles", "playerProjectiles", "bosses", "bossProjectiles",
                      "bossPatterns", "bossShotsFired", "manualProjectiles", "zones", "nodes", "gameClock",
                      "hitsTaken", "damageTaken", "submittedBodies", "engineFps", "renderWidth", "renderHeight",
                      "crowdDisplayHz", "crowdFrameAgeMs", "crowdPrepareMs", "crowdLagMs"):
            values = [s[field] for s in active if isinstance(s.get(field), (float, int))]
            if values:
                stats[field + "Range"] = [min(values), max(values)]
        earliest, latest = begin["sample"], end["sample"]
        for field in ("simTime", "ticks", "kills", "damage", "crowdDisplayFrames"):
            if isinstance(latest.get(field), (float, int)) and isinstance(earliest.get(field), (float, int)):
                stats[field + "Delta"] = round(latest[field] - earliest[field], 4)
        stats["simulationWallRatio"] = round(stats.get("simTimeDelta", 0) / stats["wallSeconds"], 3)
        if "crowdDisplayFramesDelta" in stats:
            stats["crowdDisplayHz"] = round(stats["crowdDisplayFramesDelta"] / stats["wallSeconds"], 1)
        if end["crowdIntervals"]:
            actual_crowd = summarize(end["crowdIntervals"])
            actual_crowd["hz"] = actual_crowd.pop("browserFps")
            stats["actualCrowdFrames"] = actual_crowd
        for previous, current in zip(samples, samples[1:]):
            if previous.get("bosses") == 0 and current.get("bosses", 0) > 0:
                frames = [interval for at, interval in zip(end["times"], end["frames"])
                          if at >= previous["at"] and at - interval <= current["at"] + 20]
                if frames:
                    stats["firstBossWindowMaxMs"] = round(max(frames), 2)
                    stats["firstBossName"] = current.get("bossKind")
                break
        stats["playingSamples"] = len(active)
        stats["otherPhases"] = sorted({s.get("phase", "") for s in samples if s.get("phase") != "playing"})
        stats["timeToReadySeconds"] = round(begin["at"] / 1000, 3)
        result = {
            "url": page.url, "dateUtc": datetime.now(timezone.utc).isoformat(), "browser": browser.version,
            "headed": args.headed, "gpu": end["gpu"], "canvas": end["canvas"], "visibility": end["visibility"],
            "loadedBuild": (state.get("config") or {}).get("build"),
            "cpuThrottle": args.throttle, "configuration": config, "case": args.case, "stationary": args.stationary,
            "bossKind": args.boss_kind, "wavesPerBurst": args.waves, "summary": stats,
            "first": earliest, "last": latest, "input": movements, "samples": samples,
            "millisecondsPerBrowserFrame": end["frames"], "frameTimes": end["times"], "longTasks": end["longTasks"],
            "millisecondsPerCrowdImage": end["crowdIntervals"],
            "originsAndStatus": sorted(requests), "scriptErrors": errors,
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        if args.screenshot:
            page.screenshot(path=str(output.with_suffix(".png")), timeout=30000)
        print(json.dumps({"file": str(output), "browser": browser.version, **stats, "errors": errors[:4]}, ensure_ascii=False), flush=True)
    except Exception:
        diagnostic = {"errors": errors[-12:], "elapsedSeconds": round(time.monotonic() - started, 2)}
        try:
            diagnostic["status"] = page.evaluate("""() => ({
                text:document.body.innerText.slice(-1400), sample:window.VSReview?.snapshot?.()?.sample
            })""")
        except Exception:
            pass
        print(json.dumps(diagnostic, ensure_ascii=False), flush=True)
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=PAGES)
    parser.add_argument("--mode", choices=("original", "optimized"), default="optimized")
    parser.add_argument("--count", type=int, choices=(300, 10000, 12000, 100000), default=100000)
    parser.add_argument("--case", choices=("crowd", "projectiles", "boss", "combined", "normal"), default="crowd")
    parser.add_argument("--boss-kind", choices=("daebuntang", "doebaebot", "buffering", "glitch", "all"), default="daebuntang")
    parser.add_argument("--waves", type=int, default=1, choices=(1, 2, 4))
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--channel", default="chrome")
    parser.add_argument("--build")
    parser.add_argument("--render", choices=("sync", "worker"))
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--stationary", action="store_true")
    parser.add_argument("--screenshot", action="store_true")
    parser.add_argument("--throttle", type=float, default=1)
    parser.add_argument("--output", type=Path, default=Path("qa-output/play.json"))
    args = parser.parse_args()
    with sync_playwright() as playwright:
        opts = {"headless": not args.headed, "args": ["--mute-audio", "--disable-background-networking"]}
        if args.channel == "playwright":
            opts["executable_path"] = playwright.chromium.executable_path
        else:
            opts["channel"] = args.channel
        browser = playwright.chromium.launch(**opts)
        try:
            capture(browser, args, args.output)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
