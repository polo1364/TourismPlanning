"""Exercise itinerary-file import with real PDF.js and isolated Chromium storage.

All AI responses are deterministic stubs. No paid provider calls are made.
Run: python tests/itinerary_import_smoke.py
"""
from __future__ import annotations

import json
import base64
import sys
import threading
import traceback
from datetime import date, timedelta
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, sample_day, overflow


KEY = "tourismTrips_v1"
TEXT = "台北兩日行程\n2026-11-10\n09:00 大稻埕街區\n12:00 在地小吃午餐\n2026-11-11\n10:00 台北植物園\n"
PAYLOAD = "<img src=x onerror=window.importXss=1>"
MERGED_NOTE = "第二份檔案提醒：北側入口集合，攜帶雨傘。"
SOURCE_WARNING = "來源注意事項：午餐只收現金。"


def response():
    first = sample_day()
    first["summary"] = PAYLOAD
    second = sample_day("2026-11-11", "第二天植物園")
    second["itinerary"] = [{"title": "台北植物園", "time": "10:00", "type": "SPOT"}]
    supplement = {"date": START, "day_title": "第一天補充", "summary": "第二份來源備註：雨天照常集合。", "itinerary": [{"title": "大稻埕街區", "time": "09:00", "type": "SPOT", "address": "台北市大同區迪化街", "desc": "補充導覽：入口處領取地圖。", "tips": MERGED_NOTE}]}
    # Different files repeat one day/stop and add complementary notes.
    return {"city": "台北", "days": [second, first, supplement], "warnings": ["來源未提供結束時間。", SOURCE_WARNING]}


def shuffled_response():
    value = response()
    first, supplement = value["days"][1:]
    morning, lunch = first["itinerary"]
    first["itinerary"] = [{"title": "晚餐集合", "time": "18:00", "type": "FOOD"}, morning]
    supplement["itinerary"] += [lunch, {"title": "時間未定的補充活動", "time": "", "type": "SPOT"}]
    return value


class ImportNetwork(Network):
    def __init__(self):
        super().__init__()
        self.result = response()
        self.ocr_requests = []
        self.deepseek_requests = []

    @staticmethod
    def cors(route):
        return {'Access-Control-Allow-Origin': route.request.headers.get('origin', '*'), 'Access-Control-Allow-Headers': 'Content-Type, X-Roam-Token'}

    def route(self, route):
        url = urlparse(route.request.url)
        if '/vendor/tesseract/' in url.path:
            self.ocr_requests.append(route.request.url)
            return route.abort()
        if url.hostname == "api.deepseek.com":
            self.deepseek_requests.append(route.request.url)
            return route.abort()
        if url.hostname != "127.0.0.1" or url.port != 8081:
            return super().route(route)
        headers = self.cors(route)
        if route.request.method == 'OPTIONS':
            return route.fulfill(status=204, headers=headers)
        if url.path == '/status':
            return route.fulfill(status=200, headers=headers, content_type='application/json', body=json.dumps({'ready': True, 'auth': 'chatgpt', 'token': 'mock-import-token'}))
        if url.path == '/usage':
            return route.fulfill(status=200, headers=headers, content_type='application/json', body=json.dumps({'available': False, 'limits': [], 'models': []}))
        if url.path != '/import-itinerary' or route.request.method != 'POST':
            return route.abort()
        self.ai_requests.append(route.request.post_data_json)
        result = {**self.result}
        result.setdefault('sourceReviews', [{'index': index + 1, 'status': 'clear', 'message': ''} for index, _ in enumerate(route.request.post_data_json.get('images', []))])
        payload = {'data': result, 'usage': {'inputTokens': 10, 'outputTokens': 10, 'totalTokens': 20}}
        if self.hold_ai:
            self.pending.append((route, payload))
            return
        return route.fulfill(status=200, headers=headers, content_type="application/json", body=json.dumps(payload))

    def release(self):
        pending, self.pending = self.pending, []
        for route, payload in pending:
            try:
                route.fulfill(status=200, headers=self.cors(route), content_type="application/json", body=json.dumps(payload))
            except Exception:
                # AbortSignal may have already closed the request.
                pass


def fixture_pdfs(browser):
    page = browser.new_page()
    page.set_content("<h1>Taipei itinerary</h1><p>2026-11-10</p><p>09:00 Dadaocheng</p><p>12:00 Lunch</p>")
    text_pdf = ARTIFACTS / "itinerary-source-text.pdf"
    page.pdf(path=str(text_pdf), format="A4")
    # Blank and scanned pages are sent as images; Codex decides if they contain an itinerary.
    page.set_content('<html><body></body></html>')
    blank_pdf = ARTIFACTS / "itinerary-source-blank.pdf"
    page.pdf(path=str(blank_pdf), format="A4", print_background=True)
    page.set_content('<canvas id="scan" width="600" height="300"></canvas>')
    page.evaluate("""() => {const c=document.querySelector('canvas').getContext('2d');c.fillStyle='white';c.fillRect(0,0,600,300);c.fillStyle='black';c.font='28px sans-serif';c.fillText('2026-11-10 09:00 Taipei scan',20,60);} """)
    image_png = ARTIFACTS / "itinerary-source-image.png"
    page.locator('canvas').screenshot(path=str(image_png))
    scan_pdf = ARTIFACTS / "itinerary-source-scan.pdf"
    page.pdf(path=str(scan_pdf), format="A4", print_background=True)
    page.close()
    return text_pdf, blank_pdf, image_png, scan_pdf


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ARTIFACTS.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/"
    checks, failures, screenshots = [], [], []

    def check(name, value):
        checks.append({"name": name, "passed": bool(value)})
        assert value, name

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            text_pdf, blank_pdf, image_png, scan_pdf = fixture_pdfs(browser)
            for label, width in [("desktop", 1440), ("mobile", 390)]:
                context = browser.new_context(viewport={"width": width, "height": 950}, timezone_id="Asia/Taipei")
                network = ImportNetwork()
                context.route("**/*", network.route)
                legacy = {"i": {"city": "台北", "hasHotel": False, "flightArrival": START + "T08:00", "flightDeparture": START + "T20:00"}, "t": [sample_day()], "g": None}
                context.add_init_script("""localStorage.setItem('aiProvider','deepseek');localStorage.setItem('roamReadingMode','continuous');if(!localStorage.importSeeded){const d=SEED;localStorage.setItem('tripDraft_v27',JSON.stringify(d.i));localStorage.setItem('myTrip_v27',JSON.stringify(d.t));localStorage.importSeeded='yes';}""".replace("SEED", json.dumps(legacy, ensure_ascii=False)))
                page = context.new_page()
                page.set_default_timeout(15000)
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("dialog", lambda d: d.accept())

                def record_check(name, value):
                    check(label + " " + name, value)

                def idle():
                    page.wait_for_function("!isBusy")

                def open_import():
                    page.locator("#openItineraryImport").click()
                    page.locator("#itineraryImportModal").wait_for(state="visible")

                def source_file(name, content, mime="text/plain"):
                    page.locator("#itinerarySourceFile").set_input_files({"name": name, "mimeType": mime, "buffer": content})
                    idle()

                def ready_preview(result=None, keep_source=False):
                    network.result = response() if result is None else result
                    if not keep_source:
                        page.locator("#itinerarySourceText").fill(TEXT)
                    page.locator("#itineraryParseButton").click()
                    page.wait_for_function("!isBusy && !document.getElementById('itinerarySaveButton').disabled")
                    page.locator("#itineraryImportName").fill("讀檔測試旅程")

                def saved_state():
                    return page.evaluate("localStorage.tourismTrips_v1")

                try:
                    page.goto(base, wait_until="networkidle")
                    page.wait_for_selector("#openItineraryImport")
                    # Give the existing trip a meaningful Undo snapshot.
                    page.evaluate("""() => {const d=structuredClone(tripData);d[0].itinerary[0].userNote='原行程便利貼';TripLibrary.write({myTrip_v27:JSON.stringify(d)},{label:'原行程修改'});} """)
                    original = json.loads(saved_state())["trips"][0]
                    original_state = saved_state()
                    record_check("seed retains an Undo checkpoint", bool(original["undo"]))
                    record_check("JSON backup picker remains separate", page.locator("#importFile").get_attribute("accept") == ".json,application/json")
                    open_import()
                    source_file('a' * 196 + '.txt', TEXT.encode("utf-8"))
                    page.wait_for_function("document.getElementById('itinerarySourceText').value.includes('大稻埕')")
                    record_check("UTF-8 TXT extracted locally", "2026-11-10" in page.locator("#itinerarySourceText").input_value() and len(network.ai_requests) == 0)
                    record_check('200-character filename is accepted', 'a' * 196 + '.txt' in page.locator('#itineraryFileInfo').text_content())
                    record_check("extraction does not mutate saved trips", saved_state() == original_state)
                    source_file("行程.md", ("# 行程\n" + TEXT).encode("utf-8"), "text/markdown")
                    record_check("Markdown extracted", "# 行程" in page.locator("#itinerarySourceText").input_value())
                    source_file("繁體行程.txt", TEXT.encode("big5"))
                    record_check("Big5 extracted without replacement characters", "大稻埕" in page.locator("#itinerarySourceText").input_value() and "�" not in page.locator("#itinerarySourceText").input_value())
                    page.locator("#itinerarySourceFile").set_input_files(str(text_pdf))
                    page.wait_for_function("!isBusy && document.getElementById('itinerarySourceText').value.includes('Dadaocheng')", timeout=30000)
                    record_check("real PDF.js reads selectable PDF text", "2026-11-10" in page.locator("#itinerarySourceText").input_value())
                    record_check("file picker supports selecting multiple files", page.locator("#itinerarySourceFile").get_attribute("multiple") is not None)
                    page.locator("#itineraryClearFiles").click()
                    source_file("只有圖片.png", image_png.read_bytes(), "image/png")
                    record_check("image-only input can be submitted without local OCR", page.locator("#itinerarySourceText").input_value() == '' and page.locator("#itineraryParseButton").is_enabled() and not network.ocr_requests and not network.ai_requests)
                    page.locator("#itineraryClearFiles").click()
                    multi = [
                        {"name": "第一份.txt", "mimeType": "text/plain", "buffer": (TEXT + "\nTXT來源標記").encode("utf-8")},
                        {"name": "第二份.md", "mimeType": "text/markdown", "buffer": "# Markdown來源標記\n2026-11-11 台北植物園".encode("utf-8")},
                        {"name": "第三份.pdf", "mimeType": "application/pdf", "buffer": text_pdf.read_bytes()},
                        {"name": "第四份.png", "mimeType": "image/png", "buffer": image_png.read_bytes()},
                        {"name": "第五份掃描.pdf", "mimeType": "application/pdf", "buffer": scan_pdf.read_bytes()},
                    ]
                    page.locator("#itinerarySourceFile").set_input_files(multi)
                    page.wait_for_function("!isBusy && document.getElementById('itinerarySourceText').value.includes('Dadaocheng')", timeout=30000)
                    merged = page.locator("#itinerarySourceText").input_value()
                    record_check("one selection merges TXT Markdown and real PDF", all(marker in merged for marker in ["TXT來源標記", "Markdown來源標記", "Dadaocheng"]))
                    source_file("補充.txt", "追加來源標記：記得帶雨傘".encode("utf-8"))
                    merged = page.locator("#itinerarySourceText").input_value()
                    record_check("later file selection appends previous sources", all(marker in merged for marker in ["TXT來源標記", "Markdown來源標記", "Dadaocheng", "追加來源標記"]))
                    record_check("reading multiple files is local and never writes trips", len(network.ai_requests) == 0 and not network.ocr_requests and saved_state() == original_state)
                    page.evaluate("() => {window.scrollTo(0,0);document.getElementById('itineraryImportModal').scrollTop=0;}")
                    source_shot = ARTIFACTS / f"itinerary-import-source-{label}.png"
                    page.screenshot(path=str(source_shot)); screenshots.append(str(source_shot))
                    ready_preview(keep_source=True)
                    prompt = network.ai_requests[-1]["prompt"]
                    record_check("AI receives all selected and appended files", all(marker in prompt for marker in ["TXT來源標記", "Markdown來源標記", "Dadaocheng", "追加來源標記"]))
                    images = network.ai_requests[-1]['images']
                    record_check("all image and scanned PDF attachments share one Codex request", len(network.ai_requests) == 1 and [image['name'] for image in images] == ['第四份.png', '第五份掃描.pdf'] and all(image['dataBase64'] and image['page'] == 1 for image in images) and all(name in prompt for name in ['第四份.png', '第五份掃描.pdf']))
                    record_check("import always uses Codex without altering the global provider", page.evaluate("!CodexLocal.selected() && localStorage.aiProvider==='deepseek'") and not network.deepseek_requests)
                    preview_before = page.locator("#itineraryImportPreview").text_content()
                    page.locator("#itinerarySourceFile").set_input_files([
                        {"name": "不應部分加入.txt", "mimeType": "text/plain", "buffer": "這份不能部分寫入".encode("utf-8")},
                        {"name": "本批毀損.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.7 invalid"},
                    ])
                    page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                    record_check("failed batch keeps all earlier source and preview", page.locator("#itinerarySourceText").input_value() == merged and page.locator("#itineraryImportPreview").text_content() == preview_before and page.locator("#itinerarySaveButton").is_enabled())
                    record_check("failed batch identifies offending filename", "本批毀損.pdf" in page.locator("#itineraryImportError").inner_text())
                    info_before = page.locator('#itineraryFileInfo').text_content()
                    page.evaluate("""() => {window.importOriginalReader=ItineraryFile;window.importReaderCalls=0;window.ItineraryFile={...ItineraryFile,read:(...args)=>{window.importReaderCalls++;return window.importOriginalReader.read(...args);}};} """)
                    page.locator('#itinerarySourceFile').set_input_files([
                        {'name': '不可先讀的正常檔.txt', 'mimeType': 'text/plain', 'buffer': b'first file'},
                        {'name': 'a' * 197 + '.txt', 'mimeType': 'text/plain', 'buffer': b'too long'},
                    ])
                    page.wait_for_function("!isBusy && document.getElementById('itineraryImportError').textContent.includes('200')")
                    page.evaluate('() => {window.ItineraryFile=window.importOriginalReader;delete window.importOriginalReader;}')
                    record_check('201-character filename rejects the entire batch before reading', page.evaluate('window.importReaderCalls === 0') and page.locator('#itinerarySourceText').input_value() == merged and page.locator('#itineraryFileInfo').text_content() == info_before and page.locator('#itineraryImportPreview').text_content() == preview_before and page.locator('#itinerarySaveButton').is_enabled() and saved_state() == original_state)
                    for boundary in ['count', 'bytes']:
                        page.evaluate("""kind => {window.importOriginalReader=ItineraryFile;const dataBase64=kind==='bytes'?'A'.repeat(2796200):'AAAA';window.ItineraryFile={...ItineraryFile,read:async()=>({text:'不應加入的附件文字',format:'pdf',pages:1,warnings:[],images:Array.from({length:kind==='bytes'?11:59},()=>({mime:'image/png',page:1,dataBase64}))})};} """, boundary)
                        source_file('附件超限.pdf', b'%PDF mock', 'application/pdf')
                        page.wait_for_function("!isBusy && document.getElementById('itineraryImportError').textContent.includes('20 MiB')")
                        page.evaluate('() => {window.ItineraryFile=window.importOriginalReader;delete window.importOriginalReader;}')
                        record_check(f"aggregate image {boundary} limit preserves earlier source and candidate", page.locator('#itinerarySourceText').input_value() == merged and page.locator('#itineraryFileInfo').text_content() == info_before and page.locator('#itineraryImportPreview').text_content() == preview_before and page.locator('#itinerarySaveButton').is_enabled())
                    page.evaluate("""() => {window.importOriginalReader=ItineraryFile;window.importLateReadResolved=false;window.ItineraryFile={...ItineraryFile,read:()=>new Promise(resolve=>{window.importReleaseReader=()=>resolve({text:'取消後不得加入',format:'image',pages:null,warnings:[],images:[{mime:'image/png',page:1,dataBase64:'AAAA'}]});}).then(result=>{window.importLateReadResolved=true;return result;})};} """)
                    page.locator('#itinerarySourceFile').set_input_files({'name': '取消的圖片.png', 'mimeType': 'image/png', 'buffer': image_png.read_bytes()})
                    page.wait_for_function('isBusy')
                    page.locator('#itineraryImportCancel').click()
                    page.evaluate('() => {window.importReleaseReader();window.ItineraryFile=window.importOriginalReader;delete window.importOriginalReader;}')
                    page.wait_for_function('!isBusy && window.importLateReadResolved')
                    record_check('cancelled preparation discards late attachments and keeps source preview', page.locator('#itinerarySourceText').input_value() == merged and page.locator('#itineraryFileInfo').text_content() == info_before and page.locator('#itineraryImportPreview').text_content() == preview_before and page.locator('#itinerarySaveButton').is_enabled() and saved_state() == original_state)
                    ready_preview(keep_source=True)
                    record_check('failed attachment batches leave original images available', [image['name'] for image in network.ai_requests[-1]['images']] == ['第四份.png', '第五份掃描.pdf'])
                    page.locator("#itinerarySourceText").fill("原文" * 14500)
                    before_limit = page.locator("#itinerarySourceText").input_value()
                    source_file("合併超限.txt", ("追加" * 1000).encode("utf-8"))
                    page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                    record_check("merged text limit rejects without truncating source", page.locator("#itinerarySourceText").input_value() == before_limit)
                    page.locator("#itineraryClearFiles").click()
                    record_check("clear resets source and preview without changing trips", page.locator("#itinerarySourceText").input_value() == "" and page.locator("#itinerarySaveButton").is_disabled() and saved_state() == original_state)
                    page.evaluate("""dataBase64 => {window.importOriginalReader=ItineraryFile;window.ItineraryFile={...ItineraryFile,read:async()=>({text:'',format:'pdf',pages:60,warnings:[],images:Array.from({length:60},(_,i)=>({mime:'image/png',page:i+1,dataBase64}))})};} """, base64.b64encode(image_png.read_bytes()).decode('ascii'))
                    source_file('旅' * 196 + '.pdf', b'%PDF prepared fixture', 'application/pdf')
                    page.evaluate('() => {window.ItineraryFile=window.importOriginalReader;delete window.importOriginalReader;}')
                    page.locator('#itinerarySourceText').fill('旅' * 30000)
                    ready_preview(keep_source=True)
                    large_prompt = network.ai_requests[-1]['prompt']
                    record_check('30000 Chinese characters with 60 image source names reach Codex despite exceeding old byte cap', len(large_prompt) <= 60000 and len(json.dumps({'prompt': large_prompt}, ensure_ascii=False).encode('utf-8')) > 120000 and len(network.ai_requests[-1]['images']) == 60 and page.locator('#itinerarySaveButton').is_enabled() and saved_state() == original_state)
                    page.locator('#itineraryClearFiles').click()
                    source_file("第一份.txt", TEXT.encode("utf-8"))
                    record_check("same file can be selected again after clearing", "大稻埕" in page.locator("#itinerarySourceText").input_value())
                    before_files = page.locator("#itinerarySourceText").input_value()
                    page.locator("#itinerarySourceFile").set_input_files([{"name": f"第{i}份.txt", "mimeType": "text/plain", "buffer": b"day 1"} for i in range(11)])
                    page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                    record_check("file-count limit rejects entire selection", page.locator("#itinerarySourceText").input_value() == before_files)
                    page.locator('#itineraryClearFiles').click()
                    source_file('全空白.pdf', blank_pdf.read_bytes(), 'application/pdf')
                    record_check('blank PDF prepares an image without OCR or persistence', page.locator('#itinerarySourceText').input_value() == '' and page.locator('#itineraryParseButton').is_enabled() and not network.ocr_requests and saved_state() == original_state)
                    network.result = {'error': '來源沒有可讀行程，請提供其他檔案。'}
                    page.locator('#itineraryParseButton').click()
                    page.wait_for_function("!isBusy && document.getElementById('itineraryImportError').textContent.includes('沒有可讀行程')")
                    record_check('Codex empty-document error preserves source attachment and stored journeys', len(network.ai_requests[-1]['images']) == 1 and '全空白.pdf' in page.locator('#itineraryFileInfo').text_content() and page.locator('#itinerarySaveButton').is_disabled() and saved_state() == original_state)
                    for reviews, message in [([], '來源核對未完成'), ([{'index': 1, 'status': 'unreadable', 'message': '活動名稱看不清楚'}], '已停止另存')]:
                        network.result = {**response(), 'sourceReviews': reviews}
                        page.locator('#itineraryParseButton').click()
                        page.wait_for_function('!isBusy && document.getElementById("itineraryImportError").textContent.includes(' + json.dumps(message) + ')')
                        record_check(message + ' blocks saving partial results', page.locator('#itinerarySaveButton').is_disabled() and saved_state() == original_state)
                    network.result = {**response(), 'sourceReviews': [{'index': 1, 'status': 'uncertain', 'message': '09:00 活動提醒字跡不清'}]}
                    page.locator('#itineraryParseButton').click()
                    page.wait_for_function('!isBusy && !document.getElementById("itinerarySaveButton").disabled')
                    record_check('uncertain field renders source and page warning without dropping activities', '全空白.pdf」第 1 頁' in page.locator('#itineraryImportPreview').text_content() and '09:00 活動提醒字跡不清' in page.locator('#itineraryImportPreview').text_content() and page.locator('#itineraryImportPreview li').count() == 3)
                    page.locator('#itineraryClearFiles').click()
                    source_file('第一份.txt', TEXT.encode('utf-8'))
                    local_request_count = len(network.ai_requests)
                    for name, content, mime in [
                        ("毀損.pdf", b"%PDF-1.7\nnot a valid document", "application/pdf"),
                        ("empty.txt", b" \n\t", "text/plain"),
                        ("不支援.docx", b"PK mock word document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                        ("太大.txt", b"a" * (12 * 1024 * 1024), "text/plain"),
                    ]:
                        source_file(name, content, mime)
                        page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                        record_check(name + " rejected without persistence", saved_state() == original_state and page.locator("#itinerarySaveButton").is_disabled())
                    record_check("all file parsing uses no extra AI requests", len(network.ai_requests) == local_request_count)
                    ready_preview()
                    record_check('clearing sources removes every previous attachment from the request', network.ai_requests[-1]['images'] == [])
                    record_check("AI preview does not persist", saved_state() == original_state)
                    record_check("preview renders source values safely", PAYLOAD in page.locator("#itineraryImportPreview").inner_text() and page.locator("#itineraryImportPreview img").count() == 0 and not page.evaluate("Boolean(window.importXss)"))
                    record_check("preview shows activities", "大稻埕" in page.locator("#itineraryImportPreview").inner_text() and "植物園" in page.locator("#itineraryImportPreview").inner_text())
                    record_check("repeated dates merge into two days and three stops", page.locator("#itineraryImportPreview details").count() == 2 and page.locator("#itineraryImportPreview li").count() == 3)
                    merged_preview = page.locator("#itineraryImportPreview").text_content()
                    record_check("merged stop retains descriptions and notes from both files", all(text in merged_preview for text in ["觀察紅磚建築", "入口處領取地圖", MERGED_NOTE, "第二份來源備註", SOURCE_WARNING]))
                    conflict = response()
                    conflict["days"].append({"date": START, "day_title": "不同站次", "itinerary": [
                        {"title": "大稻埕街區", "time": "15:00", "type": "SPOT", "address": "台北市大同區迪化街"},
                        {"title": "大稻埕街區", "time": "09:00", "type": "SPOT", "address": "台北市另一集合地址"},
                    ]})
                    ready_preview(conflict)
                    record_check("same title at different time or address stays separate", page.locator("#itineraryImportPreview details").count() == 2 and page.locator("#itineraryImportPreview li").count() == 5)
                    record_check("conflicting repeat identifies all source alternatives", all(text in page.locator("#itineraryImportPreview").text_content() for text in ["15:00", "另一集合地址", "09:00"]))
                    page.locator("#itinerarySourceText").fill(TEXT + "補充：帶雨傘")
                    record_check("editing source invalidates stale preview", page.locator("#itinerarySaveButton").is_disabled())
                    network.result = {"error": "來源缺少可確認的日期。"}
                    page.locator("#itineraryParseButton").click()
                    page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                    record_check("AI semantic error keeps original trips", saved_state() == original_state and page.locator("#itinerarySaveButton").is_disabled())
                    invalid_results = []
                    invalid = response(); invalid["days"][0]["date"] = "2026-02-30"; invalid_results.append(("invalid date", invalid))
                    invalid = response(); invalid["days"][0]["itinerary"][0]["time"] = "29:99"; invalid_results.append(("invalid time", invalid))
                    invalid_results.append(("missing days", {"city": "台北", "days": []}))
                    invalid = response(); invalid["days"] = [sample_day((date(2026, 11, 1) + timedelta(days=i)).isoformat()) for i in range(16)]; invalid_results.append(("too many days", invalid))
                    for field in ["summary", "desc", "cost"]:
                        for kind, malformed in [("object", {"unexpected": "資料不應被靜默清空"}), ("array", ["資料不應被靜默清空"])]:
                            invalid = response()
                            target = invalid["days"][0] if field == "summary" else invalid["days"][0]["itinerary"][0]
                            target[field] = malformed
                            invalid_results.append((f"{kind} {field}", invalid))
                    for name, invalid in invalid_results:
                        network.result = invalid
                        page.locator("#itineraryParseButton").click()
                        page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                        record_check(name + " rejected atomically", saved_state() == original_state and page.locator("#itinerarySaveButton").is_disabled())
                    network.result = response(); network.hold_ai = True
                    page.locator("#itineraryParseButton").click()
                    page.wait_for_function("isBusy")
                    record_check("AI request locks journey switching", page.locator("#tripSelect").is_disabled())
                    page.locator("#itineraryImportCancel").click()
                    idle(); network.hold_ai = False; network.release()
                    record_check("cancelled AI cannot save or mutate trips", saved_state() == original_state and page.locator("#itinerarySaveButton").is_disabled())
                    ready_preview(shuffled_response())
                    times = page.locator("#itineraryImportPreview details").first.locator("li > strong").all_text_contents()
                    record_check("shuffled file fragments preview in 09 12 18 then unknown order", len(times) == 4 and all(text.startswith(time) for text, time in zip(times, ["09:00", "12:00", "18:00", "時間待補"])))
                    record_check("unknown time retains source activity with an ordering warning", "時間未定的補充活動" in page.locator("#itineraryImportPreview").text_content() and "有時間活動之後" in page.locator("#itineraryImportPreview").text_content())
                    contrast = page.locator("#itineraryImportPreview summary").first.evaluate("""e=>{const rgb=c=>c.match(/[\\d.]+/g).slice(0,3).map(Number);const lum=c=>rgb(c).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[0.2126,0.7152,0.0722][i],0);const s=getComputedStyle(e),a=lum(s.color),b=lum(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}""")
                    record_check("preview dates have readable text contrast", contrast >= 4.5)
                    for test_width in ([1440] if label == "desktop" else [390, 320]):
                        page.set_viewport_size({"width": test_width, "height": 950})
                        record_check(f"{test_width}px modal has no horizontal overflow", not overflow(page)["overflow"] and page.locator("#itineraryImportModal .modal-content").evaluate("e=>e.scrollWidth<=e.clientWidth+1"))
                    page.set_viewport_size({"width": width, "height": 950})
                    page.evaluate("() => { window.scrollTo(0,0); document.getElementById('itineraryImportModal').scrollTop=0; }")
                    page.locator("#itineraryPreviewSection").evaluate("e=>e.scrollIntoView({block:'start'})")
                    shot = ARTIFACTS / f"itinerary-import-preview-{label}.png"
                    page.screenshot(path=str(shot)); screenshots.append(str(shot))
                    page.evaluate("""() => {window.importRealSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='tourismTrips_v1')throw new Error('quota');return importRealSetItem.call(this,k,v);};} """)
                    page.locator("#itinerarySaveButton").click()
                    page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                    record_check("storage quota failure preserves complete original library", saved_state() == original_state)
                    page.evaluate("() => {Storage.prototype.setItem=importRealSetItem;}")
                    with page.expect_navigation(wait_until="load"):
                        page.locator("#itinerarySaveButton").click()
                    idle()
                    stored = json.loads(saved_state())
                    record_check("save appends exactly one new journey", len(stored["trips"]) == 2 and stored["activeId"] != original["id"])
                    record_check("original data and Undo remain byte-equivalent", stored["trips"][0] == original)
                    current = next(t for t in stored["trips"] if t["id"] == stored["activeId"])
                    record_check("saved days normalized chronologically", [d["date"] for d in current["data"]["t"]] == [START, "2026-11-11"])
                    saved_days = current["data"]["t"]
                    saved_first = saved_days[0]["itinerary"][0]
                    record_check("saved duplicate activity remains merged", [len(day["itinerary"]) for day in saved_days] == [4, 1])
                    record_check("saved shuffled activities preserve chronological order", [item["time"] for item in saved_days[0]["itinerary"]] == ["09:00", "12:00", "18:00", ""])
                    record_check("saved merged details keep both sources", "觀察紅磚建築" in saved_first["desc"] and "入口處領取地圖" in saved_first["desc"] and MERGED_NOTE in saved_first["tips"])
                    record_check("source warnings and day notes persist in journey", SOURCE_WARNING in saved_days[0]["summary"] and "第二份來源備註" in saved_days[0]["summary"])
                    record_check("new journey has no borrowed Undo or progress", current["undo"] is None and current["data"]["p"]["done"] == [])
                    page.reload(wait_until="networkidle")
                    record_check("new itinerary survives reload", page.evaluate("tripData.length===2 && tripData[0].itinerary[0].title==='大稻埕街區'"))
                    record_check("merged source notes and warnings survive reload", page.evaluate("tripData[0].summary.includes('午餐只收現金') && tripData[0].itinerary[0].tips.includes('北側入口集合') && tripData[0].itinerary.length===4"))
                    record_check("reloaded trip starts at 09 rather than the first file dinner", page.evaluate("tripData[0].itinerary[0].time==='09:00' && tripData[0].itinerary.at(-1).time===''") )
                    page.locator("#travelModeButton").click()
                    page.locator("#journeyDate").select_option(START)
                    record_check("travel mode first pending stop follows chronological order", page.locator(".journey-stop").first.locator("h3").inner_text() == "大稻埕街區" and "09:00" in page.locator(".journey-stop").first.inner_text())
                    page.locator("#travelModeButton").click()
                    record_check("no stored HTML executes on rendering", not page.evaluate("Boolean(window.importXss)"))
                    open_import(); ready_preview()
                    other = context.new_page(); other.on("dialog", lambda d: d.accept())
                    other.goto(base, wait_until="networkidle")
                    other.evaluate("""() => {const i=TripLibrary.active().data.i;i.city='另一分頁更新';TripLibrary.write({tripDraft_v27:JSON.stringify(i)},{inputs:true,label:'另一分頁'});} """)
                    updated = saved_state()
                    page.locator("#itinerarySaveButton").click()
                    page.wait_for_function("!isBusy && document.getElementById('itineraryImportError').textContent.includes('另一個分頁')")
                    record_check("stale-tab import cannot overwrite new data", saved_state() == updated)
                    other.close(); page.reload(wait_until="networkidle")
                    if label == "desktop":
                        page.evaluate("""() => {const records=Array.from({length:18},(_,i)=>({name:'容量測試'+i,data:{i:{},t:[],g:null}}));TripLibrary.importCollection({format:'tourism-library',version:1,trips:records},true);} """)
                        page.reload(wait_until="networkidle")
                        full_state = saved_state()
                        open_import()
                        page.locator("#itinerarySourceText").fill(TEXT)
                        page.locator("#itineraryParseButton").click()
                        page.wait_for_function("!isBusy && !!document.getElementById('itineraryImportError').textContent.trim()")
                        record_check("20-journey limit preserves library", saved_state() == full_state and len(json.loads(full_state)["trips"]) == 20)
                    record_check("no uncaught browser exceptions", not errors)
                    record_check('no DeepSeek fallback or local OCR requests occur', not network.deepseek_requests and not network.ocr_requests)
                except Exception as exc:
                    failures.append({"viewport": label, "error": str(exc), "trace": traceback.format_exc(), "page_errors": errors})
                    shot = ARTIFACTS / f"itinerary-import-failure-{label}.png"
                    page.screenshot(path=str(shot), full_page=True); screenshots.append(str(shot))
                finally:
                    context.close()
            browser.close()
    finally:
        server.shutdown()
    report = {"checks": checks, "failures": failures, "screenshots": screenshots, "passed": not failures and all(c["passed"] for c in checks), "limits": ["Codex import responses are mocked; no real account quota or vision model quality was tested.", "Chromium mobile viewports are emulation, not physical-phone verification.", "PDF and PNG fixtures are prepared as real attachments; no local OCR or DeepSeek requests are allowed."]}
    report_path = ARTIFACTS / "itinerary-import-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
