(function () {
    'use strict';
    let opening;
    const MAX_BACKUP = 100 * 1024 * 1024;
    function database() {
        if (!opening) opening = new Promise((resolve, reject) => {
            const request = indexedDB.open('roamArtwork_v1', 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('assets', { keyPath: 'id' });
                request.result.createObjectStore('jobs', { keyPath: 'key' });
            };
            request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
            request.onerror = () => { opening = null; reject(new Error('無法開啟圖片儲存空間，請確認瀏覽器權限。')); };
        });
        return opening;
    }
    async function transaction(store, mode, work) {
        const db = await database();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, mode);
            let result;
            tx.oncomplete = () => resolve(result?.result);
            tx.onabort = tx.onerror = () => reject(new Error('圖片儲存失敗，原行程與已存圖片保留。請檢查可用空間。'));
            try { result = work(tx.objectStore(store)); } catch (error) { tx.abort(); reject(error); }
        });
    }
    const get = id => transaction('assets', 'readonly', store => store.get(id));
    const job = key => transaction('jobs', 'readonly', store => store.get(key));
    function reserveJob(key, subject, replaceId) {
        return transaction('jobs', 'readwrite', store => {
            const result = {}, request = store.get(key);
            request.onsuccess = () => {
                if (request.result && request.result.id !== replaceId) result.result = request.result;
                else {
                    result.result = { key, subject, id: crypto.randomUUID() };
                    store.put(result.result);
                }
            };
            return result;
        });
    }
    const put = values => transaction('assets', 'readwrite', store => { for (const value of values) store.put(value); });
    function dataBlob(data) {
        if (typeof data !== 'string' || data.length > 28 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(data)) throw new Error('圖片格式無效，只接受 PNG、JPEG、WebP。');
        const [header, base64] = data.split(',');
        const raw = atob(base64), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
        const mime = header.slice(5, -7);
        const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
        const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
        if (!(mime === 'image/png' && png || mime === 'image/jpeg' && jpg || mime === 'image/webp' && webp)) throw new Error('圖片內容與格式不符。');
        return new Blob([bytes], { type: mime });
    }
    async function decoded(data) {
        const picture = await createImageBitmap(dataBlob(data));
        if (!picture.width || !picture.height || picture.width * picture.height > 25000000) { picture.close(); throw new Error('圖片尺寸無效或過大。'); }
        return picture;
    }
    async function compress(data, width = 1440, quality = .82) {
        const picture = await decoded(data);
        try {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(width, picture.width);
            canvas.height = Math.max(1, Math.round(picture.height * canvas.width / picture.width));
            const context = canvas.getContext('2d');
            context.fillStyle = '#fbf6ea'; context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(picture, 0, 0, canvas.width, canvas.height);
            return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height };
        } finally { picture.close(); }
    }
    async function validateImage(data) {
        const image = await decoded(data);
        const dimensions = { width: image.width, height: image.height };
        image.close(); return dimensions;
    }
    window.TripArtworkStore = Object.freeze({ get, put, job, reserveJob, compress, validateImage, MAX_BACKUP });
})();
