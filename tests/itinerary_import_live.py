"""Read-only deployment smoke: real static assets, mocked AI, isolated localStorage.

python tests/itinerary_import_live.py --url https://example.com/path/ --report import-live.json
Optional --credentials reads an external JSON {url, username, password}; never logs it.
No mutation request is sent to the website or a real AI provider.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
DATE = "2026-11-10"
WARNING = "來源備註：午餐僅收現金。"


def origin(url):
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("URL must be HTTP(S) without embedded credentials.")
    return f"{parsed.scheme}://{parsed.netloc}"


def mocked_itinerary():
    return {"city": "台北", "days": [
        {"date": DATE, "day_title": "第一份行程", "summary": "第一份文件說明", "itinerary": [
            {"title": "晚餐集合", "time": "18:00", "type": "FOOD"},
            {"title": "大稻埕", "time": "09:00", "type": "SPOT", "address": "台北迪化街", "desc": "第一份的紅磚街景介紹"},
        ]},
        {"date": DATE, "day_title": "補充行程", "summary": "第二份文件說明", "itinerary": [
            {"title": "午餐", "time": "12:00", "type": "FOOD"},
            {"title": "大稻埕", "time": "09:00", "type": "SPOT", "address": "台北迪化街", "tips": "第二份提醒：北側入口集合"},
            {"title": "時間未定補充活動", "time": "", "type": "SPOT"},
        ]},
    ], "warnings": [WARNING]}


class LiveNetwork:
    """Only same-origin static GET/HEAD reaches the real deployment."""
    def __init__(self, base):
        self.base_origin = origin(base)
        self.ai_requests = []
        self.blocked_mutations = []
        self.static_responses = []

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if parsed.hostname == "api.deepseek.com":
            if request.method == "POST":
                self.ai_requests.append(request.post_data_json)
                payload = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(mocked_itinerary(), ensure_ascii=False)}}]}
                return route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
            return route.abort()
        if request.method not in {"GET", "HEAD"}:
            self.blocked_mutations.append({"method": request.method, "path": parsed.path})
            return route.fulfill(status=403, content_type="application/json", body='{"error":"Blocked by read-only deployment test"}')
        if f"{parsed.scheme}://{parsed.netloc}" == self.base_origin:
            # Codex status/usage is unrelated to file import; avoid even read-side AI probes.
            if parsed.path.startswith("/codex/"):
                return route.fulfill(status=503, content_type="application/json", body='{"ready":false,"error":"Not used by this test"}')
            return route.continue_()
        # Fonts/CDN export libraries may load for the genuine page; no external writes.
        if parsed.hostname in {"fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "html2canvas.hertzen.com"}:
            return route.continue_()
        return route.abort()

    def response(self, response):
        parsed = urlsplit(response.url)
        if "/vendor/pdfjs/" in parsed.path:
            self.static_responses.append({"path": parsed.path, "status": response.status, "mime": response.headers.get("content-type", "")})


def run(args):
    target_origin = origin(args.url)
    secrets = []
    auth = None
    if args.credentials:
        credentials = json.loads(Path(args.credentials).read_text(encoding="utf-8-sig"))
        if origin(credentials["url"]) != target_origin:
            raise ValueError("Credential origin does not match --url.")
        if not all(isinstance(credentials.get(key), str) and credentials[key] for key in ["username", "password"]):
            raise ValueError("Credential file requires nonempty username/password strings.")
        secrets = [credentials["username"], credentials["password"]]
        auth = {"username": credentials["username"], "password": credentials["password"], "origin": target_origin}
        del credentials

    def safe_error(value):
        text = str(value)
        for secret in secrets:
            text = text.replace(secret, "[redacted]")
        return text

    report_path = Path(args.report)
    if not report_path.is_absolute():
        report_path = ARTIFACTS / report_path
    report_path.parent.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9_-]", "-", report_path.stem)
    checks, failures, screenshots, network_reports = [], [], [], []

    def check(label, name, value):
        checks.append({"viewport": label, "name": name, "passed": bool(value)})
        if not value:
            raise AssertionError(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        # Build an actual selectable-text PDF entirely in memory.
        fixture_page = browser.new_page()
        fixture_page.set_content("<h1>Taipei itinerary PDF</h1><p>2026-11-10</p><p>09:00 PDF_SOURCE_MARKER Dadaocheng</p>")
        pdf = fixture_page.pdf(format="A4")
        fixture_page.close()
        for label, width in [("desktop", 1440), ("mobile", 390)]:
            options = {"viewport": {"width": width, "height": 950}, "timezone_id": "Asia/Taipei", "service_workers": "block"}
            if auth:
                options["http_credentials"] = auth
            context = browser.new_context(**options)
            network = LiveNetwork(args.url)
            context.route("**/*", network.route)
            context.on("response", network.response)
            legacy = {"i": {"city": "原測試旅程", "hasHotel": False}, "t": [{"date": DATE, "day_title": "原測試旅程", "summary": "須完整保留", "itinerary": [{"title": "原站點", "time": "08:00", "type": "SPOT", "userNote": "原筆記"}]}]}
            context.add_init_script("""(() => {
                localStorage.setItem('aiProvider','deepseek');
                sessionStorage.setItem('deepseekApiKey','mock-not-a-real-key');
                localStorage.setItem('roamReadingMode','continuous');
                if (!localStorage.liveImportSeeded) {
                    const seed=SEED;
                    localStorage.setItem('tripDraft_v27',JSON.stringify(seed.i));
                    localStorage.setItem('myTrip_v27',JSON.stringify(seed.t));
                    localStorage.liveImportSeeded='yes';
                }
            })();""".replace("SEED", json.dumps(legacy, ensure_ascii=False)))
            page = context.new_page()
            page.set_default_timeout(25000)
            errors = []
            page.on("pageerror", lambda error: errors.append(safe_error(error)))
            page.on("dialog", lambda dialog: dialog.accept())
            try:
                navigation = page.goto(args.url, wait_until="networkidle", timeout=60000)
                check(label, "real website document loads", navigation is not None and navigation.status == 200)
                page.wait_for_selector("#openItineraryImport")
                check(label, "test selects mocked DeepSeek provider", page.locator("#aiProvider").input_value() == "deepseek")
                page.evaluate("""() => {const days=structuredClone(tripData);days[0].summary+='，含復原紀錄';TripLibrary.write({myTrip_v27:JSON.stringify(days)},{label:'部署驗收測試'});} """)
                original = page.evaluate("TripLibrary.active()")
                original_raw = page.evaluate("localStorage.tourismTrips_v1")
                page.locator("#openItineraryImport").click()
                page.locator("#itinerarySourceFile").set_input_files([
                    {"name": "第一份.txt", "mimeType": "text/plain", "buffer": b"2026-11-10 18:00 dinner TXT_SOURCE_MARKER"},
                    {"name": "第二份.md", "mimeType": "text/markdown", "buffer": b"# 2026-11-10\n12:00 lunch MD_SOURCE_MARKER"},
                    {"name": "行程.pdf", "mimeType": "application/pdf", "buffer": pdf},
                ])
                page.wait_for_function("!isBusy && document.getElementById('itinerarySourceText').value.includes('PDF_SOURCE_MARKER')", timeout=45000)
                text = page.locator("#itinerarySourceText").input_value()
                check(label, "real PDFJS reads and merges TXT Markdown PDF", all(marker in text for marker in ["TXT_SOURCE_MARKER", "MD_SOURCE_MARKER", "PDF_SOURCE_MARKER"]))
                check(label, "reading files performs no AI or persistence", not network.ai_requests and page.evaluate("localStorage.tourismTrips_v1") == original_raw)
                check(label, "real PDF module and worker return JavaScript", all(any(item["path"].endswith("/" + asset) and item["status"] == 200 and ("javascript" in item["mime"] or "ecmascript" in item["mime"]) for item in network.static_responses) for asset in ["pdf.mjs", "pdf.worker.mjs"]))
                font = page.evaluate("""async () => {const r=await fetch(new URL('vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',document.baseURI));return {status:r.status,mime:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength};}""")
                check(label, "bundled PDF font is served as font or binary", font["status"] == 200 and font["bytes"] > 1000 and any(mime in (font["mime"] or "") for mime in ["font/", "application/octet-stream", "application/x-font", "application/font"]))
                page.evaluate("document.getElementById('itineraryImportModal').scrollTop=0")
                source_shot = report_path.parent / f"{stem}-source-{label}.png"
                page.screenshot(path=str(source_shot)); screenshots.append(str(source_shot))
                page.locator("#itineraryParseButton").click()
                page.wait_for_function("!isBusy && !document.getElementById('itinerarySaveButton').disabled")
                check(label, "exactly one AI request is locally mocked", len(network.ai_requests) == 1)
                prompt = network.ai_requests[0]["messages"][-1]["content"]
                check(label, "all source files reach the mocked parser", all(marker in prompt for marker in ["TXT_SOURCE_MARKER", "MD_SOURCE_MARKER", "PDF_SOURCE_MARKER"]))
                stops = page.locator("#itineraryImportPreview li > strong").all_text_contents()
                check(label, "same-date duplicate merges and sorts 09 12 18 unknown", page.locator("#itineraryImportPreview details").count() == 1 and len(stops) == 4 and all(text.startswith(time) for text, time in zip(stops, ["09:00", "12:00", "18:00", "時間待補"])))
                check(label, "preview keeps complementary descriptions and warnings", all(text in page.locator("#itineraryImportPreview").text_content() for text in ["紅磚街景", "北側入口集合", WARNING, "已合併 1"]))
                check(label, "preview leaves original stored journey unchanged", page.evaluate("localStorage.tourismTrips_v1") == original_raw)
                check(label, "modal fits viewport without horizontal overflow", page.evaluate("document.documentElement.scrollWidth<=innerWidth+1") and page.locator("#itineraryImportModal .modal-content").evaluate("e=>e.scrollWidth<=e.clientWidth+1"))
                page.locator("#itineraryImportName").fill("正式網站隔離驗收旅程")
                page.locator("#itineraryPreviewSection").evaluate("e=>e.scrollIntoView({block:'start'})")
                preview_shot = report_path.parent / f"{stem}-preview-{label}.png"
                page.screenshot(path=str(preview_shot)); screenshots.append(str(preview_shot))
                with page.expect_navigation(wait_until="load"):
                    page.locator("#itinerarySaveButton").click()
                page.wait_for_function("!isBusy && tripData.length===1")
                page.reload(wait_until="networkidle")
                book = page.evaluate("JSON.parse(localStorage.tourismTrips_v1)")
                check(label, "save and reload append exactly one journey", len(book["trips"]) == 2 and book["activeId"] != original["id"])
                check(label, "original journey and undo remain identical", next(item for item in book["trips"] if item["id"] == original["id"]) == original)
                current = next(item for item in book["trips"] if item["id"] == book["activeId"])
                days = current["data"]["t"]
                check(label, "merged day and chronological order persist", len(days) == 1 and [item["time"] for item in days[0]["itinerary"]] == ["09:00", "12:00", "18:00", ""])
                check(label, "notes and warnings persist after reload", WARNING in days[0]["summary"] and "第二份文件說明" in days[0]["summary"] and "北側入口集合" in days[0]["itinerary"][0]["tips"])
                check(label, "no server mutations were attempted", not network.blocked_mutations)
                check(label, "no uncaught page exceptions", not errors)
            except Exception as exc:
                failures.append({"viewport": label, "error": safe_error(exc), "page_errors": errors})
                shot = report_path.parent / f"{stem}-failure-{label}.png"
                try:
                    page.screenshot(path=str(shot)); screenshots.append(str(shot))
                except Exception:
                    pass
            finally:
                network_reports.append({"viewport": label, "mock_ai_calls": len(network.ai_requests), "blocked_mutations": network.blocked_mutations, "pdf_assets": network.static_responses})
                context.close()
        browser.close()
    parsed = urlsplit(args.url)
    report = {"passed": not failures and all(item["passed"] for item in checks), "target": f"{parsed.scheme}://{parsed.netloc}{parsed.path}", "checks": checks, "failures": failures, "networks": network_reports, "screenshots": screenshots, "scope": "Real deployment static files/PDFJS/worker/font; AI responses mocked in browser. All non-GET/HEAD mutations blocked. Isolated browser localStorage only. Desktop/mobile Chromium, not physical-phone verification."}
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "checks": len(checks), "failures": len(failures), "report": str(report_path)}, ensure_ascii=False))
    return 0 if report["passed"] else 1


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--credentials")
    parser.add_argument("--report", default="itinerary-import-live-report.json")
    args = parser.parse_args()
    try:
        return run(args)
    except Exception as exc:
        # Avoid echoing credential paths or file contents for startup failures.
        print(json.dumps({"passed": False, "setup_error": type(exc).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
