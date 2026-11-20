"""Exercise the mixed arena with real browser input against the public Pages release."""

import argparse
import json
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import sync_playwright

from play import PAGES, RECORD, summarize


# Independent inventory from the pinned upstream Data.ENEMIES. Heart uses separate
# setup in enemy.gd. Native bosses can summon additional catalog members.
SPECIES = set("""
bat_s mimic_s sentry junk_pile cookie_wall cookie_s bookworm_s alien_s jjorang
gyeoul kyupok sodasi bee frendi deukdeoji kongchi zzebi ggultteok pochikun
gaetteok motaku chunsik ttakkeumi swipsaekki
""".split())
BOSSES = set("""
doebaebot buffering daebuntang glitch stairs blizzard macaron bookworm bat returnbox
""".split())


def wait_sample(page, predicate, value=None, timeout=60000):
    page.wait_for_function(
        "v => {const s=window.VSReview?.snapshot().sample; return s && (" + predicate + ")}",
        arg=value, polling=90, timeout=timeout)
    return page.evaluate("() => VSReview.snapshot().sample")


def ready_window(page, floor, count):
    return wait_sample(page, """s.ready && s.phase === 'playing' && s.shotFloor === v.floor &&
        s.shotFloorTicks > 0 && s.hostileProjectiles >= v.floor && s.alive >= v.count &&
        v.species.every(k => s.speciesAlive?.[k] > 0) &&
        v.bosses.every(k => Array.isArray(s.bossKindsAlive) ? s.bossKindsAlive.includes(k) : s.bossKindsAlive?.[k] > 0)""",
        {"floor": floor, "count": count, "species": sorted(SPECIES), "bosses": sorted(BOSSES)}, 240000)


def button(page, selector):
    page.locator("#" + selector).click(timeout=90000)


def capture_start(page):
    return page.evaluate("""() => {
        const r=reviewCapture;
        r.frames.length=r.times.length=r.longTasks.length=r.crowdIntervals.length=0;
        r.previous=r.lastCrowdSequence=r.lastCrowdAt=r.generation=null;
        r.enabled=true;
        return {at:performance.now(),sample:VSReview.snapshot().sample};
    }""")


def capture_stop(page, start):
    raw = page.evaluate("""start => {
        const r=reviewCapture; r.enabled=false;
        const at=performance.now(), log=VSReview.exportMetrics();
        return {at, last:VSReview.snapshot().sample,
            samples:log.samples.filter(s => s.at>=start && s.at<=at),
            millisecondsPerBrowserFrame:r.frames, frameTimes:r.times, longTasks:r.longTasks,
            millisecondsPerCrowdImage:r.crowdIntervals, areaFrames:log.areaFrames};
    }""", start["at"])
    raw["first"] = start["sample"]
    raw["durationMs"] = raw["at"] - start["at"]
    return raw


def sample_summary(raw):
    rows = [raw["first"], *raw["samples"], raw["last"]]
    stats = summarize(raw["millisecondsPerBrowserFrame"])
    if raw["millisecondsPerCrowdImage"]:
        crowd = summarize(raw["millisecondsPerCrowdImage"])
        crowd["hz"] = crowd.pop("browserFps")
        stats["actualCrowdFrames"] = crowd
    keys = ("alive", "visible", "submittedBodies", "updated", "bosses", "hostileProjectiles",
            "manualProjectiles", "manualSubmitted", "manualHiddenCopies", "bossProjectiles", "shotFloor", "shotFloorTicks", "shotFloorMinTick",
            "zones", "nativeEffects", "heartAlive", "heartSpawned", "heartContacts", "nodes", "x", "y", "hp")
    for key in keys:
        values = [s[key] for s in rows if isinstance(s.get(key), (int, float))]
        if values:
            stats[key + "Range"] = [min(values), max(values)]
    stats["speciesRange"] = {k: [min(s["speciesAlive"].get(k, 0) for s in rows),
                                  max(s["speciesAlive"].get(k, 0) for s in rows)] for k in sorted(SPECIES)}
    bosses = [Counter(s["bossKindsAlive"]) for s in rows]
    stats["bossKindsRange"] = {k: [min(b[k] for b in bosses), max(b[k] for b in bosses)] for k in sorted(BOSSES)}
    for key in ("ticks", "simTime", "kills", "damage", "bossShotsFired", "manualShotsFired",
                "manualShotHits", "manualShotExpired", "manualShotBlocked", "hitsTaken"):
        if isinstance(rows[0].get(key), (int, float)) and isinstance(rows[-1].get(key), (int, float)):
            stats[key + "Delta"] = round(rows[-1][key] - rows[0][key], 4)
    stats["physicsWallRatio"] = round(stats["simTimeDelta"] / (raw["durationMs"] / 1000), 3)
    elapsed_samples = (rows[-1]["at"] - rows[0]["at"]) / 1000
    if elapsed_samples > 0:
        stats["physicsBetweenSamplesRatio"] = round(stats["simTimeDelta"] / elapsed_samples, 3)
    stats["bossPatternEvidence"] = rows[-1].get("bossPatternDetails", {})
    if rows[-1].get("wallSparks"):
        stats["wallSparksLast"] = rows[-1]["wallSparks"]
    stats["phases"] = sorted({s["phase"] for s in rows})
    stats["sampleCount"] = len(raw["samples"])
    peaks = {}
    for sample in raw["samples"]:
        for key, ms in sample.get("peakMsSinceSample", {}).items():
            peaks[key] = max(peaks.get(key, 0), ms)
    stats["maxGameWorkMs"] = peaks
    return stats


def verify_counters(rows):
    for s in rows:
        assert sum(s["speciesAlive"].get(k, 0) for k in SPECIES) == s["alive"], s["speciesAlive"]
        assert sum(Counter(s["bossKindsAlive"]).values()) == s["bosses"]
        assert s["hostileProjectiles"] >= s["bossProjectiles"] + s["manualProjectiles"]
        if s["mode"] == "optimized":
            spent = sum(s.get(k, 0) for k in ("manualShotHits", "manualShotExpired",
                                              "manualShotBlocked", "manualShotCleared"))
            assert s["manualShotsFired"] == s["manualProjectiles"] + spent


def play_window(page, duration, stationary, floor, require_counts=True):
    start = capture_start(page)
    end = time.monotonic() + duration
    step = 0
    while time.monotonic() < end:
        key = ("KeyD", "KeyS", "KeyA", "KeyW")[step % 4]
        if not stationary:
            page.keyboard.down(key)
        page.wait_for_timeout(max(1, round(1000 * min(1.9, max(0, end - time.monotonic())))))
        if not stationary:
            page.keyboard.up(key)
        step += 1
    raw = capture_stop(page, start)
    stats = sample_summary(raw)
    verify_counters([raw["first"], *raw["samples"], raw["last"]])
    if require_counts:
        assert stats["phases"] == ["playing"] and stats["ticksDelta"] > 0, stats
        assert stats["shotFloorRange"] == [floor, floor] and stats["hostileProjectilesRange"][0] >= floor, stats
        assert stats["shotFloorMinTickRange"][0] >= floor, stats
        assert all(v[0] > 0 for v in stats["bossKindsRange"].values()), stats["bossKindsRange"]
        assert all(sum(stats["bossPatternEvidence"].get(kind, {}).values()) > 0 for kind in BOSSES), stats["bossPatternEvidence"]
    if not stationary:
        assert any(stats[k][0] != stats[k][1] for k in ("xRange", "yRange"))
    return {"summary": stats, "stationary": stationary, **raw}


def cast(page):
    before = page.evaluate("() => VSReview.snapshot().sample")
    prior_id = (before.get("nova") or {}).get("id", -1)
    start = capture_start(page)
    button(page, "area-attack")
    after = wait_sample(page, "s.nova?.id > v", prior_id, timeout=240000)
    nova = after["nova"]
    page.wait_for_function("id => VSReview.snapshot().areaFrame?.id === id", arg=nova["id"], timeout=90000)
    page.wait_for_timeout(600)
    raw = capture_stop(page, start)
    event = next(x for x in raw["areaFrames"] if x["id"] == nova["id"])
    assert nova["kills"] > 0 and nova["damage"] > 0 and nova["xpAwarded"] > 0, nova
    assert nova["hits"] >= nova["kills"] and nova["kills"] + nova["after"] == nova["before"], nova
    assert after["alive"] == nova["after"] and after["target"] == 0, nova
    verify_counters([before, after])
    return {"nova": nova, "areaFrame": event, "atCommand": before, "atResult": after,
            "postCastBrowserFrames": raw["millisecondsPerBrowserFrame"],
            "postCastWindow": summarize(raw["millisecondsPerBrowserFrame"])}


def run(browser, args, report):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1,
                              locale="ko-KR", service_workers="block")
    ctx.add_init_script(RECORD)
    page = ctx.new_page()
    errors, resources = [], set()
    page.on("pageerror", lambda e: errors.append(str(e)[:500]))
    page.on("console", lambda msg: errors.append(msg.text[:500]) if
            "SCRIPT ERROR" in msg.text or "Parse Error" in msg.text or msg.type == "error" else None)
    page.on("response", lambda response: resources.add((urlsplit(response.url).netloc, response.status))
            if response.url.startswith("https:") else None)
    try:
        page.goto(report["url"], wait_until="domcontentloaded", timeout=90000)
        page.wait_for_function("() => window.VSReview?.snapshot().sample?.ready || window.VSReview?.snapshot().startError",
                               timeout=300000, polling=240)
        state = page.evaluate("() => VSReview.snapshot()")
        assert not state.get("startError") and state["config"]["build"] == args.build, state
        # Mixed must start itself, before QA operates any debug control.
        report["autoStart"] = ready_window(page, 10000, args.count)
        verify_counters([report["autoStart"]])
        report["environment"] = page.evaluate("""() => {
          const c=document.getElementById('game'), gl=c.getContext('webgl2');
          const ext=gl?.getExtension('WEBGL_debug_renderer_info');
          return {gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,
            visibility:document.visibilityState, canvas:[c.width,c.height], view:[innerWidth,innerHeight],
            build:VSReview.snapshot().config.build, readyAtMs:performance.now()};
        }""")
        button(page, "trigger-patterns-10")
        if args.floor != 10000:
            button(page, "floor-30000")
        ready_window(page, args.floor, args.count)
        page.locator("#game").focus()
        if args.case == "finish":
            start = capture_start(page)
            button(page, "finish-wave")
            ongoing = wait_sample(page, "s.finishWave?.status === 'running'", timeout=90000)
            ended = wait_sample(page, """s.finishWave?.id === v && s.finishWave.status !== 'running'""",
                                ongoing["finishWave"]["id"], timeout=200000)
            raw = capture_stop(page, start)
            raw["summary"] = sample_summary(raw)
            report["windows"].append(raw)
            finish = report["finish"] = ended["finishWave"]
            assert finish["before"] >= args.count and finish["cohortVerified"] and finish["remaining"] == 0, finish
            assert finish["killed"] + finish["vanished"] == finish["before"] and finish["xpAwarded"] > 0, finish
            assert sum(finish["killedByKind"].values()) == finish["killed"] and finish["casts"] > 1, finish
            verify_counters([ended])
        elif args.case == "cycles":
            for i in range(args.cycles):
                if i:
                    button(page, "fill-enemies")
                    button(page, "spawn-bosses-10")
                    button(page, "trigger-patterns-10")
                    ready_window(page, args.floor, args.count)
                page.locator("#game").focus()
                report["windows"].append(play_window(page, args.seconds, False, args.floor))
                report["casts"].append(cast(page))
            button(page, "clear-projectiles")
            cleared = wait_sample(page, "s.shotFloor === 0 && s.manualProjectiles === 0")
            report["clearedProjectiles"] = cleared
            before = cleared["kills"]
            button(page, "clear-enemies")
            empty = wait_sample(page, "s.phase === 'playing' && s.alive === 0")
            report["clearedEnemies"] = {"beforeKills": before, "after": empty}
            verify_counters([empty])
        else:
            report["windows"].append(play_window(page, args.seconds, args.stationary, args.floor))
        if args.screenshot:
            page.locator("#game").scroll_into_view_if_needed()
            page.screenshot(path=str(args.output.with_suffix(".png")), timeout=30000)
        assert not errors, errors[:4]
    except Exception as error:
        report["error"] = str(error)[:2200]
        try:
            report["diagnostic"] = page.evaluate("() => ({state:window.VSReview?.snapshot(),text:document.body.innerText.slice(-1200)})")
        except Exception:
            pass
        raise
    finally:
        report["errors"] = errors
        report["originsAndStatus"] = sorted(resources)
        ctx.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=PAGES)
    parser.add_argument("--build", default="mixed-r6")
    parser.add_argument("--mode", choices=("optimized", "original"), default="optimized")
    parser.add_argument("--count", choices=(300, 10000, 100000), type=int, default=100000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--case", choices=("play", "cycles", "finish"), default="play")
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--floor", type=int, choices=(10000, 30000), default=10000)
    parser.add_argument("--stationary", action="store_true")
    parser.add_argument("--wall-fx", choices=("native", "batch"))
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--screenshot", action="store_true")
    parser.add_argument("--output", type=Path, default=Path("qa-output/mixed.json"))
    args = parser.parse_args()
    conditions = {"v": args.build, "mode": args.mode, "preset": "mixed", "count": args.count, "seed": args.seed}
    if args.wall_fx:
        conditions["wallfx"] = args.wall_fx
    query = urlencode(conditions)
    report = {"url": args.url.rstrip("/") + "/?" + query, "case": args.case,
              "dateUtc": datetime.now(timezone.utc).isoformat(), "headed": not args.headless,
              "windows": [], "casts": []}
    args.output.parent.mkdir(exist_ok=True, parents=True)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", headless=args.headless,
                                         args=["--mute-audio", "--disable-background-networking"])
            report["browser"] = browser.version
            try:
                run(browser, args, report)
            finally:
                browser.close()
    finally:
        args.output.write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"file": str(args.output), "windows": [w["summary"] for w in report["windows"]],
                      "casts": [e["nova"] for e in report["casts"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
