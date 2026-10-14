(function (root) {
    'use strict';

    const ENDPOINT = 'https://api.deepseek.com/chat/completions';
    const MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);
    const DEFAULT_TIMEOUT_MS = 120000;

    class DeepSeekError extends Error {
        constructor(message, code, status) {
            super(message);
            this.name = 'DeepSeekError';
            this.code = code;
            if (status !== undefined) this.status = status;
        }
    }

    function httpError(status) {
        const messages = {
            400: 'DeepSeek 拒絕請求，請檢查模型與行程內容。',
            401: 'DeepSeek API Key 無效，請重新檢查金鑰。',
            402: 'DeepSeek 帳戶餘額不足，請至官方平台確認。',
            403: 'DeepSeek 拒絕存取，請確認 API Key 權限。',
            422: 'DeepSeek 無法處理這份行程內容，請調整後再試。',
            429: 'DeepSeek 請求過於頻繁，請稍後再試。',
            500: 'DeepSeek 服務暫時發生錯誤，請稍後再試。',
            503: 'DeepSeek 服務忙碌中，請稍後再試。'
        };
        return new DeepSeekError(messages[status] || `DeepSeek 請求失敗（HTTP ${status}）。`, 'HTTP', status);
    }

    async function generate({ key, model = MODELS[0], prompt, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        if (typeof key !== 'string' || !key.trim()) {
            throw new DeepSeekError('請先設定 DeepSeek API Key。', 'KEY');
        }
        if (!MODELS.includes(model)) {
            throw new DeepSeekError('請選擇支援的 DeepSeek 模型。', 'MODEL');
        }
        if (typeof prompt !== 'string' || !prompt.trim()) {
            throw new DeepSeekError('請先提供行程內容。', 'PROMPT');
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
            throw new DeepSeekError('API 等待時間設定無效。', 'TIMEOUT_CONFIG');
        }
        if (signal && signal.aborted) {
            throw new DeepSeekError('已取消 DeepSeek 請求。', 'CANCELLED');
        }

        const controller = new AbortController();
        let timedOut = false;
        const cancel = () => controller.abort();
        if (signal) signal.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        try {
            // Never retry automatically: an interrupted POST may already have been billed.
            const response = await fetch(ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key.trim()}`
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model,
                    messages: [
                        {
                            role: 'system',
                            content: '請依使用者指定的 JSON 欄位與範例，僅回傳有效的 JSON 物件，不要 Markdown 程式碼框或額外說明。旅遊內容使用臺灣繁體中文。'
                        },
                        { role: 'user', content: prompt }
                    ],
                    response_format: { type: 'json_object' },
                    thinking: { type: 'disabled' },
                    max_tokens: 8192,
                    stream: false
                })
            });

            if (!response.ok) throw httpError(response.status);

            let data;
            try {
                data = await response.json();
            } catch (error) {
                if (controller.signal.aborted) throw error;
                throw new DeepSeekError('DeepSeek 回應格式異常，尚未儲存這次結果。', 'RESPONSE');
            }

            const choice = data && Array.isArray(data.choices) && data.choices[0];
            if (data && data.error) {
                throw new DeepSeekError('DeepSeek 回報服務錯誤，尚未儲存這次結果。', 'RESPONSE');
            }
            if (choice && choice.finish_reason === 'length') {
                throw new DeepSeekError('DeepSeek 回覆超過長度限制，請減少景點或內容後再試。這次結果未儲存。', 'LENGTH');
            }
            if (choice && choice.finish_reason === 'content_filter') {
                throw new DeepSeekError('DeepSeek 未能回覆這份內容，請調整行程描述後再試。', 'CONTENT_FILTER');
            }
            if (!choice || choice.finish_reason !== 'stop' || !choice.message || typeof choice.message.content !== 'string') {
                throw new DeepSeekError('DeepSeek 回應不完整，尚未儲存這次結果。', 'RESPONSE');
            }
            const content = choice.message.content.trim();
            if (!content) {
                throw new DeepSeekError('DeepSeek 回傳空白內容，請調整行程描述後再試。', 'EMPTY');
            }

            let result;
            try {
                result = JSON.parse(content);
            } catch {
                throw new DeepSeekError('DeepSeek 未回傳有效的 JSON，尚未儲存這次結果。請調整行程內容後再試。', 'JSON');
            }
            if (!result || typeof result !== 'object') {
                throw new DeepSeekError('DeepSeek 回傳的 JSON 不是行程物件。', 'JSON');
            }
            return result;
        } catch (error) {
            if (timedOut) {
                throw new DeepSeekError('DeepSeek 回應逾時，這次結果未儲存。請稍後自行重試；請求可能已計費。', 'TIMEOUT');
            }
            if (signal && signal.aborted) {
                throw new DeepSeekError('已取消 DeepSeek 請求。', 'CANCELLED');
            }
            if (error instanceof DeepSeekError) throw error;
            // Do not surface provider bodies or browser error details: they may contain credentials.
            throw new DeepSeekError('無法連線至 DeepSeek，請確認網路連線與瀏覽器存取設定。', 'NETWORK');
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', cancel);
        }
    }

    const client = Object.freeze({ generate, MODELS, DEFAULT_TIMEOUT_MS, DeepSeekError });
    if (typeof module === 'object' && module.exports) module.exports = client;
    else root.DeepSeekClient = client;
})(typeof globalThis !== 'undefined' ? globalThis : window);
