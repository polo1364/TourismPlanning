"""One explicitly requested real Codex vision import; no saved journey/server data changes."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from itinerary_import_live import scanned_pdf_fixtures, origin, ARTIFACTS


def run(args):
    credentials = json.loads(Path(args.credentials).read_text(encoding="utf-8-sig"))
    target_origin = origin(args.url)
    if origin(credentials["url"]) != target_origin or not target_origin.startswith("https://"):
        raise ValueError("Credential origin must match the HTTPS target")
    auth = {"username": credentials["username"], "password": credentials["password"], "origin": target_origin}
    secrets = [credentials["username"], credentials["password"]]
    calls, blocked, errors, checks = [], [], [], []
    response_usage = []
    report_path = ARTIFACTS / args.report
    screenshot = report_path.with_suffix(".png")

    def check(name, result):
        checks.append({"name": name, "passed": bool(result)})
        if not result:
            raise AssertionError(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        scans = scanned_pdf_fixtures(browser)
        fixture = browser.new_page(viewport={"width": 1200, "height": 600})
        fixture.set_content('<style>body{margin:50px;font:48px "Microsoft JhengHei",sans-serif;line-height:1.8}</style><div>2026-11-10 台北行程</div><div>09:00 大稻埕</div><div>提醒：穿舒適鞋</div>')
        fixture.evaluate("document.fonts.ready")
        png = fixture.screenshot()
        fixture.close()
        context = browser.new_context(http_credentials=auth, viewport={"width": 1440, "height": 1050}, timezone_id="Asia/Taipei", service_workers="block")
        context.add_init_script("localStorage.setItem('aiProvider','deepseek');localStorage.setItem('roamReadingMode','continuous');")

        def route_request(route):
            request = route.request
            parsed = urlsplit(request.url)
            same = f"{parsed.scheme}://{parsed.netloc}" == target_origin
            if request.method == "POST" and same and parsed.path == "/codex/import-itinerary" and not calls:
                body = request.post_data_json
                calls.append({"images": len(body.get("images", [])), "names": [item["name"] for item in body.get("images", [])], "body_bytes": len(request.post_data_buffer)})
                return route.continue_()
            if request.method not in {"GET", "HEAD"}:
                blocked.append({"method": request.method, "path": parsed.path})
                return route.abort()
            if same or parsed.hostname in {"fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "html2canvas.hertzen.com"}:
                return route.continue_()
            return route.abort()

        context.route("**/*", route_request)
        page = context.new_page()
        page.set_default_timeout(30000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        def response_seen(response):
            if urlsplit(response.url).path == "/codex/import-itinerary":
                try:
                    body = response.json()
                    response_usage.append({"status": response.status, "usage": body.get("usage"), "code": body.get("code")})
                except Exception:
                    response_usage.append({"status": response.status})

        page.on("response", response_seen)
        failure = None
        preview = ""
        try:
            page.goto(args.url, wait_until="networkidle", timeout=60000)
            before = page.evaluate("localStorage.tourismTrips_v1")
            page.locator("#openItineraryImport").click()
            page.locator("#itinerarySourceFile").set_input_files([
                scans[0],
                {"name": "補充照片.png", "mimeType": "image/png", "buffer": png},
                {"name": "補充集合.txt", "mimeType": "text/plain", "buffer": "2026-11-10 台北行程\n09:00 大稻埕\n提醒：北側入口集合".encode("utf-8")},
            ])
            page.wait_for_function("!isBusy && document.getElementById('itinerarySourceText').value.includes('北側入口集合')", timeout=90000)
            check("preparation uses no Codex generation", not calls)
            page.locator("#itineraryParseButton").click()
            page.wait_for_function("!isBusy && (!document.getElementById('itinerarySaveButton').disabled || !document.getElementById('itineraryImportError').hidden)", timeout=215000)
            check("real Codex returned a valid itinerary", page.locator("#itineraryImportError").is_hidden() and page.locator("#itinerarySaveButton").is_enabled())
            preview = page.locator("#itineraryImportPreview").text_content()
            stops = page.locator("#itineraryImportPreview li > strong").all_text_contents()
            check("one Codex request receives two PDF pages plus PNG", len(calls) == 1 and calls[0]["images"] == 3)
            check("multi-file duplicates merge into two chronological stops", len(stops) == 2 and "09:00" in stops[0] and "大稻埕" in stops[0] and "12:00" in stops[1] and "台北車站" in stops[1])
            check("image and TXT complementary notes both survive", "舒適鞋" in preview and "北側入口" in preview)
            check("source date is retained", "2026-11-10" in preview)
            check("existing saved journeys unchanged", page.evaluate("localStorage.tourismTrips_v1") == before)
            check("no other mutation requests or browser exceptions", not blocked and not errors)
            page.locator("#itineraryPreviewSection").evaluate("element=>element.scrollIntoView({block:'start'})")
        except Exception as exc:
            failure = str(exc)
            for secret in secrets:
                failure = failure.replace(secret, "[redacted]")
        finally:
            page.screenshot(path=str(screenshot))
            context.close()
            browser.close()
    report = {"passed": failure is None, "target": args.url, "checks": checks, "failure": failure, "requests": calls, "responses": response_usage, "blocked": blocked, "errors": errors, "preview": preview, "screenshot": str(screenshot), "scope": "One actual ChatGPT-authenticated Codex vision request reading a two-page scanned PDF, PNG and TXT, merging duplicates into preview only. No journey save or backend state mutation."}
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "checks": len(checks), "report": str(report_path)}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--credentials", required=True)
    parser.add_argument("--report", default="itinerary-codex-real-live.json")
    arguments = parser.parse_args()
    try:
        raise SystemExit(run(arguments))
    except Exception as error:
        print(json.dumps({"passed": False, "setup_error": type(error).__name__}))
        raise SystemExit(1)
