// SwipeClock — consent-gated greytHR swipe reader.
// It reads greytHR data only after the user opts in from the popup.

(function () {
  'use strict';

  const TIME_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?)\b/i;
  const DIR_RE = /\b(IN|OUT|SIGN[\s-]?IN|SIGN[\s-]?OUT)\b/i;
  const ROW_SELECTOR = 'tr, .swipe-row, [class*="swipe-item"], [class*="swipe-row"], [class*="punch"]';

  let lastSerialized = '';
  let apiFetchInFlight = null;
  let apiAbortController = null;
  let syncEnabled = false;
  let observer = null;
  let debounceTimer = null;
  let refreshTimer = null;

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function buildRequestHeaders() {
    const headers = { Accept: 'application/json' };
    const xsrf = getCookie('XSRF-TOKEN') || getCookie('xsrf-token');
    if (xsrf) {
      headers['x-xsrf-token'] = xsrf;
    }
    return headers;
  }

  function saveSwipesToCache(swipes) {
    if (!syncEnabled || !Array.isArray(swipes) || swipes.length === 0) return;
    const serialized = JSON.stringify(swipes);
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;

    const todayKey = window.SwipeClockCalc.getLocalDateKey();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set(
        {
          greythrSwipesCache: {
            date: todayKey,
            swipes
          }
        },
        () => {
          if (chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'SWIPES_UPDATED' });
          }
        }
      );
    }
  }

  function rememberWorkingEndpoint(url) {
    if (!syncEnabled || !url || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin) return;
      const template = parsed.pathname + parsed.search.replace(/\d{4}-\d{2}-\d{2}/g, '{DATE}');
      chrome.storage.local.set({ greythrWorkingEndpoint: template });
    } catch (_e) {}
  }

  /**
   * Recursively walks document + all open shadowRoot trees (used by greytHR v3 Stencil/Angular components).
   */
  function querySelectorAllDeep(root, selector, results) {
    const out = results || [];
    if (!root || !root.querySelectorAll) return out;

    const matched = root.querySelectorAll(selector);
    for (let i = 0; i < matched.length; i++) {
      out.push(matched[i]);
    }

    const allNodes = root.querySelectorAll('*');
    for (let i = 0; i < allNodes.length; i++) {
      const node = allNodes[i];
      if (node.shadowRoot) {
        querySelectorAllDeep(node.shadowRoot, selector, out);
      }
    }
    return out;
  }

  function scrapeGreytHRSwipes() {
    const rows = querySelectorAllDeep(document, ROW_SELECTOR, []);
    const found = [];
    const seen = new Set();

    rows.forEach((row, index) => {
      if (row.children && row.children.length > 12) return;
      const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 6 || text.length > 160) return;

      const timeMatch = text.match(TIME_RE);
      const dirMatch = text.match(DIR_RE);
      if (!timeMatch || !dirMatch) return;

      const sec = window.SwipeClockCalc.parseTimeToSeconds(timeMatch[1]);
      if (sec === null) return;

      const normalizedTime = window.SwipeClockCalc.formatClock(sec, '24h', true);
      const direction = dirMatch[1].toUpperCase().includes('OUT') ? 'OUT' : 'IN';
      const key = normalizedTime + '|' + direction;
      if (seen.has(key)) return;
      seen.add(key);

      found.push({
        id: 'gt-' + index + '-' + sec,
        time: normalizedTime,
        direction
      });
    });

    return found.sort(
      (a, b) =>
        (window.SwipeClockCalc.parseTimeToSeconds(a.time) || 0) -
        (window.SwipeClockCalc.parseTimeToSeconds(b.time) || 0)
    );
  }

  function getSavedEndpoint() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get(['greythrWorkingEndpoint'], (res) => {
        resolve((res && res.greythrWorkingEndpoint) || null);
      });
    });
  }

  /**
   * Fetches today's swipes from greytHR's same-origin API after the user opts in.
   */
  async function fetchSwipesFromGreytHRApi() {
    if (!syncEnabled) return [];
    if (apiFetchInFlight) return apiFetchInFlight;

    const controller = new AbortController();
    apiAbortController = controller;
    apiFetchInFlight = (async () => {
      const todayKey = window.SwipeClockCalc.getLocalDateKey();
      const savedTemplate = await getSavedEndpoint();

      const candidateUrls = [];
      if (savedTemplate) {
        candidateUrls.push(savedTemplate.replace(/\{DATE\}/g, todayKey));
      }
      candidateUrls.push(
        '/v3/api/attendance/info/swipes?date=' + todayKey,
        '/v3/api/attendance/swipes?date=' + todayKey,
        '/v3/api/attendance/info?fromDate=' + todayKey + '&toDate=' + todayKey,
        '/v3/api/attendance/calendar/day?date=' + todayKey,
        '/v3/api/ess/attendance/swipes?date=' + todayKey,
        '/api/v2/attendance/swipes?date=' + todayKey
      );

      const uniqueUrls = Array.from(new Set(candidateUrls));
      const headers = buildRequestHeaders();

      for (const path of uniqueUrls) {
        if (!syncEnabled) return [];
        try {
          const res = await fetch(window.location.origin + path, {
            method: 'GET',
            credentials: 'include',
            headers,
            signal: controller.signal
          });
          if (!syncEnabled) return [];
          if (!res.ok) continue;
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (!ct.includes('json')) continue;
          const json = await res.json();
          if (!syncEnabled) return [];
          const swipes = window.SwipeClockCalc.extractSwipesFromApiPayload(json, todayKey);
          if (swipes.length > 0) {
            rememberWorkingEndpoint(path);
            saveSwipesToCache(swipes);
            return swipes;
          }
        } catch (_err) {
          // Try next endpoint quietly
        }
      }
      return [];
    })().finally(() => {
      apiFetchInFlight = null;
      if (apiAbortController === controller) apiAbortController = null;
    });

    return apiFetchInFlight;
  }

  function syncSwipesFromDom() {
    if (!syncEnabled) return [];
    const swipes = scrapeGreytHRSwipes();
    if (swipes.length > 0) {
      saveSwipesToCache(swipes);
    }
    return swipes;
  }

  function handleNetworkMessage(event) {
    if (event.source !== window || !event.data) return;
    if (event.data.source === 'SWIPECLOCK_NET' && event.data.payload) {
      let parsedUrl;
      try { parsedUrl = new URL(event.data.url, window.location.origin); } catch (_e) { return; }
      if (parsedUrl.origin !== window.location.origin) return;
      const todayKey = window.SwipeClockCalc.getLocalDateKey();
      const swipes = window.SwipeClockCalc.extractSwipesFromApiPayload(event.data.payload, todayKey);
      if (swipes.length > 0) {
        rememberWorkingEndpoint(parsedUrl.href);
        saveSwipesToCache(swipes);
      }
    }
  }

  function enableSync() {
    if (syncEnabled) return;
    syncEnabled = true;
    window.addEventListener('message', handleNetworkMessage);
    window.postMessage({ source: 'SWIPECLOCK_CONTROL', action: 'START' }, window.location.origin);
    syncSwipesFromDom();
    setTimeout(fetchSwipesFromGreytHRApi, 800);
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') fetchSwipesFromGreytHRApi();
    }, 60000);
    observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(syncSwipesFromDom, 350);
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  function disableSync() {
    if (!syncEnabled) return;
    syncEnabled = false;
    if (apiAbortController) apiAbortController.abort();
    apiAbortController = null;
    window.removeEventListener('message', handleNetworkMessage);
    window.postMessage({ source: 'SWIPECLOCK_CONTROL', action: 'STOP' }, window.location.origin);
    clearTimeout(debounceTimer);
    clearInterval(refreshTimer);
    if (observer) observer.disconnect();
    observer = null;
    lastSerialized = '';
  }

  // This listener is the only work done before consent. It does not read page data.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'SWIPECLOCK_DISABLE_SYNC') {
        disableSync();
        sendResponse({ enabled: false });
        return false;
      }

      if (message && message.type === 'GET_GREYTHR_SWIPES') {
        chrome.storage.local.get(['swipeClockConsent'], (res) => {
          if (!res || res.swipeClockConsent !== true) {
            sendResponse({ swipes: [], sourceKind: 'none', consentRequired: true });
            return;
          }
          enableSync();
          const domSwipes = syncSwipesFromDom();
          if (domSwipes.length > 0) {
            sendResponse({ swipes: domSwipes, sourceKind: 'dom' });
            return;
          }
          fetchSwipesFromGreytHRApi()
            .then((apiSwipes) => sendResponse({ swipes: apiSwipes, sourceKind: 'api' }))
            .catch(() => sendResponse({ swipes: [], sourceKind: 'none' }));
          });
        return true;
      }
    });
  }

  chrome.storage.local.get(['swipeClockConsent'], (res) => {
    if (res && res.swipeClockConsent === true) enableSync();
  });
})();
