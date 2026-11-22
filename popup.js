// SwipeClock — Live Popup Controller

(function () {
  'use strict';

  const CIRCUMFERENCE = 2 * Math.PI * 58;
  const sourceSub = document.getElementById('sourceSub');
  const statusText = document.getElementById('statusText');
  const liveTimer = document.getElementById('liveTimer');
  const pctText = document.getElementById('pctText');
  const ringProgress = document.getElementById('ringProgress');
  const leaveTime = document.getElementById('leaveTime');
  const grossVal = document.getElementById('grossVal');
  const breakVal = document.getElementById('breakVal');
  const remLabel = document.getElementById('remLabel');
  const remVal = document.getElementById('remVal');
  const sessionList = document.getElementById('sessionList');
  const refreshBtn = document.getElementById('refreshBtn');
  const togglePasteBtn = document.getElementById('togglePasteBtn');
  const pasteBox = document.getElementById('pasteBox');
  const pasteInput = document.getElementById('pasteInput');
  const applyPasteBtn = document.getElementById('applyPasteBtn');
  const targetForm = document.getElementById('targetForm');
  const targetInput = document.getElementById('targetInput');
  const targetError = document.getElementById('targetError');
  const targetBtns = Array.from(document.querySelectorAll('.target-btn'));
  const consentGate = document.getElementById('consentGate');
  const trackerContent = document.getElementById('trackerContent');
  const acceptConsentBtn = document.getElementById('acceptConsentBtn');
  const declineConsentBtn = document.getElementById('declineConsentBtn');
  const privacyResetBtn = document.getElementById('privacyResetBtn');

  let activeRules = Object.assign({}, window.SwipeClockCalc.DEFAULT_RULES);
  let activeSwipes = [];
  let ticker = null;
  let trackerInitialized = false;

  function highlightTargetButton() {
    const secs = typeof activeRules.dailyTargetSeconds === 'number'
      ? activeRules.dailyTargetSeconds
      : activeRules.dailyTargetMinutes * 60;
    targetBtns.forEach((btn) => {
      const btnSecs = parseInt(btn.getAttribute('data-secs'), 10);
      btn.classList.toggle('active', btnSecs === secs);
    });
    if (targetInput) {
      targetInput.value = window.SwipeClockCalc.formatDuration(secs, 'clock');
    }
  }

  function persistTargetSeconds(secs) {
    activeRules.dailyTargetSeconds = secs;
    activeRules.dailyTargetMinutes = Math.round((secs / 60) * 100) / 100;
    highlightTargetButton();
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ swipeClockRules: activeRules });
    }
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'SWIPES_UPDATED' });
    }
    render();
  }

  function render() {
    const calc = window.SwipeClockCalc.calculateDay(activeSwipes, activeRules);
    const fmt = activeRules.timeFormat || '24h';

    liveTimer.textContent = window.SwipeClockCalc.formatDuration(calc.effectiveSeconds, 'clock');
    pctText.textContent = calc.progressPercent + '% of ' + window.SwipeClockCalc.formatDuration(calc.targetSeconds, 'clock');

    const offset = CIRCUMFERENCE * (1 - calc.progressPercent / 100);
    ringProgress.style.strokeDashoffset = String(offset);
    ringProgress.classList.toggle('done', calc.status === 'completed');

    if (calc.status === 'empty') {
      statusText.textContent = 'No Swipes';
    } else if (calc.isClockedIn) {
      statusText.textContent = 'Clocked IN';
    } else if (calc.status === 'completed') {
      statusText.textContent = 'Goal Met';
    } else if (calc.status === 'anomaly') {
      statusText.textContent = 'Check Punch';
    } else {
      statusText.textContent = 'Clocked OUT';
    }

    leaveTime.textContent =
      calc.estimatedOutSeconds !== null
        ? window.SwipeClockCalc.formatClock(calc.estimatedOutSeconds, fmt, true)
        : calc.status === 'completed'
        ? 'Target Met'
        : '--:--:--';

    grossVal.textContent = window.SwipeClockCalc.formatDuration(calc.grossSpanSeconds, 'clock');
    breakVal.textContent = window.SwipeClockCalc.formatDuration(calc.totalBreakSeconds, 'clock');

    if (calc.overtimeSeconds > 0) {
      remLabel.textContent = 'Overtime';
      remVal.textContent = '+' + window.SwipeClockCalc.formatDuration(calc.overtimeSeconds, 'clock');
    } else {
      remLabel.textContent = 'Remaining';
      remVal.textContent = window.SwipeClockCalc.formatDuration(calc.remainingSeconds, 'clock');
    }

    sessionList.innerHTML = '';
    const timeline = window.SwipeClockCalc.buildSessionTimeline(calc);
    if (timeline.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Open greytHR Swipes or click "Paste swipes".';
      li.style.fontFamily = 'inherit';
      li.style.color = '#a1a1aa';
      sessionList.appendChild(li);
      return;
    }

    timeline.forEach((item) => {
      const li = document.createElement('li');
      const startStr = window.SwipeClockCalc.formatClock(item.startSeconds, fmt, true);
      const durStr = window.SwipeClockCalc.formatDuration(item.durationSeconds, 'clock');
      if (item.kind === 'break') {
        li.className = 'session-break';
        const endStr = window.SwipeClockCalc.formatClock(item.endSeconds, fmt, true);
        li.innerHTML =
          '<span>Break · ' + startStr + ' → ' + endStr + '</span>' +
          '<span>' + durStr + '</span>';
      } else {
        const endStr = item.isLive ? '<span class="session-live">Present</span>' : window.SwipeClockCalc.formatClock(item.endSeconds, fmt, true);
        li.innerHTML =
          '<span>' + startStr + ' → ' + endStr + '</span>' +
          '<span class="' + (item.isLive ? 'session-live' : '') + '">' + durStr + '</span>';
      }
      sessionList.appendChild(li);
    });
  }

  function startTicker() {
    if (ticker) clearInterval(ticker);
    ticker = setInterval(render, 1000);
  }

  function loadFromTabOrCache() {
    sourceSub.textContent = 'Syncing with greytHR…';

    const fallbackCache = () => {
      const todayKey = window.SwipeClockCalc.getLocalDateKey();
      chrome.storage.local.get(['greythrSwipesCache'], (res) => {
        const cache = res && res.greythrSwipesCache;
        if (cache && cache.date === todayKey && Array.isArray(cache.swipes) && cache.swipes.length > 0) {
          activeSwipes = cache.swipes;
          sourceSub.textContent = 'Cached from today’s greytHR tab';
        } else {
          activeSwipes = [];
          sourceSub.textContent = 'Open greytHR (or click View Swipes once)';
        }
        render();
      });
    };

    const queryGreytHRTab = (tabs, idx) => {
      if (!tabs || idx >= tabs.length) {
        fallbackCache();
        return;
      }
      const tab = tabs[idx];
      if (!tab || !tab.id) {
        queryGreytHRTab(tabs, idx + 1);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'GET_GREYTHR_SWIPES' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.swipes || response.swipes.length === 0) {
          queryGreytHRTab(tabs, idx + 1);
          return;
        }
        activeSwipes = response.swipes;
        sourceSub.textContent = response.sourceKind === 'api'
          ? 'Synced via API'
          : 'Synced from tab';
        render();
      });
    };

    // Prefer any open greytHR tab (even in the background), then active tab
    chrome.tabs.query({ url: 'https://*.greythr.com/*' }, (greytTabs) => {
      if (greytTabs && greytTabs.length > 0) {
        queryGreytHRTab(greytTabs, 0);
        return;
      }
      fallbackCache();
    });
  }

  function showConsentGate() {
    consentGate.classList.remove('hidden');
    trackerContent.classList.add('hidden');
    privacyResetBtn.classList.add('hidden');
    refreshBtn.disabled = true;
    sourceSub.textContent = 'Swipe access is off';
  }

  function initializeTracker() {
    if (trackerInitialized) return;
    trackerInitialized = true;
    consentGate.classList.add('hidden');
    trackerContent.classList.remove('hidden');
    privacyResetBtn.classList.remove('hidden');
    refreshBtn.disabled = false;
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['swipeClockRules'], (res) => {
        if (res && res.swipeClockRules) {
          activeRules = Object.assign({}, activeRules, res.swipeClockRules);
        }
        highlightTargetButton();
        loadFromTabOrCache();
        startTicker();
      });
    } else {
      highlightTargetButton();
      loadFromTabOrCache();
      startTicker();
    }
  }

  targetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      targetError.classList.add('hidden');
      const secs = parseInt(btn.getAttribute('data-secs'), 10);
      persistTargetSeconds(secs);
    });
  });

  targetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const secs = window.SwipeClockCalc.parseDurationToSeconds(targetInput.value);
    if (secs === null) {
      targetError.textContent = 'Use 24h HH:MM:SS (e.g. 08:00:00)';
      targetError.classList.remove('hidden');
      return;
    }
    targetError.classList.add('hidden');
    persistTargetSeconds(secs);
  });

  togglePasteBtn.addEventListener('click', () => {
    pasteBox.classList.toggle('hidden');
  });

  applyPasteBtn.addEventListener('click', () => {
    const parsed = window.SwipeClockCalc.parseRawText(pasteInput.value);
    if (parsed.length > 0) {
      activeSwipes = parsed;
      sourceSub.textContent = 'Manual pasted swipes';
      pasteBox.classList.add('hidden');
      render();
    }
  });

  refreshBtn.addEventListener('click', loadFromTabOrCache);

  acceptConsentBtn.addEventListener('click', () => {
    chrome.storage.local.set({ swipeClockConsent: true }, () => {
      initializeTracker();
    });
  });

  declineConsentBtn.addEventListener('click', () => {
    sourceSub.textContent = 'Swipe access is off';
    window.close();
  });

  privacyResetBtn.addEventListener('click', () => {
    chrome.tabs.query({ url: 'https://*.greythr.com/*' }, (tabs) => {
      (tabs || []).forEach((tab) => {
        if (!tab.id) return;
        chrome.tabs.sendMessage(tab.id, { type: 'SWIPECLOCK_DISABLE_SYNC' }, () => {
          void chrome.runtime.lastError;
        });
      });
    });
    chrome.storage.local.remove(['swipeClockConsent', 'greythrSwipesCache', 'greythrWorkingEndpoint'], () => {
      activeSwipes = [];
      if (ticker) clearInterval(ticker);
      ticker = null;
      trackerInitialized = false;
      showConsentGate();
      render();
      chrome.runtime.sendMessage({ type: 'SWIPES_UPDATED' });
    });
  });

  chrome.storage.local.get(['swipeClockConsent'], (res) => {
    if (res && res.swipeClockConsent === true) initializeTracker();
    else showConsentGate();
  });
})();
