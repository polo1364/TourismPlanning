(function (root) {
    'use strict';
    function minutes(value) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
        return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : null;
    }
    function timing(item) {
        const range = String(item.time || '').split(/\s*[-–—~～]\s*/);
        const start = minutes(range[0]);
        const explicitEnd = minutes(item.endTime || range[1]);
        const duration = Number.isFinite(item.durationMinutes) && item.durationMinutes > 0 ? item.durationMinutes : null;
        const end = explicitEnd ?? (start !== null && duration ? start + duration : null);
        return { start, end, duration: start !== null && end !== null && end > start ? end - start : null };
    }
    function inspect(days, { budget = 0, totalCost = 0 } = {}) {
        const issues = [];
        const seen = new Map();
        let missingTime = 0, missingTravel = 0;
        const add = (code, message, day, item) => issues.push({ code, message, day, item });
        days.forEach((day, di) => {
            let latestEnd = null, previousStart = null;
            day.itinerary.forEach((item, ii) => {
                const label = `${day.date} · ${item.title}`;
                const { start, end, duration } = timing(item);
                if (start === null || duration === null) missingTime++;
                if (start !== null) {
                    if (end !== null && (end <= start || end > 1440)) add('INVALID_TIME', `${label}：結束時間必須晚於開始，跨日活動請拆至隔天。`, di, ii);
                    if ((latestEnd !== null && start < latestEnd) || (previousStart !== null && start < previousStart)) {
                        add('OVERLAP', `${label}：時間重疊或順序與時間不一致。`, di, ii);
                    }
                    if (ii > 0) {
                        const previous = timing(day.itinerary[ii - 1]);
                        if (Number.isFinite(item.travelMinutes) && item.travelMinutes >= 0 && previous.end !== null) {
                            if (start - previous.end < item.travelMinutes) add('TRAVEL', `${label}：與上一站的間隔不足預估移動 ${item.travelMinutes} 分鐘。`, di, ii);
                        } else missingTravel++;
                    }
                    previousStart = start;
                    latestEnd = Math.max(latestEnd ?? 0, end !== null && end > start ? end : start);
                } else if (ii > 0) missingTravel++;
                if (item.type !== 'TRANSPORT') {
                    const key = String(item.title).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
                    if (seen.has(key)) add('DUPLICATE', `${label}：與 ${seen.get(key)} 重複，請確認是否有意再次安排。`, di, ii);
                    else seen.set(key, day.date);
                }
            });
        });
        if (Number.isFinite(budget) && budget > 0 && totalCost > budget) add('BUDGET', `已列費用 ${totalCost.toLocaleString()} 超出旅程預算 ${budget.toLocaleString()}（同一目的地幣別）。`, null, null);
        return { issues, missingTime, missingTravel };
    }
    const api = Object.freeze({ minutes, timing, inspect });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlannerChecks = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
