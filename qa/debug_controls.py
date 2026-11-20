"""Verify the published debug buttons, per-enemy damage, and the frame containing the wipe."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright

from play import PAGES, RECORD, summarize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=PAGES)
    parser.add_argument("--mode", choices=("optimized", "original"), default="optimized")
    parser.add_argument("--count", choices=(300, 10000, 100000), type=int, default=100000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--casts", type=int, default=3)
    parser.add_argument("--only-nova", action="store_true")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--output", type=Path, default=Path("qa-output/debug.json"))
    args = parser.parse_args()
    url = args.url.rstrip("/") + "/?" + urlencode({"mode": args.mode, "count": args.count, "seed": args.seed})
    report = {"url": url, "dateUtc": datetime.now(timezone.utc).isoformat(), "casts": [], "checks": []}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=not args.headed,
                                     args=["--mute-audio", "--disable-background-networking"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ko-KR",
                                  device_scale_factor=1, service_workers="block")
        ctx.add_init_script(RECORD)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:500]))
        page.on("console", lambda m: errors.append(m.text[:500]) if "SCRIPT ERROR" in m.text else None)
        page.set_default_timeout(30000)

        def sample():
            return page.evaluate("() => window.VSReview.snapshot().sample")

        def until(test, value=None, timeout=30000):
            page.wait_for_function(
                "value => {const s=window.VSReview?.snapshot?.()?.sample; return !!s && (" + test + ");}",
                arg=value, timeout=timeout, polling=80)
            return sample()

        def button(button_id):
            page.locator("#" + button_id).click(timeout=45000)

        try:
            report.update({"browser": browser.version, "headed": args.headed})
            page.goto(url, wait_until="domcontentloaded", timeout=75000)
            first = until("s.ready && s.alive === value", args.count, timeout=210000)
            report["first"] = first
            if not args.only_nova:
                button("clear-enemies")
                clear = until("s.phase==='playing' && s.alive===0")
                page.wait_for_timeout(750)
                assert sample()["alive"] == 0
                report["checks"].append({"control": "clear", "sample": clear})
                button("add-projectiles")
                shots = until("s.projectiles >= 150")
                button("clear-projectiles")
                removed = until("s.projectiles === 0")
                report["checks"].append({"control": "projectiles", "observed": shots, "removed": removed})
            for index in range(args.casts):
                if index or not args.only_nova:
                    button("fill-enemies")
                    until("s.ready && s.alive === 100000", timeout=210000)
                # Scroll before the timed event. Let any layout and previous commands settle.
                page.locator("#area-attack").scroll_into_view_if_needed()
                page.wait_for_timeout(350)
                begin = page.evaluate("""() => {
                    const r=window.reviewCapture; r.frames.length=r.times.length=r.longTasks.length=0;
                    r.previous=null; r.enabled=true;
                    return {at:performance.now(),sample:window.VSReview.snapshot().sample};
                }""")
                button("area-attack")
                prior_id = (begin["sample"].get("nova") or {}).get("id", -1)
                nova_sample = until("s.nova && s.nova.id>value && s.nova.before>0 && s.nova.after===0", prior_id, timeout=180000)
                page.wait_for_function("id=>window.VSReview.snapshot().areaFrame?.id===id",
                                       arg=nova_sample["nova"]["id"], timeout=45000)
                page.wait_for_timeout(2100)
                capture = page.evaluate("""() => {
                    const r=window.reviewCapture; r.enabled=false;
                    const state=window.VSReview.snapshot();
                    return {area:state.areaFrame,nova:state.sample.nova,sample:state.sample,
                        frames:r.frames,times:r.times,longTasks:r.longTasks};
                }""")
                nova = capture["nova"]
                assert nova["hits"] == nova["kills"] == nova["before"] and nova["after"] == 0
                assert nova["xpAwarded"] == nova["kills"] and nova["damage"] > 0
                assert capture["sample"]["alive"] == 0
                area = capture["area"]
                around = [d for t, d in zip(capture["times"], capture["frames"])
                          if t >= area["queuedAt"] and t - d <= area["ackAt"] + 40]
                entry = {"before": begin["sample"], "nova": nova, "areaFrame": area,
                         "clickToAckMs": round(area["ackAt"] - area["queuedAt"], 2),
                         "window": summarize(capture["frames"]), "aroundClickFramesMs": around,
                         "afterRewards": capture["sample"], "longTasks": capture["longTasks"]}
                report["casts"].append(entry)
                print(json.dumps({"cast": index + 1, "before": nova["before"], "after": nova["after"],
                                  "kills": nova["kills"], "xp": nova["xpAwarded"], "workMs": nova["ms"],
                                  "eventMaxMs": area["maxMs"], "twoSecondMaxMs": entry["window"]["maxMs"]}), flush=True)
            if not args.only_nova:
                for kind in ("daebuntang", "doebaebot", "buffering", "glitch"):
                    page.locator("#boss-kind").select_option(kind)
                    button("add-boss")
                    boss = until("s.bosses>0 && s.bossKind===value", kind)
                    button("trigger-pattern")
                    triggered = until("s.bossPatterns>value", boss.get("bossPatterns", 0))
                    page.wait_for_timeout(1300)
                    report["checks"].append({"control": "pattern", "kind": kind, "start": triggered, "after": sample()})
            report["scriptErrors"] = errors
            assert not errors, errors[:3]
        finally:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            ctx.close()
            browser.close()


if __name__ == "__main__":
    main()
