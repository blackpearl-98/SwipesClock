// SwipeClock — consent-gated MAIN-world response observer.
// It stays idle until the isolated content script confirms the user opted in.

(function () {
  'use strict';

  const INTERESTING_RE = /(swipe|attendance|punch)/i;
  const TIME_KEYS = ['punchDateTime', 'swipeDateTime', 'timestamp', 'swipeTime', 'punchTime', 'time', 'actualTime'];
  const DIRECTION_KEYS = ['inOutIndicator', 'inOut', 'inOutStatus', 'direction', 'indicator', 'swipeType', 'punchType', 'type', 'status'];
  const DATE_KEYS = ['date', 'swipeDate', 'attendanceDate', 'punchDate'];
  let active = false;
  let originalFetch = null;
  let originalOpen = null;
  let originalSend = null;

  function emitPayload(url, payload) {
    if (!active || !payload || typeof payload !== 'object') return;
    const swipes = extractMinimalSwipes(payload);
    if (!swipes.length) return;
    const parsed = new URL(url, window.location.href);
    window.postMessage(
      { source: 'SWIPECLOCK_NET', url: parsed.pathname + parsed.search, payload: swipes },
      window.location.origin
    );
  }

  function firstDefined(object, keys) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null) {
        return object[key];
      }
    }
    return undefined;
  }

  function extractMinimalSwipes(payload) {
    const records = [];
    const visited = new Set();

    function walk(node, depth, inheritedDate) {
      if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1, inheritedDate));
        return;
      }

      const date = firstDefined(node, DATE_KEYS) || inheritedDate;
      const time = firstDefined(node, TIME_KEYS);
      const direction = firstDefined(node, DIRECTION_KEYS);
      if (time !== undefined && direction !== undefined) {
        const swipe = { time, direction };
        if (date !== undefined) swipe.date = date;
        records.push(swipe);
        return;
      }

      Object.keys(node).forEach((key) => walk(node[key], depth + 1, date));
    }

    walk(payload, 0, undefined);
    return records;
  }

  function isRelevantSameOrigin(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.origin === window.location.origin && INTERESTING_RE.test(parsed.pathname + parsed.search);
    } catch (_e) {
      return false;
    }
  }

  function startObserving() {
    if (active) return;
    active = true;

    if (typeof window.fetch === 'function') {
      originalFetch = window.fetch;
      window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = originalFetch.apply(this, arguments);
      if (isRelevantSameOrigin(url)) {
        promise.then((res) => {
          try {
            if (!res || !res.ok) return;
            const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (!ct.includes('json')) return;
            res.clone().json().then((data) => emitPayload(url, data)).catch(() => {});
          } catch (_e) {}
        }).catch(() => {});
      }
      return promise;
      };
    }

    if (typeof XMLHttpRequest !== 'undefined') {
      originalOpen = XMLHttpRequest.prototype.open;
      originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (_method, url) {
        this.__swipeClockUrl = String(url || '');
        return originalOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function () {
        const url = this.__swipeClockUrl || '';
        if (isRelevantSameOrigin(url)) {
          this.addEventListener('load', function () {
            try {
              if (this.status >= 200 && this.status < 300 && this.responseText) {
                const trimmed = this.responseText.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                  emitPayload(url, JSON.parse(trimmed));
                }
              }
            } catch (_e) {}
          });
        }
        return originalSend.apply(this, arguments);
      };
    }
  }

  function stopObserving() {
    if (!active) return;
    active = false;
    if (originalFetch) window.fetch = originalFetch;
    if (typeof XMLHttpRequest !== 'undefined') {
      if (originalOpen) XMLHttpRequest.prototype.open = originalOpen;
      if (originalSend) XMLHttpRequest.prototype.send = originalSend;
    }
    originalFetch = null;
    originalOpen = null;
    originalSend = null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'SWIPECLOCK_CONTROL') return;
    if (event.data.action === 'START') startObserving();
    if (event.data.action === 'STOP') stopObserving();
  });
})();
