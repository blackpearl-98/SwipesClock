// SwipeClock — Background Service Worker
// Keeps the Chrome toolbar badge updated with today's effective hours (e.g. "6.2h" or "OK").

function getLocalDateKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function updateBadgeFromCache() {
  chrome.storage.local.get(['swipeClockConsent'], (consentRes) => {
    if (!consentRes || consentRes.swipeClockConsent !== true) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    const todayKey = getLocalDateKey();
    chrome.storage.local.get(['greythrSwipesCache'], (localRes) => {
      const cache = localRes && localRes.greythrSwipesCache;
      if (!cache || cache.date !== todayKey || !Array.isArray(cache.swipes) || cache.swipes.length === 0) {
        chrome.action.setBadgeText({ text: '' });
        return;
      }

      chrome.storage.sync.get(['swipeClockRules'], (syncRes) => {
      const saved = (syncRes && syncRes.swipeClockRules) || {};
      const targetSec = typeof saved.dailyTargetSeconds === 'number'
        ? saved.dailyTargetSeconds
        : ((saved.dailyTargetMinutes || 480) * 60);
      const items = cache.swipes
        .map((s) => {
          const parts = String(s.time || '').split(':').map(Number);
          const sec = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
          return { direction: s.direction, sec };
        })
        .sort((a, b) => a.sec - b.sec);

      let effSec = 0;
      let openIn = null;
      for (const item of items) {
        if (item.direction === 'IN' && openIn === null) {
          openIn = item.sec;
        } else if (item.direction === 'OUT' && openIn !== null) {
          effSec += Math.max(0, item.sec - openIn);
          openIn = null;
        }
      }
      if (openIn !== null) {
        const now = new Date();
        const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        if (nowSec > openIn) effSec += nowSec - openIn;
      }

      if (effSec >= targetSec) {
        chrome.action.setBadgeText({ text: 'OK' });
        chrome.action.setBadgeBackgroundColor({ color: '#16A34A' });
      } else {
        const hrs = (effSec / 3600).toFixed(1) + 'h';
        chrome.action.setBadgeText({ text: hrs });
        chrome.action.setBadgeBackgroundColor({ color: '#9333EA' });
      }
      });
    });
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'SWIPES_UPDATED') {
    updateBadgeFromCache();
  }
});

chrome.runtime.onStartup.addListener(updateBadgeFromCache);
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['swipeClockConsent'], (res) => {
    if (!res || res.swipeClockConsent !== true) {
      chrome.storage.local.remove(['greythrSwipesCache', 'greythrWorkingEndpoint'], updateBadgeFromCache);
    } else {
      chrome.storage.local.get(['greythrSwipesCache'], (cacheRes) => {
        const cache = cacheRes && cacheRes.greythrSwipesCache;
        if (cache && Array.isArray(cache.swipes)) {
          const swipes = cache.swipes.map((s) => ({ id: s.id, time: s.time, direction: s.direction }));
          chrome.storage.local.set({ greythrSwipesCache: { date: cache.date, swipes } }, updateBadgeFromCache);
        } else {
          updateBadgeFromCache();
        }
      });
    }
  });
});
