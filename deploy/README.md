# 個人 Oracle 雲端版

這是使用自己的 OpenAI API Key 的私人網站，所有生成與管理功能仍需要網站登入。
GitHub Pages、本機版仍維持原本的服務與儲存行為。

## 部署結構

- Ubuntu 24.04、E2.1.Micro；`scripts/bootstrap-oracle.sh` 安裝 Node.js 24.18.0 與 Codex CLI 0.162.1。
- 目前不需要 Codex CLI 登入。登入網站後，在「服務與資料設定」儲存 OpenAI API Key；儲存於 `/var/lib/roam/openai.json`，權限 0600。不要加入 Git、發布前端或放進旅程備份。
- Caddy 處理 HTTPS、自動憑證續期與轉送到 `127.0.0.1:8090`。目前設定使用 sslip.io 對應主機 IP 的網域，依賴該公共 DNS 服務；主機 IP 改變時需更新網域與設定。
- `cloud-server.cjs` 保護規劃器與管理 API；只有 `/s/<48位隨機碼>` 提供免登入的唯讀小冊。帳號固定 `roam`，密碼必須由密碼學安全亂數產生，至少 24 bytes，再以 SHA-256 儲存摘要；此摘要方式不適用自選短密碼。
- `/etc/roam/cloud.env`（root、600）需包含 `ROAM_ORIGIN=https://你的網域` 與 `ROAM_PASSWORD_SHA256=密碼的64位十六進位摘要`，不包含 ChatGPT token。
- `deploy/roam-cloud.service` 以非 root 的 ubuntu 帳號啟動、禁止提權、限制檔案寫入、記憶體與程序數；停止服務時一併停止所有子程序。
- 8090 與 Caddy 管理埠 2019 只在 loopback 監聽，不應新增對外規則。

## 安裝與更新

先將 `scripts/deploy-oracle.sh` 上傳至 `/home/ubuntu/deploy-oracle.sh`。它需要 SSH 使用者另外上傳下列兩個檔案：

1. `/home/ubuntu/roam-release-YYYYMMDD-HHMMSS.tgz`：封裝 `scripts/build-pages.cjs` 的明確前端清單，加上 `openai-api.cjs`、`codex-import.cjs`、`cloud-server.cjs`、`book-shares.cjs`、`codex-bridge.cjs`、`codex-usage.cjs`、`codex-images.cjs`、`image-jobs.cjs`、`scripts/build-pages.cjs`、`deploy/Caddyfile`、`deploy/roam-cloud.service`。不得打包整個工作目錄或憑證。
2. `/home/ubuntu/roam-cloud.env`：上述環境設定。此檔目前會保留，systemd 的 `InaccessiblePaths` 明確遮蔽它；若要刪除它，須先調整該路徑設定。

先確認原始碼測試通過、Caddy 網域與 ROAM_ORIGIN 一致，再執行：

```sh
sudo bash /home/ubuntu/deploy-oracle.sh YYYYMMDD-HHMMSS
```

腳本在第一次安裝時新增 2 GiB swap（使用既有開機磁碟，不另建磁碟）、安裝官方 Caddy 套件，保留既有設定備份，安裝獨立 release，再切換 `/opt/roam/current`。切換後會重新啟動服務，更新前先等待生成結束。

Oracle 公用子網路安全清單需允許 Stateful TCP 80 與 443；腳本另外在 OS 防火牆新增同樣兩個埠並儲存規則，必須確認 `netfilter-persistent` 已啟用。不要清空 Oracle 原有防火牆或開放全部連接埠。

## 使用與限制

### 行程插圖

新版服務單元設定 `ROAM_IMAGE_DIR=/var/lib/roam/images`，將工作紀錄與圖片放在既有 `StateDirectory=roam` 中，更新 release 後仍保留。部署時必須一併更新服務單元設定；不設定時會使用專案目錄下的 `.roam-images`，在唯讀 release 環境可能無法保存。備份圖片目錄時與分享目錄一樣視為私人資料，不放入靜態清單或版本控制。

`POST /codex/images` 建立具識別碼的單張工作；`GET /codex/images/<id>` 讀狀態，`GET /codex/images/<id>/image` 讀成品，`POST /codex/images/<id>/cancel` 停止工作。全部需要私人網站登入與 token，寫入另驗證 Origin；生圖與文字規劃共用單一工作鎖及每小時 60 次生成上限。相同識別碼不重送，重啟後未完成工作標記中斷。

插圖由 `openai-api.cjs` 呼叫 OpenAI Images API（`gpt-image-1.5`），以目前設定的 API Key 計費。模擬測試不代表真實帳戶生圖驗收。圖片可透過含圖 JSON 備份換裝置；本功能不提供旅程同步。

### 小冊分享

在雲端版的行程頁按「建立分享網址」，再到「分享小冊管理」複製網址。旅伴用 Safari 或 Chrome 開啟即可翻頁，不需登入。這是建立當下的行程與便利貼副本，沒有 API Key、生成權限或其他行程；修改原行程後需重新建立分享。管理清單跨裝置與重新整理保留，空白行程也能管理既有分享。本機版及 GitHub Pages 不提供分享儲存，可先匯出 JSON 到雲端版匯入。

「取消分享」移除伺服器上的副本，後續開啟或重新整理原網址會顯示失效頁。已開啟、下載或截圖的內容無法收回。任何取得網址的人都能閱讀，網址不設自動到期；不再需要時請取消。

- `GET /api/shares`、`POST /api/shares`、`DELETE /api/shares/<id>` 需原有 Basic 登入；寫入另驗證 Origin 與 CSRF token。分享不依賴 Codex 登入、不呼叫 AI。
- `book-shares.cjs` 使用 24 bytes 密碼學亂數網址、每份 HTML 上限 5 MiB、最多 50 份分享，每小時最多 30 次建立請求。管理清單不傳回完整 HTML。
- 分享 HTML 由伺服器設定 CSP sandbox（不含 allow-same-origin）、禁止網路資源載入、禁止嵌入、no-store、no-referrer、noindex。翻頁程式和圖片內嵌；地圖連結另開視窗。CSP 隔離依據：[MDN sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)。
- systemd 以 `StateDirectory=roam` 建立 `/var/lib/roam`，權限 0700，`ROAM_SHARE_DIR=/var/lib/roam/shares`。此位置獨立於 release，更新／重啟保留分享；備份此目錄即可備份分享，勿納入公開網站檔案或 Git。自行啟動 Node 時可設定 `ROAM_SHARE_DIR`，未設定則使用專案的 `.roam-shares`。
- 驗證：`node --test tests/cloud-server.test.cjs`、`python tests/book_sharing_smoke.py`。後者使用隔離的本機後端，測試 Chromium／WebKit 桌機與手機尺寸、免登入翻頁、快照、取消分享與 CSP，不使用真實行程或生成額度；不等於實體 iPhone 驗收。

瀏覽器先輸入網站帳密，頁面偵測到 API 後端後預設選用 OpenAI API；尚無金鑰時顯示設定欄位。`POST /codex/settings` 需要原有登入、Origin 與 token，驗證成功後才原子替換金鑰檔；無法從 API 讀回金鑰。GitHub Pages 不會連接此私人後端。

生成仍逐日進行，完成一天才儲存一天，最後開啟第一頁。家用電腦可關閉，但手機瀏覽器需保持頁面開啟；不是離開頁面仍保證完成的背景排程。取消或斷線後可手動接續，已送出的額度不保證退還。

同時間只允許一個生成工作，每小時最多 60 次生成請求；API 錯誤不自動重送，也不退回 ChatGPT 訂閱額度。

服務設定透過 OpenAI `/v1/models` 與本站支援清單的交集提供 API 模型選項，最多快取 30 秒；生成仍受 API 專案權限限制。預設行程請求使用 Responses API，圖片輸入保留來源名稱與頁碼。

API 模式不顯示訂閱百分比。行程 Token 來自 Responses API 的 usage；圖片及中斷請求可能未計入本分頁統計，實際費用以 OpenAI 平台帳單為準。

行程仍存在各裝置瀏覽器，沒有自動雲端同步。換網址或手機前先匯出 JSON；網站密碼與 API Key不包含在旅程備份。

## 驗證與維護

```sh
systemctl is-active roam-cloud caddy
systemctl is-enabled roam-cloud caddy netfilter-persistent
sudo journalctl -u roam-cloud -n 30 --no-pager
```

本機執行 `npm test` 與 `python tests/codex_smoke.py` 不會消耗真實額度。Linux 上另執行 `node --test tests/linux-cancel.test.cjs`，以假 CLI 驗證父子程序取消。

`python tests/openai_api_smoke.py` 驗證 API 設定與草稿保留（模擬 API）。舊版 `python tests/codex_usage_smoke.py` 僅驗證桌機／手機尺寸的額度、模型、記住選擇、缺失資料及 Token 累計。加上 `--credentials <受保護JSON檔>` 時讀取真實雲端額度／模型，但生成仍使用 fixture，不消耗生成額度。官方資料格式參考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

`tests/cloud_live_smoke.py --credentials <工作目錄外的受保護JSON檔>` 會透過真實 HTTPS 呼叫生成後端並消耗所設定服務的額度產生兩日旅遊書，僅供明確手動驗收。JSON 需有 `url`、`username`、`password`；測試不記錄其內容。天氣與匯率為模擬資料，手機尺寸測試不代表實體手機驗收。

參考：[官方遠端登入](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)、[Caddy HTTPS](https://caddyserver.com/docs/automatic-https)、[Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)。Always Free 有容量與閒置回收條件，不是永久可用性保證。
