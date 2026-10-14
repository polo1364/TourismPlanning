# TourismPlanning

繁體中文旅遊規劃工具，以純 HTML、CSS、JavaScript 執行。支援一次產生整本旅遊書、AI 微調、地圖連結、費用估算、圖片與文字匯出，以及 JSON 備份。

## 啟動

公開版：[開啟 ROAM 旅遊書](https://polo1364.github.io/TourismPlanning/)。GitHub Pages 生成需填入自己的 DeepSeek API Key；Codex 額度可使用下方本機版，或自行部署受登入保護的個人 Oracle 版（見 [雲端部署說明](deploy/README.md)）。公開頁面不會連接本機 Codex，也不會自動切換生成服務。不同網址與裝置的行程不共用儲存空間，請先匯出 JSON 再匯入。

## GitHub Pages 部署

`main` 更新後，`.github/workflows/pages.yml` 會執行 Node 測試，透過 `npm run build:pages` 打包，再發布到 GitHub Pages。儲存庫 Settings → Pages 的 Source 使用 **GitHub Actions**。

建置以明確清單輸出 20 個前端檔案及 `.nojekyll`，共 21 個檔案至 `dist/`，包含前端、插畫與 Motion 授權；不發布本機服務、測試報告、備份或憑證。為避免混入舊檔，`dist/` 已存在時建置會停止；重跑前請先將舊 `dist/` 移至備份位置。GitHub Actions 每次使用新的工作目錄。

來源儲存庫保留本機啟動程式及測試，方便下載使用。更新與部署狀態可在儲存庫 Actions 查看；部署方式參考 [GitHub Pages 官方文件](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

## 本機啟動

在專案資料夾開啟 PowerShell，使用 Python 3 啟動本機服務：

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

瀏覽器開啟 [http://127.0.0.1:8080](http://127.0.0.1:8080)，終止服務按 `Ctrl+C`。DeepSeek 模式不需要 Node 套件或建置流程；本機 Codex 模式另需下方的連接服務。

也可直接雙擊 `index.html`。瀏覽器對 `file://` 的儲存空間、剪貼簿與外部請求權限可能不同；建議使用上述本機服務。剪貼簿不可用時，文字匯出會改成下載 `.txt`。圖片匯出需要連網載入 html2canvas，多天匯出可能需要允許多檔下載。

## 使用 Codex 額度（本機個人版）

網頁可透過本機官方 Codex CLI 使用 ChatGPT 登入的 Codex 額度，不需要 OpenAI API Key，也不會自動切到 API 計費或 DeepSeek。這不會帶入目前 Codex 對話的歷史或記憶；每次把旅行需求送入獨立的生成工作。用量與你的 Codex 共用額度，額度不足會停止並保留已完成內容。登入與計費方式見 [OpenAI 官方驗證說明](https://learn.chatgpt.com/docs/auth)。

1. 電腦需有 Node.js、Python 3 與官方 Codex CLI。本次確認版本為 Node.js 24.18.0、Codex CLI 0.162.1。
2. 使用 `codex login` 登入 ChatGPT；`codex login status` 應顯示 `Logged in using ChatGPT`。
3. 雙擊 `啟動Codex旅遊書.vbs`，以隱藏視窗啟動網頁與連接服務；網址仍是 `http://127.0.0.1:8080/`，原有行程儲存位置不變。
4. 開啟「服務與資料設定」，選「本機 Codex · 使用現有額度」，按「檢查本機 Codex 連線」，儲存後即可生成整本旅遊書、取得景點建議或微調。尚未儲存服務偏好時，偵測到已登入的本機連接會自動選 Codex；已有偏好則保留。

若已開啟網頁服務，只需另開終端執行 `npm run codex:bridge`，以 `Ctrl+C` 結束前景連接服務。連接綁定 `127.0.0.1:8081`，只接受來自 `http://127.0.0.1:8080` 或 `http://localhost:8080` 的網頁，並驗證每次啟動的請求權杖；`file://`、其他連接埠與實體手機不能直接使用這個本機模式。權杖只留在頁面記憶體，不是 Codex 登入憑證。

`codex-bridge.cjs` 透過 stdin 呼叫官方 `codex exec`，不把需求拼入 shell 指令，不讀取或傳出 Codex 憑證檔。生成預設使用 CLI 預設模型，也可在服務設定選擇目前 Codex 提供的模型；後端驗證模型白名單。執行時忽略使用者自訂工具設定，以暫存空目錄、唯讀沙箱及關閉 shell、外掛、連接應用、瀏覽器與多代理工具執行；不提供即時網路查證。每次呼叫上限 180 秒，不自動重送；取消或逾時會終止該次本機程序，但不保證服務端已消耗的額度返還。整本生成仍逐日儲存、顯示進度並可接續。

此連接供個人本機使用，不可直接暴露成公開或商業託管服務；公開服務應另整合官方 [Sign in with ChatGPT](https://developers.openai.com/siwc)，確認註冊與授權資格，不能共享你的本機登入憑證。參見 [Codex 整合的驗證範圍](https://learn.chatgpt.com/docs/app-server#auth-endpoints)。

驗證指令：

```powershell
npm test
python tests/codex_smoke.py
```

上述測試不消耗真實額度。`tests/codex_live_smoke.py` 是需明確手動執行的實際 Codex 驗證：使用獨立瀏覽器與示範一天行程，會消耗 Codex 額度，天氣及匯率仍為固定測試回應；不會修改日常瀏覽器的旅程。報告為 `artifacts/codex-report.json` 與 `artifacts/codex-live-report.json`。

## DeepSeek 設定

1. 開啟右上方服務設定，選擇 DeepSeek API，填入自己的 API Key；專案沒有內建金鑰。
2. 選擇 DeepSeek Flash 或 DeepSeek V4 Pro，儲存設定。
3. 填寫目的地、日期和偏好，按「產生整本旅遊書」，自動安排每一天，完成後直接從第一頁翻閱。

金鑰由瀏覽器直接送至 DeepSeek 官方 API，不經本專案的後端。未勾選記住金鑰時，使用目前分頁的工作階段儲存；勾選後才存入該瀏覽器的本機儲存空間。備份不包含金鑰。舊 Gemini 金鑰不會自動當作 DeepSeek 金鑰使用。

截至 2026-10-14，使用官方文件列出的 `deepseek-flash` 與 `deepseek-v4-pro`，端點為 `https://api.deepseek.com/chat/completions`，使用 JSON 輸出與非思考模式。單次請求最多等待 120 秒，失敗不自動重送；逾時的請求可能已計費。參見 [DeepSeek 模型說明](https://api-docs.deepseek.com/quick_start/pricing/) 與 [JSON 輸出文件](https://api-docs.deepseek.com/guides/json_mode/)。

## 儲存與備份

行程與偏好保留原本的 `myTrip_v27`、`tripDraft_v27`、`generationState_v27` 儲存名稱。新版 JSON 備份包含旅程設定、已生成行程與續生狀態；仍可匯入舊版 `{ i, t }` 備份，但舊備份沒有續生資訊。匯入前會檢查格式並要求確認取代，檔案上限 5 MB。

瀏覽器、本機網址、連接埠或 `file://` 改變時，儲存空間通常不共用。切換開啟方式前，先於設定下載 JSON 備份，再到新網址匯入。原始程式備份保留在 `index.html.bak.*`，它不是使用者行程備份。

## 驗證指令

Node.js 內建測試，不需安裝 npm 套件：

```powershell
node --test tests/app.test.cjs tests/deepseek.test.cjs
node --check deepseek.js
```

瀏覽器測試需要 Python 的 Playwright 與 Chromium；未安裝時可執行：

```powershell
python -m pip install playwright
python -m playwright install chromium
python tests/browser_smoke.py --mode smoke
```

測試會自行啟動本機測試伺服器，把外部 API 替換為固定回應，並將結果與截圖寫入 `artifacts/`。這些測試不會發出真實付費生成請求；實際 DeepSeek 付費 API 生成仍待使用有效金鑰驗證。天氣、匯率和 AI 內容也不因模擬測試通過而代表現場資訊已核實。

真實圖片匯出另有獨立測試，使用固定行程與 CDN 的 html2canvas，不呼叫付費 AI：

```powershell
python -m pip install pillow
python tests/export_smoke.py
```

瀏覽器操作報告在 `artifacts/smoke-report.json`；圖片匯出報告在 `artifacts/export-report.json`，附實際 A4 與手機 JPG。版面驗證使用 Chromium 桌機／手機尺寸，尚未在實體手機驗收。

## Motion 互動介面

已安裝 [Motion](https://github.com/motiondivision/motion) `14.2.0`，版本固定於 `package.json` 與 `package-lock.json`。介面使用 Motion 原生 DOM 動畫實作頁面進場、行程卡片更新、可中斷的每日展開／收合、設定視窗開關及按鈕回饋。鍵盤操作保留即時反應，並遵循系統的「減少動態效果」。

瀏覽器載入本地 `vendor/motion.js`，不依賴 Motion CDN；已包含 MIT 授權。`motion-ui.js` 負責互動動畫，圖片匯出前會完成並清理動畫，以免截到半透明或裁切的內容。Motion 載入失敗時，基本操作仍可使用。

要還原開發依賴或同步本地瀏覽器套件：

```powershell
npm ci --ignore-scripts
npm run sync:motion
npm run check:motion
npm test
python tests/motion_smoke.py
```

`check:motion` 會比對已安裝套件與本地副本的 SHA-256；動畫測試結果在 `artifacts/motion-report.json`。一般使用直接開啟頁面即可，不需先安裝 Node 套件。

## 旅程工作區與單站編輯

- 桌機與手機都以「輸入旅行需求／閱讀旅遊書」切換；開始生成會顯示行程與進度，已有行程重新載入後直接顯示旅遊書。輸入與閱讀是兩個獨立畫面。
- 住宿及旅行偏好預設收合；住宿說明可另行展開。原有住宿勾選與地址會保留，缺少必要住宿資料時會展開並聚焦該欄位。
- 行程以時間軸顯示開始／結束時間、停留時間、抵達本站的預估移動時間及下一站。停留時間依已填起訖時間或時長計算；資訊不足時標示待補或待確認，不猜測移動時間。
- 每站的「編輯這一站」可修改名稱、時間、類型、地址、費用與說明。上移、下移及刪除會立即儲存，日期與其他站點時間不變；每天至少保留一站。
- 「用 AI 替換這一站」只替換選定站點，保留原時間。改變地點或順序後，相鄰交通資訊會清除，避免沿用不相符的路線；請補填或重新確認移動時間。
- 生成、整日微調及單站替換可取消；已儲存資料會保留。整本生成中斷後，按「繼續完成旅遊書」會從未完成日期接續到最後一天；整日微調及單站替換仍只重試該步驟。取消本機等待不保證服務端停止處理或計費。
- 「出發前檢查」提示時間重疊、順序不一致、重複景點、已知移動時間不足與超出預算。可在行程頁更新本行程預算，不必重新生成。預算依目的地幣別與已列費用比較，不換算混合幣別，也不包含未列費用。

合理性檢查只檢視已填資料，不能證明行程實際可行。營業時間、路線、交通耗時及票價未經即時查證；舊備份缺少停留或移動時間時，會明示檢查範圍不足。新欄位隨原本的 JSON 備份儲存，仍可匯入舊備份。

新增功能測試（外部 API 使用固定回應，不產生付費 AI 請求）：

```powershell
npm test
python tests/planner_smoke.py
```

`planner-checks.js` 負責純資料檢查，`planner-ui.js` 負責工作區、單站編輯與生成狀態。報告在 `artifacts/planner-report.json`，畫面在 `artifacts/planner-settings-*.png` 與 `artifacts/planner-itinerary-*.png`。

## 多份旅程、復原與旅途中模式

頁首「旅程收藏」可跳至頁尾的「我的旅程」，在此新增及切換旅程。「管理與備份」提供複製、重新命名、移除、備份全部與匯入。每份旅程各自保存設定、生成內容、續生資料及完成勾選；複製保留規劃內容，但重設完成勾選與復原紀錄。最多保存 20 份，實際容量仍受瀏覽器限制，不會自動刪除舊旅程騰出空間。

第一次開啟會將既有單份旅程納入收藏。資料仍保存在目前瀏覽器，沒有雲端同步；請使用「備份全部」下載所有旅程。完整備份匯入會新增旅程，不覆蓋收藏。設定視窗的「備份目前旅程」僅備份當前旅程；舊版單份 JSON 仍可匯入，會取代當前旅程，並清除沒有包含在備份中的完成勾選。兩種備份都不含 API Key，也不包含復原紀錄。

「復原上一步」會恢復當前旅程最近一次成功的行程或完成勾選變更，包括生成、單站／整日修改、排序、刪站、預算與完成勾選。清空目前旅程或匯入單份備份也可復原，這兩種操作會一併還原當時的設定。一般設定輸入、日期選擇與模式切換不占用復原紀錄；一般行程復原保留最新設定草稿。每份旅程僅保留一步，重新載入與切換後仍可使用；復原後沒有重做功能。重新命名與移除整份旅程不在此範圍，移除前會確認，最後一份旅程不能移除。

「旅途中模式」顯示選定日期、第一個未完成站點、下一個未完成站點與當日勾選清單，導航連結會開啟 Google Maps。日期預設使用裝置日期；若不在旅程日期內，會選擇下一個行程日或最後一天並顯示「旅程預覽」。可手動指定日期或按「依今天選擇」。此模式不追蹤 GPS，也不依現在時間推斷實際所在地；導航需要網路及地圖服務。改動活動名稱、開始時間、地址或類型後，該站需重新勾選；僅排序未改動內容的站點會保留勾選。

生成或儲存期間不能切換旅程或執行復原。儲存失敗會保留原資料；偵測到其他分頁更新後，過期分頁的寫入會被拒絕，請重新整理再操作。這是避免舊資料覆蓋的保護，不是多人即時協作。

資料由 `trip-store.js` 管理，介面與旅途清單由 `trip-library.js` 管理。`tourismTrips_v1` 是旅程收藏，原本的三個儲存名稱作為目前旅程的相容資料；啟動時以收藏還原目前旅程。格式無效的收藏或舊資料不會自動覆寫。

```powershell
npm test
python tests/journeys_smoke.py
```

新流程報告：`artifacts/journeys-report.json`。畫面：`artifacts/journeys-library-*.png` 與 `artifacts/journeys-travel-*.png`。測試使用隔離的瀏覽器資料及模擬 API，不會修改使用者已存旅程或發出付費 AI 請求。

## 旅行刊物介面與跨流程檢查

`editorial.css` 保留先前墨藍、朱紅、紙色及票券式日序的底層樣式，目前由後載入的 `book.css` 覆蓋為深藍／青綠電子書外觀。旅程總覽顯示已規劃天數、站點與日期索引；點選日期會開啟對應日並把鍵盤焦點移至該日。出發前檢查預設收合，提醒數仍可見，展開後可查看衝突與更新預算。原有 Motion、匯出及工作區切換保留。

費用只加總可辨識的單一金額或價格區間平均值；已識別的混合幣別、多人／多條件價格、負數及無金額項目不計入，保留原文字並顯示計算範圍提醒。單價未標幣別時仍視為目的地幣別；城市不在現有識別範圍時會顯示「待確認」，不再預設日圓或換算台幣。這是估算，不會推斷人數或自動轉換混合幣別；自由文字辨識有限，仍須核對各站原文。

透過「更新預算」送出的變更可以復原，包含沒有續生設定的舊備份；復原預算時保留其他最新設定草稿。整日微調重試固定使用失敗時的日期與需求，不受後來開啟其他微調視窗影響。旅途中模式保留生成進度與取消入口。

```powershell
python tests/audit_smoke.py
```

本次缺陷、驗證範圍與前後畫面見 `AUDIT.md`；跨流程報告位於 `artifacts/audit-report.json`。

## 插畫封面與動態

頁首可切換「海岸日光／街巷夜色」，並同步改變旅程總覽的封面；尚未建立行程時，另一幅插畫會顯示為明信片。兩張圖都是原創旅行意象，不代表所選目的地的實景。圖片由內建 imagegen 生成，儲存在本機 `assets/`，完整提示詞與尺寸見 [素材說明](assets/README.md)。原始 PNG 合計約 6.2 MB，首次載入需要讀取這些圖片。

桌機滑鼠移動有輕微頁首背景視差，明信片滑過時略微抬起；觸控裝置不啟用視差。目前電子旅遊書版面使用精簡頁首，隱藏先前的紙飛機裝飾。可用「封面動態」關閉封面與明信片的效果，系統的「減少動態效果」優先；翻頁、行程與對話框的 Motion 互動另依減少動態規則運作。封面風格與動態偏好儲存在本瀏覽器，不更動旅程或復原紀錄。圖片失敗時仍可閱讀標題與操作設定，封面控制腳本失敗時則保留靜態海岸封面並隱藏控制。

`scenes.css` 提供插畫樣式，`book.css` 套用目前的電子書版面，`scene-ui.js` 管理插畫風格、動態與偏好。驗證使用隔離的 Chromium 資料、模擬 API，以及 320／390／760／900／1440 px 寬度；手機為瀏覽器模擬，未經實體手機驗收。

```powershell
python tests/scenes_smoke.py
```

報告在 `artifacts/scenes-report.json`；截圖包含 `scene-empty-desktop.png`、`scene-town-desktop.png`、`scene-empty-mobile.png`、`scene-itinerary-mobile.png` 與 `scene-travel-mobile.png`，皆位於 `artifacts/`。

## 科技風電子旅遊書

首頁優先顯示自由文字旅行需求，再填目的地、日期及其他設定；「慢旅行／在地美食／親子同行」可加入需求而不覆蓋已填內容。城市與日期仍須填入對應欄位，不會從文字自動推斷。按「產生整本旅遊書」後，自動依序安排全部日期（1 至 15 天），每一天延續既有偏好、前一天的地點及已安排景點；每天成功儲存後更新整體進度，完成後開啟第一章。

整本生成會逐日呼叫 API，不是把所有天數塞進單次回應。進度百分比代表已儲存天數，不是預估剩餘時間。失敗、取消或儲存失敗會停止後續請求並保留已儲存的日期；按「繼續完成旅遊書」才會接續未完成部分，重新整理不會自行送出請求。重新生成若第一天就失敗，保留原本整份行程；若已成功儲存新行程，則保留這次已完成的天數。整次生成共用一個復原步驟；每次手動接續會建立新的復原點，回到接續前的內容。整本完成時會退出旅途中模式，保留閱讀方式偏好，直接顯示旅遊書。

預設為「逐日翻閱」：一天一個章節，桌機並排顯示插畫章節封面與站點時間軸，手機改為直向閱讀。日期目錄與上一頁／下一頁可切換章節，進度條顯示目前閱讀位置；翻頁工具列取得焦點時可用左右方向鍵。滑鼠翻頁使用 Motion 的輕微位移及淡入，鍵盤與減少動態設定不觸發翻頁動畫。「連續閱讀」保留全部日卡與展開／收合操作，閱讀方式會記住於本瀏覽器；目前頁次不跨重新載入保存。

翻頁不修改旅程資料。整本生成或接續完成後會開啟第一章，編輯與復原會盡量保留目前日期；若復原後該日已不存在，會回到有效頁次。切換旅程從第一頁開始。重新生成等待第一天時仍可閱讀原本的章節；此時取消會保留原內容及所在頁。旅途中模式會隱藏翻頁工具，返回完整行程後恢復目前章節。原有單站編輯、AI 微調、多旅程、一步復原及匯出功能保留。

`book-ui.js` 只管理閱讀狀態與現有章節的顯示，資料仍由原有儲存及生成模組管理。圖片是旅行意象，不是每個城市的實景。這次沒有新增雲端同步或呼叫真實付費 DeepSeek API。

```powershell
npm test
npm run check:motion
python tests/book_smoke.py
python tests/whole_book_smoke.py
```

電子書流程測試見 `artifacts/book-report.json`；畫面為 `artifacts/book-home-desktop.png`、`book-home-mobile.png`、`book-chapter-desktop.png`、`book-chapter-mobile.png` 及 `book-spread-*.png`。其他資料／編輯回歸使用連續閱讀模式，逐日翻閱由 `book_smoke.py` 覆蓋，包含生成、編輯、復原、取消、15 天章節、長標題及五種螢幕寬度。

整本生成由 `whole_book_smoke.py` 在桌機與手機尺寸實際點擊操作，涵蓋進度、1／3／15 天、取消、API 失敗、儲存失敗、重新載入接續、批次復原及完成後翻頁。結果見 `artifacts/whole-book-report.json`，畫面見 `artifacts/whole-book-progress-*.png` 與 `whole-book-complete-*.png`。既有資料／編輯測試會直接呼叫單日生成函式建立未完成行程，用於驗證中途儲存點；不以這些測試取代整本生成的 UI 測試。
