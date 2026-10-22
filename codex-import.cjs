'use strict';
// Attachment validation for the authenticated itinerary-import route only.
const MAX_BODY = 29 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 60;
const TIMEOUT = 180000;
const fail = (message, code = 'IMPORT_IMAGE', status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function imageDimensions(bytes, mime) {
    let width = 0, height = 0;
    if (mime === 'image/png') {
        if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw fail('附件不是有效 PNG 圖片。');
        width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
        // Only accept a complete still-image PNG container, not an arbitrary header.
        let position = 8, hasData = false, ended = false;
        while (position + 12 <= bytes.length) {
            const length = bytes.readUInt32BE(position);
            if (length > bytes.length - position - 12) throw fail('PNG 附件已損毀。');
            const kind = bytes.toString('ascii', position + 4, position + 8);
            if (kind === 'acTL') throw fail('請將動態圖片轉為單張 PNG 或 JPEG。');
            if (kind === 'IDAT') hasData = true;
            position += length + 12;
            if (kind === 'IEND') { ended = length === 0 && position === bytes.length; break; }
        }
        if (!hasData || !ended) throw fail('PNG 附件不完整。');
    } else if (mime === 'image/jpeg') {
        if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw fail('附件不是有效 JPEG 圖片。');
        let position = 2, hasScan = false;
        while (position + 3 < bytes.length) {
            if (bytes[position++] !== 255) throw fail('JPEG 附件已損毀。');
            while (bytes[position] === 255) position++;
            const marker = bytes[position++];
            if (marker === 217) break;
            if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
            if (position + 2 > bytes.length) throw fail('JPEG 附件已損毀。');
            const length = bytes.readUInt16BE(position);
            if (length < 2 || position + length > bytes.length) throw fail('JPEG 附件已損毀。');
            if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
                if (length < 8 || width || height) throw fail('JPEG 附件尺寸無效。');
                height = bytes.readUInt16BE(position + 3); width = bytes.readUInt16BE(position + 5);
            }
            if (marker === 218) { hasScan = true; break; }
            position += length;
        }
        if (!hasScan) throw fail('JPEG 附件不完整。');
    } else throw fail('附件只支援 PNG 或 JPEG。');
    if (!width || !height || width > 12000 || height > 12000 || width * height > 24000000) throw fail('附件圖片超過 2400 萬像素、單邊 12,000 像素，或尺寸無效。', 'IMPORT_DIMENSIONS');
    return { width, height };
}

function validateImport(body) {
    if (!plain(body) || Object.keys(body).some(key => !['prompt', 'model', 'images'].includes(key))) throw fail('匯入請求格式無效。', 'BODY');
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 60000) throw fail('請提供有效旅行需求。', 'PROMPT');
    if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 150)) throw fail('模型選擇無效。', 'MODEL');
    if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES) throw fail('一次最多傳送 60 張行程圖片。', 'IMPORT_IMAGES');
    let total = 0;
    const images = body.images.map(image => {
        if (!plain(image) || Object.keys(image).some(key => !['name', 'mime', 'dataBase64', 'page'].includes(key))
            || typeof image.name !== 'string' || !image.name.trim() || image.name.length > 200
            || /[\\/:\x00-\x1f\x7f]/.test(image.name) || /^\.{1,2}$/.test(image.name)
            || (image.page !== undefined && (!Number.isSafeInteger(image.page) || image.page < 1 || image.page > 60))) throw fail('附件名稱、頁碼或格式無效。');
        if (!['image/png', 'image/jpeg'].includes(image.mime) || typeof image.dataBase64 !== 'string' || !image.dataBase64.length) throw fail('附件只支援 PNG 或 JPEG 圖片資料。');
        const encoded = image.dataBase64;
        if (encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw fail('每張附件最多 2 MiB。', 'IMPORT_SIZE', 413);
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fail('附件 Base64 格式無效。');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw fail('附件 Base64 格式無效。');
        total += bytes.length;
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_BYTES) throw fail('每張附件最多 2 MiB，合計最多 20 MiB。', 'IMPORT_SIZE', 413);
        imageDimensions(bytes, image.mime);
        return { name: image.name, mime: image.mime, page: image.page, bytes };
    });
    return images;
}

module.exports = { validateImport, imageDimensions, MAX_BODY, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, MAX_IMAGES, TIMEOUT };
