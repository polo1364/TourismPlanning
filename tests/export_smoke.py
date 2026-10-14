"""Exercise real html2canvas JPG downloads in desktop and phone Chromium.

Run: python tests/export_smoke.py
Requires Python Playwright, Pillow, and a Chromium browser. Only the original
html2canvas CDN URL may reach the network; API calls are mocked or blocked.
"""
from __future__ import annotations

import hashlib
import json
import sys
import threading
import traceback
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

from browser_smoke import Handler, Network, sample_day


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
RENDERER_URL = "https://html2canvas.hertzen.com/dist/html2canvas.min.js"
CACHE = ARTIFACTS / "export-html2canvas-cache.js"


class ExportNetwork(Network):
    def route(self, route):
        if route.request.url == RENDERER_URL:
            return route.continue_()
        return super().route(route)


def itinerary_fixture():
    day = sample_day()
    day['itinerary'][0]['userNote'] = '提前十分鐘到。\n記得帶現金與訂位簡訊。'
    day["itinerary"][0]["address"] = (
        "台北市大同區迪化街一段 123 號，靠近永樂市場與霞海城隍廟，"
        "請由延平北路側步行入口進入。"
        "LongAddressWithoutWhitespaceThatMustWrapInsideItsOwnActivityCard"
    )
    day["itinerary"].append({
        "time": "16:00",
        "type": "SPOT",
        "title": "淡水河畔散步與夕陽",
        "desc": "沿著河岸慢慢散步，在夕陽前抵達休息區。這是今天的最後一站。",
        "address": "台北市大同區民生西路底，大稻埕碼頭河岸步道",
        "cost": "免費",
        "booking": False,
        "tips": "帶一件薄外套，返程前再次確認隨身物品，並保留充足的回程時間。",
        "transit": [{"mode": "步行", "time": "15 分鐘", "desc": "沿民生西路向河岸方向前進。"}],
    })
    return day


def inspect_image(path):
    with Image.open(path) as image:
        image = image.convert("RGB")
        difference = ImageChops.difference(image, Image.new("RGB", image.size, "white"))
        # Ignore small JPEG compression differences in near-white regions.
        mask = difference.convert("L").point(lambda value: 255 if value > 25 else 0)
        counts = mask.histogram()
        bounds = mask.getbbox()
        return {
            "path": str(path),
            "width": image.width,
            "height": image.height,
            "nonwhite_fraction": round(counts[255] / (image.width * image.height), 5),
            "content_bounds": bounds,
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }


def run(browser, base_url):
    report = {"renderer": RENDERER_URL, "checks": [], "captures": [], "failures": []}

    def check(name, condition, details=None):
        report["checks"].append({"name": name, "passed": bool(condition), "details": details})
        if not condition:
            raise AssertionError(f"{name}: {details}")

    for viewport_name, width, height in [("desktop", 1440, 1000), ("phone", 390, 844)]:
        context = browser.new_context(viewport={"width": width, "height": height}, timezone_id="Asia/Taipei", accept_downloads=True)
        network = ExportNetwork()
        context.route("**/*", network.route)
        page = context.new_page()
        errors, dialogs = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
        try:
            page.goto(base_url + "/index.html", wait_until="networkidle", timeout=45000)
            if not page.evaluate("typeof html2canvas === 'function'"):
                if not CACHE.exists():
                    with urlopen(RENDERER_URL, timeout=30) as response:
                        CACHE.write_bytes(response.read())
                page.add_script_tag(path=str(CACHE))
                report.setdefault("renderer_fallback", []).append({
                    "viewport": viewport_name,
                    "cache": str(CACHE),
                    "sha256": hashlib.sha256(CACHE.read_bytes()).hexdigest(),
                })
            check(viewport_name + ": real renderer loaded", page.evaluate("typeof html2canvas === 'function'"))
            page.locator("#city").fill("台北")
            page.locator('#lodgingSection > summary').click()
            page.locator("#hasHotel").uncheck()
            page.evaluate("""async day => {
                tripData = [day];
                generationState = {...generationState, city:'台北', totalDays:1, startDate:new Date(day.date+'T00:00:00')};
                await renderTrip();
                PlannerUI.switchView('itinerary', false);
                const original = window.html2canvas;
                window.__realCaptureCalls = [];
                window.html2canvas = async (element, options) => {
                    const bounds = element.getBoundingClientRect();
                    const overflow = [...element.querySelectorAll('td, .table-tips, .watermark, .table-map-link')].filter(child => {
                        const rect = child.getBoundingClientRect();
                        const cell = child.closest('td')?.getBoundingClientRect();
                        return rect.width && (rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1 || (child.matches('.table-map-link') && cell && rect.right > cell.right + 1));
                    }).map(child => child.className);
                    const canvas = await original(element, options);
                    window.__realCaptureCalls.push({
                        format:element.classList.contains('export-mobile')?'mobile':'a4',
                        sourceWidth:bounds.width, sourceHeight:bounds.height,
                        canvasWidth:canvas.width, canvasHeight:canvas.height,
                        rowCount:element.querySelectorAll('tbody tr').length,
                        routesExpanded:[...element.querySelectorAll('.transit-details')].every(detail=>detail.open),
                        noteText:element.querySelector('.stop-note-text')?.textContent,
                        lastTitle:element.querySelector('tbody tr:last-child .title-cell')?.textContent,
                        overflow
                    });
                    return canvas;
                };
            }""", itinerary_fixture())

            for format_name, function_name, expected_width in [
                ("a4", "exportToA4Image", 1600),
                ("mobile", "exportToMobileImages", 780),
            ]:
                label = viewport_name + ": " + format_name
                before = page.evaluate("Array.from(document.querySelectorAll('#tripContainer details'), d => d.open)")
                with page.expect_download(timeout=60000) as download:
                    page.locator(f"button[onclick='{function_name}()']").click()
                filename = f"export-{format_name}" + ("-phone" if viewport_name == "phone" else "") + ".jpg"
                path = ARTIFACTS / filename
                download.value.save_as(str(path))
                page.wait_for_function("!isBusy", timeout=20000)
                capture = page.evaluate("window.__realCaptureCalls.at(-1)")
                check(label + ' exported routes retain full descriptions', capture['routesExpanded'], capture)
                check(label + ' exported personal notes retain text', capture['noteText'] == '提前十分鐘到。\n記得帶現金與訂位簡訊。', capture)
                image_info = inspect_image(path)
                report["captures"].append({"viewport": viewport_name, "format": format_name, "capture": capture, "image": image_info})
                check(label + " expected JPG width", image_info["width"] == expected_width, image_info)
                check(label + " nonblank rendered content", image_info["nonwhite_fraction"] > 0.015 and image_info["height"] > 500, image_info)
                check(label + " all activities fit the source card", capture["rowCount"] == 3 and not capture["overflow"] and "淡水河畔散步與夕陽" in capture["lastTitle"], capture)
                check(label + " original card state preserved", page.evaluate("Array.from(document.querySelectorAll('#tripContainer details'), d => d.open)") == before)
                check(label + " original controls enabled", page.locator("#tripContainer .btn-modify").is_visible() and page.locator("#tripContainer .btn-modify").is_enabled())
                check(label + " export DOM cleaned", page.locator(".export-host, #tripContainer .paper-mode, #tripContainer .snapshot-mode, #tripContainer .print-mode").count() == 0)
                page.locator("#tripContainer .btn-modify").click()
                check(label + " modification dialog still opens", page.locator("#modifyModal").is_visible())
                page.locator("#modifyModal button[onclick*=closeModal]").click()
            check(viewport_name + ": no paid API requested", not network.ai_requests, len(network.ai_requests))
            check(viewport_name + ": no uncaught errors", not errors, errors)
            report.setdefault("dialogs", {})[viewport_name] = dialogs
        except Exception as error:
            report["failures"].append({"viewport": viewport_name, "error": str(error), "trace": traceback.format_exc(), "page_errors": errors, "dialogs": dialogs})
            page.screenshot(path=str(ARTIFACTS / f"export-failure-{viewport_name}.png"), full_page=True)
        finally:
            context.close()
    report["passed"] = not report["failures"] and all(check["passed"] for check in report["checks"])
    return report


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ARTIFACTS.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            report = run(browser, f"http://127.0.0.1:{server.server_port}")
            browser.close()
        report_path = ARTIFACTS / "export-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "passed": report["passed"],
            "checks": len(report["checks"]),
            "report": str(report_path),
            "images": [capture["image"] for capture in report["captures"]],
            "failures": report["failures"],
        }, ensure_ascii=False, indent=2))
        if not report["passed"]:
            raise SystemExit(1)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
