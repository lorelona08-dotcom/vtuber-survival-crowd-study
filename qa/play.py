"""Play the published comparison with real keyboard input and record browser frame times."""

import argparse
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
    const record = { frames: [], longTasks: [], enabled: false, previous: null };
    window.reviewCapture = record;
    function tick(time) {
        if (record.enabled) {
            if (record.previous !== null) record.frames.push(time - record.previous);
            record.previous = time;
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
    config = {"mode": args.mode, "count": args.count, "seed": args.seed}
    if args.build:
        config["v"] = args.build
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
        canvas = page.locator("#game")
        canvas.focus()
        canvas.click(position={"x": 8, "y": 8}, force=True)
        page.wait_for_timeout(900)
        if args.throttle > 1:
            context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": args.throttle})
        begin = page.evaluate("""() => {
            const r = window.reviewCapture;
            r.previous = null; r.enabled = true;
            return {at:performance.now(), sample:window.VSReview.snapshot().sample};
        }""")
        deadline = time.monotonic() + args.seconds
        movements = []
        # The sequence and hold duration are identical for both implementations.
        for step in range(1000):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            key = ("KeyD", "KeyS", "KeyA", "KeyW")[step % 4]
            wall = time.monotonic()
            page.keyboard.down(key)
            page.wait_for_timeout(int(1000 * min(1.3, remaining)))
            page.keyboard.up(key)
            movements.append([key, round(time.monotonic() - wall, 3)])
        end = page.evaluate("""() => {
            const r = window.reviewCapture; r.enabled=false;
            const canvas = document.getElementById('game'), gl = canvas.getContext('webgl2');
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
            const metrics = window.VSReview.exportMetrics();
            return {at:performance.now(), sample:window.VSReview.snapshot().sample,
                samples:metrics.samples, visibility:document.visibilityState, gpu,
                canvas:[canvas.width,canvas.height], frames:r.frames, longTasks:r.longTasks};
        }""")
        samples = [s for s in end["samples"] if begin["at"] <= s["at"] <= end["at"]]
        active = [s for s in samples if s.get("phase") == "playing" and s.get("ready")]
        if not active:
            raise ValueError("No active game samples during recording")
        stats = summarize(end["frames"])
        for field in ("alive", "visible", "updated", "draws", "kills", "damage", "xp", "level", "hp", "x", "y"):
            values = [s[field] for s in active if isinstance(s.get(field), (float, int))]
            if values:
                stats[field + "Range"] = [min(values), max(values)]
        earliest, latest = begin["sample"], end["sample"]
        for field in ("simTime", "ticks", "kills", "damage"):
            if isinstance(latest.get(field), (float, int)) and isinstance(earliest.get(field), (float, int)):
                stats[field + "Delta"] = round(latest[field] - earliest[field], 4)
        stats["playingSamples"] = len(active)
        stats["otherPhases"] = sorted({s.get("phase", "") for s in samples if s not in active})
        stats["timeToReadySeconds"] = round(begin["at"] / 1000, 3)
        result = {
            "url": page.url, "dateUtc": datetime.now(timezone.utc).isoformat(), "browser": browser.version,
            "headed": args.headed, "gpu": end["gpu"], "canvas": end["canvas"], "visibility": end["visibility"],
            "cpuThrottle": args.throttle, "configuration": config, "summary": stats,
            "first": earliest, "last": latest, "input": movements, "samples": samples,
            "millisecondsPerBrowserFrame": end["frames"], "longTasks": end["longTasks"],
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
    parser.add_argument("--count", type=int, choices=(300, 10000, 12000), default=10000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--channel", default="chrome")
    parser.add_argument("--build")
    parser.add_argument("--headed", action="store_true")
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
