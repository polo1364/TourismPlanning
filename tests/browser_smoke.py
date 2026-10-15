"""Deterministic Chromium checks; all non-loopback requests are mocked or blocked.

Run: python tests/browser_smoke.py --mode baseline
     python tests/browser_smoke.py --mode smoke
Requires Python Playwright and its Chromium browser.
"""
from __future__ import annotations

import argparse
import json
import threading
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
START = "2026-11-10"
END = "2026-11-11"


def sample_day(date=START, title="台北散步與在地風味", modified=False):
    return {
        "date": date,
        "day_title": "微調後的輕鬆旅程" if modified else title,
        "summary": "沿著老城街區，走訪文化與美食。",
        "itinerary": [
            {"time": "09:00", "type": "SPOT", "title": "微調後景點" if modified else "大稻埕街區", "desc": "漫步老街，觀察紅磚建築，安排充足的休息時間。", "address": "台北市大同區迪化街", "cost": "免費", "booking": False, "tips": "建議穿著好走的鞋。", "transit": [{"mode": "捷運與步行", "time": "20 分鐘", "desc": "搭乘捷運至北門站，再沿街步行。"}]},
            {"time": "12:00", "type": "FOOD", "title": "在地小吃午餐", "desc": "選擇一間在地餐館，體驗街區的日常風味。", "address": "台北市大同區", "cost": "NT$250", "booking": False, "tips": "避開尖峰用餐時段。", "transit": []},
        ],
    }


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/baseline.html":
            backups = sorted(ROOT.glob("index.html.bak.*"))
            body = (backups[0] if backups else ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *_):
        pass


class Network:
    def __init__(self):
        self.ai_requests = []
        self.blocked = set()
        self.fail_ai = False
        self.result_override = None
        self.hold_ai = False
        self.pending = []

    def release_ai(self):
        pending, self.pending = self.pending, []
        for route, payload in pending:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

    def route(self, route):
        request = route.request
        host = urlparse(request.url).hostname
        if host in {"127.0.0.1", "localhost"}:
            return route.continue_()
        if host in {"api.deepseek.com", "generativelanguage.googleapis.com"}:
            body = request.post_data_json
            self.ai_requests.append(body)
            if self.fail_ai:
                return route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"message": "Mocked unavailable service"}}))
            prompt = body["messages"][-1]["content"] if "messages" in body else body["contents"][0]["parts"][0]["text"]
            if self.result_override is not None:
                result = self.result_override
            elif "必去景點與必吃美食" in prompt:
                result = {"spots": ["測試推薦景點一", "測試推薦景點二"], "food": ["測試推薦餐點"]}
            else:
                result = sample_day(END if "第 2 天" in prompt else START, modified="微調" in prompt)
            content = json.dumps(result, ensure_ascii=False)
            payload = {"choices": [{"finish_reason": "stop", "message": {"content": content}}]} if "messages" in body else {"candidates": [{"content": {"parts": [{"text": content}]}}]}
            if self.hold_ai:
                self.pending.append((route, payload))
                return
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
        if host == "geocoding-api.open-meteo.com":
            return route.fulfill(status=200, content_type="application/json", body='{"results":[{"name":"Taipei","country_code":"TW","latitude":25.03,"longitude":121.56}]}')
        if host == "api.open-meteo.com":
            payload = {"daily": {"time": [START, END], "weather_code": [1, 2], "temperature_2m_max": [24, 23], "temperature_2m_min": [19, 18]}}
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
        if host and ("exchangerate" in host or "frankfurter" in host):
            return route.fulfill(status=200, content_type="application/json", body='{"rates":{"TWD":0.22},"conversion_rates":{"TWD":0.22}}')
        self.blocked.add(request.url)
        return route.abort()


def overflow(page):
    return page.evaluate("({ viewport: innerWidth, width: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 })")


def workspace_view(page, name):
    if page.locator('.workspace-tabs').is_visible():
        page.locator(f'#{name}Tab').click()


def open_optional_settings(page):
    workspace_view(page, 'settings')
    for section in ['lodgingSection', 'preferencesSection']:
        if not page.locator('#'+section).evaluate('el => el.open'):
            page.locator('#'+section+' > summary').click()


def setup_page(browser, url, width, height, with_key=True):
    context = browser.new_context(viewport={"width": width, "height": height}, timezone_id="Asia/Taipei", accept_downloads=True)
    # These data regressions use continuous reading; book_smoke tests paged reading.
    context.add_init_script("localStorage.setItem('roamReadingMode','continuous')")
    network = Network()
    context.route("**/*", network.route)
    if with_key:
        context.add_init_script("localStorage.setItem('geminiApiKey', 'mock-not-a-real-key'); sessionStorage.setItem('deepseekApiKey', 'mock-not-a-real-key');")
    page = context.new_page()
    errors = []
    dialogs = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
    page.goto(url, wait_until="networkidle")
    return context, page, network, errors, dialogs


def baseline(browser, base_url):
    report = {"mode": "baseline", "screenshots": [], "expected_defects": {}, "viewports": {}}
    for name, width, height in [("desktop", 1440, 1000), ("mobile", 390, 844)]:
        context, page, network, errors, dialogs = setup_page(browser, base_url + "/baseline.html", width, height)
        page.locator("#city").fill("台北")
        page.locator("#flightArrival").fill(START + "T18:00")
        page.locator("#flightDeparture").fill(END + "T09:00")
        page.locator("#hasHotel").uncheck()
        path = ARTIFACTS / f"baseline-{name}.png"
        page.screenshot(path=str(path), full_page=True, animations="disabled")
        report["screenshots"].append(str(path))
        if name == "desktop":
            report["expected_defects"] = page.evaluate("""() => ({
                missingFormatter: typeof formatAIOutput === 'undefined',
                omittedPreferences: !generateSingleDayPrompt({spots:'SPOT_MARKER', foodList:'FOOD_MARKER', combinedPrefs:'PREF_MARKER'}).includes('PREF_MARKER'),
                commaCost: calculateTotalCost({itinerary:[{cost:'1,500円'}]}).amount,
                decimalCost: calculateTotalCost({itinerary:[{cost:'12.50 USD'}]}).amount,
                overnightDays: Math.floor((new Date('2026-11-11T09:00')-new Date('2026-11-10T18:00'))/86400000)+1
            })""")
        page.evaluate("async day => { tripData = [day]; await renderTrip(); }", sample_day())
        path = ARTIFACTS / f"baseline-trip-{name}.png"
        page.screenshot(path=str(path), full_page=True, animations="disabled")
        report["screenshots"].append(str(path))
        report["viewports"][name] = overflow(page)
        if name == "desktop":
            page.evaluate("async () => {tripData[0].itinerary[0].title = 'MODIFIED_MARKER'; await renderTrip();}")
            report["expected_defects"]["modificationNotRendered"] = page.locator("#tripContainer").get_by_text("MODIFIED_MARKER", exact=True).count() == 0
        report.setdefault("page_errors", {})[name] = errors
        context.close()
    return report


def smoke(browser, base_url):
    report = {"mode": "smoke", "screenshots": [], "viewports": {}, "checks": [], "failures": []}

    def check(name, condition, details=None):
        report["checks"].append({"name": name, "passed": bool(condition), "details": details})
        if not condition:
            raise AssertionError(f"{name}: {details}")

    for name, width, height in [("desktop", 1440, 1000), ("mobile", 390, 844)]:
        context, page, network, errors, dialogs = setup_page(browser, base_url + "/index.html", width, height)
        page.set_default_timeout(10000)
        prefix = name + ": "
        try:
            open_optional_settings(page)
            page.locator("#city").fill("台北")
            page.locator("#origin").fill("台中")
            page.locator("#flightArrival").fill(START + "T18:00")
            page.locator("#flightDeparture").fill(END + "T09:00")
            page.locator("#hasHotel").uncheck()
            page.locator(".btn-magic").click()
            page.wait_for_function("document.getElementById('spots').value.includes('測試推薦景點一')")
            check(prefix + "AI recommendations populate fields", "測試推薦餐點" in page.locator("#foodList").input_value())
            page.locator("#spots").fill("大稻埕需求標記")
            page.locator("#foodList").fill("素食需求標記")
            page.locator("#customPrefs").fill("花生過敏需求標記")
            check(prefix + "overnight trip displays two dates", page.locator("#durationDisplay").input_value() == "2 天")
            empty_path = ARTIFACTS / f"after-{name}.png"
            page.screenshot(path=str(empty_path), full_page=True, animations="disabled")
            report["screenshots"].append(str(empty_path))

            # Exercise a single-day checkpoint; whole_book_smoke covers the full UI workflow.
            page.evaluate("() => { void planTrip(); }")
            page.wait_for_function("tripData.length === 1 && document.querySelectorAll('#tripContainer > details').length === 1 && !document.getElementById('planBtn').disabled")
            check(prefix + "first day and continuation", page.locator("#generateNextDayBtn").is_visible())
            first_request = network.ai_requests[-1]
            check(prefix + "DeepSeek wire format", "messages" in first_request and first_request.get("response_format") == {"type": "json_object"})
            prompt = first_request["messages"][-1]["content"]
            check(prefix + "preferences reach the AI", all(text in prompt for text in ["大稻埕需求標記", "素食需求標記", "花生過敏需求標記"]))

            workspace_view(page, 'settings')
            page.locator(".btn-setting").click()
            with page.expect_download() as download:
                page.locator("#apiModal button[onclick='exportData()']").click()
            backup_path = ARTIFACTS / f"partial-backup-{name}.json"
            download.value.save_as(str(backup_path))
            backup = json.loads(backup_path.read_text(encoding="utf-8"))
            check(prefix + "backup excludes API credentials", "mock-not-a-real-key" not in json.dumps(backup))
            check(prefix + "backup includes continuation state", any(isinstance(value, dict) and value.get("totalDays") == 2 for value in backup.values()))
            page.locator("#apiModal .modal-close").click()
            page.locator("#apiModal").wait_for(state='hidden')
            workspace_view(page, 'itinerary')

            page.locator("#generateNextDayBtn").click()
            page.wait_for_function("tripData.length === 2 && document.querySelectorAll('#tripContainer > details').length === 2")
            check(prefix + "second day date preserved", page.evaluate("tripData.map(day => day.date)") == [START, END])
            page.locator("#tripContainer .btn-modify").first.click()
            page.locator("#modifyInstruction").fill("微調：改成輕鬆路線")
            page.locator("#modifyModal button[onclick='submitModification()']").click()
            page.wait_for_function("document.getElementById('tripContainer').textContent.includes('微調後景點') && !document.getElementById('planBtn').disabled")
            check(prefix + "modification immediately rerenders", page.locator("#tripContainer .itinerary-table").get_by_text("微調後景點", exact=True).count() == 1)

            page.reload(wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#tripContainer > details').length === 2")
            check(prefix + "reload restores edited trip", "微調後景點" in page.locator("#tripContainer").inner_text())
            report["viewports"][name] = overflow(page)
            check(prefix + "no horizontal page overflow", not report["viewports"][name]["overflow"], report["viewports"][name])
            trip_path = ARTIFACTS / f"after-trip-{name}.png"
            page.screenshot(path=str(trip_path), full_page=True, animations="disabled")
            report["screenshots"].append(str(trip_path))

            before_failure = page.evaluate("JSON.stringify(tripData)")
            network.fail_ai = True
            previous_dialogs = len(dialogs)
            workspace_view(page, 'settings')
            page.evaluate("() => { void planTrip(); }")
            page.wait_for_function("!document.getElementById('planBtn').disabled")
            check(prefix + "failed generation preserves existing trip", page.evaluate("JSON.stringify(tripData)") == before_failure)
            check(prefix + "failed generation reports error", len(dialogs) > previous_dialogs)
            network.fail_ai = False

            previous_dialogs = len(dialogs)
            page.locator("#importFile").set_input_files({"name": "invalid.json", "mimeType": "application/json", "buffer": b'{invalid'})
            page.wait_for_function("document.getElementById('importFile').value === ''")
            check(prefix + "invalid import preserves trip", page.evaluate("JSON.stringify(tripData)") == before_failure)
            check(prefix + "invalid import reports error", len(dialogs) > previous_dialogs)

            # Test application export cleanup with a deterministic canvas. This is not
            # a visual test of the external html2canvas implementation.
            page.evaluate("""() => { window.html2canvas = async () => { const canvas=document.createElement('canvas'); canvas.width=32; canvas.height=32; return canvas; }; }""")
            before_export = page.evaluate("Array.from(document.querySelectorAll('#tripContainer > details'), day => day.open)")
            await_export = "async functionName => { await window[functionName](); }"
            page.evaluate(await_export, "exportToA4Image")
            page.evaluate(await_export, "exportToMobileImages")
            check(prefix + "exports restore expanded state", page.evaluate("Array.from(document.querySelectorAll('#tripContainer > details'), day => day.open)") == before_export)
            check(prefix + "exports restore controls and CSS", page.locator("#tripContainer .btn-modify").first.is_visible() and page.locator(".paper-mode, .snapshot-mode, .print-mode, .export-host").count() == 0)
            page.evaluate("() => { window.html2canvas = async () => { throw new Error('Mocked rendering failure'); }; }")
            page.evaluate(await_export, "exportToA4Image")
            check(prefix + "failed export restores controls and CSS", page.locator("#tripContainer .btn-modify").first.is_visible() and page.locator(".paper-mode, .snapshot-mode, .print-mode, .export-host").count() == 0)

            workspace_view(page, 'settings')
            with page.expect_navigation(wait_until="load"):
                page.locator("button[onclick='clearAll()']").click()
            page.wait_for_function("tripData.length === 0 && localStorage.getItem('myTrip_v27') === null && localStorage.getItem('generationState_v27') === null")
            check(prefix + "clear removes itinerary and continuation", page.evaluate("tripData.length") == 0)
            with page.expect_navigation(wait_until="load"):
                page.locator("#importFile").set_input_files(str(backup_path))
            page.wait_for_function("tripData.length === 1 && !!document.getElementById('generateNextDayBtn')")
            check(prefix + "import restores continuation", page.locator("#generateNextDayBtn").is_visible())
            page.locator("#generateNextDayBtn").click()
            page.wait_for_function("tripData.length === 2 && document.querySelectorAll('#tripContainer > details').length === 2")
            check(prefix + "imported trip can generate next day", page.evaluate("tripData[1].date") == END)

            # Legacy backups deliberately omit continuation state; rendering must
            # preserve text without executing imported HTML or retaining old state.
            hostile = '<img src=x onerror="window.__xssExecuted=true">'
            legacy = {"i": page.evaluate("JSON.parse(localStorage.getItem('tripDraft_v27'))"), "t": [sample_day()]}
            legacy["t"][0]["itinerary"][0]["title"] = hostile
            with page.expect_navigation(wait_until="load"):
                page.locator("#importFile").set_input_files({"name": "legacy.json", "mimeType": "application/json", "buffer": json.dumps(legacy, ensure_ascii=False).encode("utf-8")})
            page.wait_for_function("tripData.length === 1 && document.getElementById('tripContainer').textContent.includes('<img')")
            check(prefix + "imported HTML stays inert text", page.evaluate("window.__xssExecuted !== true") and page.locator("#tripContainer > details img").count() == 0)
            check(prefix + "legacy import discards old continuation", page.locator("#generateNextDayBtn").count() == 0)
            check(prefix + "no uncaught browser exceptions", not errors, errors)
            (ARTIFACTS / f"failure-{name}.png").unlink(missing_ok=True)
        except Exception as error:
            failure_path = ARTIFACTS / f"failure-{name}.png"
            page.screenshot(path=str(failure_path), full_page=True, animations="disabled")
            report["failures"].append({"viewport": name, "error": str(error), "trace": traceback.format_exc(), "page_errors": errors, "dialogs": dialogs, "screenshot": str(failure_path)})
        finally:
            report.setdefault("ai_request_counts", {})[name] = len(network.ai_requests)
            report.setdefault("blocked_external_requests", {})[name] = sorted(network.blocked)
            context.close()
    targeted_checks(browser, base_url, report, check)
    report["passed"] = not report["failures"] and all(check["passed"] for check in report["checks"])
    return report


def targeted_checks(browser, base_url, report, check):
    """Exercise rollback boundaries and delayed responses independently of UI smoke."""
    context, page, network, errors, dialogs = setup_page(browser, base_url + "/index.html", 1440, 1000)
    page.set_default_timeout(10000)
    prefix = "targeted: "

    def snapshot():
        return page.evaluate("""() => ({
            memory: JSON.stringify({tripData, generationState}),
            disk: JSON.stringify({trip: localStorage.getItem('myTrip_v27'), state: localStorage.getItem('generationState_v27')}),
            // Compare the committed itinerary, excluding transient progress labels.
            html: JSON.stringify({days: Array.from(document.querySelectorAll('#tripContainer > details'), day => day.outerHTML), cost: document.querySelector('#tripContainer .total-cost-summary')?.textContent})
        })""")

    def assert_unchanged(label, previous):
        current = snapshot()
        for field in ["memory", "disk", "html"]:
            check(prefix + label + " preserves " + field, current[field] == previous[field])

    try:
        day = sample_day(title="東京公園與街區")
        day["itinerary"][0].update(title="上野公園", address="", cost="¥1,500")
        day["itinerary"][1].update(title="在地餐館", address="", cost="¥200")
        network.result_override = day
        open_optional_settings(page)
        page.locator("#city").fill("東京")
        page.locator("#flightArrival").fill(START + "T18:00")
        page.locator("#flightDeparture").fill(END + "T09:00")
        page.locator("#hasHotel").uncheck()
        page.evaluate("() => { void planTrip(); }")
        page.wait_for_function("tripData.length === 1 && !isBusy && !!document.getElementById('generateNextDayBtn')")
        check(prefix + "JPY amount before reload", "¥1,700" in page.locator("#tripContainer .day-cost-badge").first.inner_text())
        page.reload(wait_until="networkidle")
        page.wait_for_function("document.querySelectorAll('#tripContainer > details').length === 1")
        check(prefix + "JPY amount survives reload", "¥1,700" in page.locator("#tripContainer .day-cost-badge").first.inner_text())

        workspace_view(page, 'settings')
        page.locator("#city").fill("巴黎")
        page.evaluate("async () => { await renderTrip(); }")
        workspace_view(page, 'itinerary')
        query = parse_qs(urlparse(page.locator("#tripContainer .table-map-link").first.get_attribute("href")).query)["query"][0]
        check(prefix + "single-place Map keeps original city after draft edits", "東京" in query and "巴黎" not in query, query)
        route = parse_qs(urlparse(page.locator("#tripContainer .btn-route").first.get_attribute("href")).query)
        check(prefix + "day route keeps original city after draft edits", "東京" in route["origin"][0] and "巴黎" not in str(route), route)

        # A parsed JSON response is still invalid when itinerary is not an array.
        previous = snapshot()
        previous_dialogs = len(dialogs)
        network.result_override = {"date": END, "day_title": "Malformed fixture", "itinerary": {"title": "not an array"}}
        page.evaluate("() => { void generateNextDay(); }")
        page.wait_for_function("!isBusy")
        assert_unchanged("malformed AI response", previous)
        check(prefix + "malformed AI response reports a handled error", len(dialogs) > previous_dialogs)

        # Throw only once on the second record so rollback itself can complete.
        # This catches disk-first commits that leave memory or DOM ahead of disk.
        previous = snapshot()
        previous_dialogs = len(dialogs)
        network.result_override = sample_day(END, title="即將回滾的第二天")
        page.evaluate("""() => {
            window.__originalStorageSetItem = Storage.prototype.setItem;
            window.__storageFailure = {tripWritten: false, fired: false};
            Storage.prototype.setItem = function(key, value) {
                if (this === localStorage && key === 'myTrip_v27' && !window.__storageFailure.fired) window.__storageFailure.tripWritten = true;
                if (this === localStorage && key === 'generationState_v27' && window.__storageFailure.tripWritten && !window.__storageFailure.fired) {
                    window.__storageFailure.fired = true;
                    throw new DOMException('Injected second-record failure', 'QuotaExceededError');
                }
                return window.__originalStorageSetItem.call(this, key, value);
            };
        }""")
        try:
            page.evaluate("() => { void generateNextDay(); }")
            page.wait_for_function("!isBusy")
            check(prefix + "storage fault fires after first record writes", page.evaluate("window.__storageFailure.tripWritten && window.__storageFailure.fired"))
            assert_unchanged("second-record storage failure", previous)
            check(prefix + "storage failure reports a handled error", len(dialogs) > previous_dialogs)
        finally:
            page.evaluate("() => { Storage.prototype.setItem = window.__originalStorageSetItem; }")

        # Keep the actual fetch unresolved while calling all three entry points.
        network.result_override = sample_day(END, title="並發防護完成")
        network.hold_ai = True
        calls_before = len(network.ai_requests)
        page.locator("#generateNextDayBtn").click()
        page.wait_for_function("isBusy")
        check(prefix + "pending generation locks visible controls", page.locator("#planBtn").is_disabled() and page.locator("#city").is_disabled())
        check(prefix + "one AI request is pending", len(network.pending) == 1 and len(network.ai_requests) == calls_before + 1)
        page.evaluate("""async () => {
            currentModifyIndex = 0;
            document.getElementById('modifyInstruction').value = '這個並發微調不應送出';
            await Promise.all([generateNextDay(), planTrip(), submitModification()]);
        }""")
        check(prefix + "concurrent next/plan/modify send no extra requests", len(network.ai_requests) == calls_before + 1)
        network.hold_ai = False
        network.release_ai()
        page.wait_for_function("!isBusy && tripData.length === 2")
        check(prefix + "pending result commits exactly one extra day", page.evaluate("tripData.map(day => day.date)") == [START, END])
        check(prefix + "targeted cases have no uncaught exceptions", not errors, errors)
        (ARTIFACTS / "failure-targeted.png").unlink(missing_ok=True)
    except Exception as error:
        path = ARTIFACTS / "failure-targeted.png"
        page.screenshot(path=str(path), full_page=True, animations="disabled")
        report["failures"].append({"viewport": "targeted", "error": str(error), "trace": traceback.format_exc(), "page_errors": errors, "dialogs": dialogs, "screenshot": str(path)})
    finally:
        report["ai_request_counts"]["targeted"] = len(network.ai_requests)
        report["blocked_external_requests"]["targeted"] = sorted(network.blocked)
        context.close()

    # An independent clean browser context must not inherit mock credentials.
    context, page, network, errors, dialogs = setup_page(browser, base_url + "/index.html", 390, 844, with_key=False)
    try:
        page.locator("#planBtn").click()
        check(prefix + "missing API key opens settings", page.locator("#apiModal").is_visible())
        check(prefix + "missing API key sends no AI POST", len(network.ai_requests) == 0)
        check(prefix + "missing API key has no uncaught exception", not errors, errors)
        (ARTIFACTS / "failure-missing-key.png").unlink(missing_ok=True)
    except Exception as error:
        path = ARTIFACTS / "failure-missing-key.png"
        page.screenshot(path=str(path), full_page=True, animations="disabled")
        report["failures"].append({"viewport": "missing-key", "error": str(error), "trace": traceback.format_exc(), "page_errors": errors, "dialogs": dialogs, "screenshot": str(path)})
    finally:
        report["ai_request_counts"]["missing-key"] = len(network.ai_requests)
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["baseline", "smoke"], default="smoke")
    args = parser.parse_args()
    ARTIFACTS.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            report = (baseline if args.mode == "baseline" else smoke)(browser, f"http://127.0.0.1:{server.server_port}")
            browser.close()
        report_path = ARTIFACTS / f"{args.mode}-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if args.mode == "smoke" and not report["passed"]:
            raise SystemExit(1)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
