// SwipeClock — Core Swipes Time Calculator Engine
// Shared between content.js (Shadow DOM scraper) and popup.js (live circular timer).

(function (global) {
  'use strict';

  const DEFAULT_RULES = {
    dailyTargetSeconds: 28800,
    dailyTargetMinutes: 480,
    weeklyTargetHours: 40.1,
    timeFormat: '24h',
    duplicateDebounceMinutes: 2,
    countActiveSession: true,
    longBreakWarningMinutes: 60
  };

  function parseDurationToSeconds(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const s = match[3] ? parseInt(match[3], 10) : 0;
    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
    const total = h * 3600 + m * 60 + s;
    return total > 0 ? total : null;
  }

  function parseTimeToSeconds(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.trim().toLowerCase();
    const match = cleaned.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = match[3] ? parseInt(match[3], 10) : 0;
    const meridiem = match[4] ? match[4].toLowerCase() : null;

    if (minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return null;

    if (meridiem) {
      if (hours < 1 || hours > 12) return null;
      if (meridiem === 'am') {
        hours = hours === 12 ? 0 : hours;
      } else {
        hours = hours === 12 ? 12 : hours + 12;
      }
    } else if (hours < 0 || hours > 23) {
      return null;
    }

    return hours * 3600 + minutes * 60 + seconds;
  }

  function formatClock(totalSeconds, format, includeSeconds) {
    const normalized = ((Math.floor(totalSeconds) % 86400) + 86400) % 86400;
    const h24 = Math.floor(normalized / 3600);
    const m = Math.floor((normalized % 3600) / 60);
    const s = normalized % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');

    if (format === '24h') {
      const hh = String(h24).padStart(2, '0');
      return includeSeconds ? hh + ':' + mm + ':' + ss : hh + ':' + mm;
    }

    const period = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const hh = String(h12).padStart(2, '0');
    return includeSeconds ? hh + ':' + mm + ':' + ss + ' ' + period : hh + ':' + mm + ' ' + period;
  }

  function formatDuration(seconds, style) {
    const neg = seconds < 0;
    const abs = Math.abs(Math.floor(seconds));
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');

    if (style === 'clock') {
      return (neg ? '-' : '') + hh + ':' + mm + ':' + ss;
    }
    if (style === 'signed') {
      const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
      return sign + hh + 'h ' + mm + 'm';
    }
    return (neg ? '-' : '') + hh + 'h ' + mm + 'm';
  }

  function parseRawText(rawText) {
    if (!rawText) return [];
    const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const timeRe = /\b(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?)\b/i;
    const dirRe = /\b(IN|OUT|SIGN[\s-]?IN|SIGN[\s-]?OUT)\b/i;
    const swipes = [];

    lines.forEach((line, idx) => {
      const tm = line.match(timeRe);
      if (!tm) return;
      const sec = parseTimeToSeconds(tm[1]);
      if (sec === null) return;
      const dm = line.match(dirRe);
      const direction = dm
        ? dm[1].toUpperCase().includes('OUT') ? 'OUT' : 'IN'
        : swipes.length % 2 === 0 ? 'IN' : 'OUT';
      const door = line
        .replace(tm[0], '')
        .replace(dm ? dm[0] : '', '')
        .replace(/[|\t]+/g, ' ')
        .trim() || 'Biometric';

      swipes.push({
        id: 'sw-' + idx + '-' + sec,
        time: formatClock(sec, '24h', true),
        direction,
        door
      });
    });

    return swipes.sort((a, b) => (parseTimeToSeconds(a.time) || 0) - (parseTimeToSeconds(b.time) || 0));
  }

  function calculateDay(swipes, userRules, nowSeconds) {
    const rules = Object.assign({}, DEFAULT_RULES, userRules || {});
    const targetSeconds = Math.max(
      0,
      Math.round(
        typeof rules.dailyTargetSeconds === 'number'
          ? rules.dailyTargetSeconds
          : rules.dailyTargetMinutes * 60
      )
    );
    const debounceSeconds = Math.max(0, Math.round(rules.duplicateDebounceMinutes * 60));

    const items = (swipes || [])
      .map((entry) => ({ entry, sec: parseTimeToSeconds(entry.time) }))
      .filter((x) => x.sec !== null)
      .sort((a, b) => a.sec - b.sec);

    if (items.length === 0) {
      return {
        swipes: [],
        workIntervals: [],
        breakIntervals: [],
        effectiveSeconds: 0,
        totalBreakSeconds: 0,
        grossSpanSeconds: 0,
        targetSeconds,
        remainingSeconds: targetSeconds,
        overtimeSeconds: 0,
        progressPercent: 0,
        isClockedIn: false,
        estimatedOutSeconds: null,
        anomalies: [],
        status: 'empty'
      };
    }

    const workIntervals = [];
    const breakIntervals = [];
    const anomalies = [];
    let openIn = null;
    let lastOut = null;
    let firstInSec = null;
    let lastOutSec = null;

    for (const current of items) {
      if (current.entry.direction === 'IN') {
        if (firstInSec === null) firstInSec = current.sec;
        if (openIn !== null) {
          const delta = current.sec - openIn.sec;
          if (delta <= debounceSeconds) {
            anomalies.push({ type: 'duplicate_ignored', message: 'Ignored duplicate IN punch.' });
          } else {
            anomalies.push({ type: 'missing_out', message: 'Missing OUT punch before ' + formatClock(current.sec, rules.timeFormat) });
            openIn = current;
          }
        } else {
          if (lastOut !== null && current.sec > lastOut.sec) {
            breakIntervals.push({ startSeconds: lastOut.sec, endSeconds: current.sec, durationSeconds: current.sec - lastOut.sec });
          }
          openIn = current;
        }
      } else {
        if (openIn !== null) {
          workIntervals.push({ startSeconds: openIn.sec, endSeconds: current.sec, durationSeconds: Math.max(0, current.sec - openIn.sec), isLive: false });
          lastOut = current;
          lastOutSec = current.sec;
          openIn = null;
        } else if (lastOut !== null && current.sec - lastOut.sec <= debounceSeconds) {
          const prev = workIntervals[workIntervals.length - 1];
          if (prev) {
            prev.endSeconds = current.sec;
            prev.durationSeconds = Math.max(0, current.sec - prev.startSeconds);
          }
          lastOut = current;
          lastOutSec = current.sec;
          anomalies.push({ type: 'duplicate_ignored', message: 'Merged double-tap OUT punch.' });
        } else {
          anomalies.push({ type: 'missing_in', message: 'Unpaired OUT at ' + formatClock(current.sec, rules.timeFormat) });
        }
      }
    }

    const now = typeof nowSeconds === 'number'
      ? nowSeconds
      : (new Date().getHours() * 3600 + new Date().getMinutes() * 60 + new Date().getSeconds());

    let isClockedIn = false;
    let endForGross = lastOutSec;

    if (openIn !== null) {
      isClockedIn = true;
      if (rules.countActiveSession && now >= openIn.sec) {
        workIntervals.push({ startSeconds: openIn.sec, endSeconds: now, durationSeconds: now - openIn.sec, isLive: true });
        endForGross = now;
      }
    }

    const effectiveSeconds = workIntervals.reduce((sum, w) => sum + w.durationSeconds, 0);
    const totalBreakSeconds = breakIntervals.reduce((sum, b) => sum + b.durationSeconds, 0);
    const grossSpanSeconds = firstInSec !== null && endForGross !== null && endForGross >= firstInSec
      ? endForGross - firstInSec
      : effectiveSeconds;

    const remainingSeconds = Math.max(0, targetSeconds - effectiveSeconds);
    const overtimeSeconds = Math.max(0, effectiveSeconds - targetSeconds);
    const progressPercent = targetSeconds > 0 ? Math.min(100, Math.round((effectiveSeconds / targetSeconds) * 1000) / 10) : 100;

    let estimatedOutSeconds = null;
    if (isClockedIn && openIn !== null) {
      const completedBeforeOpen = workIntervals.filter((w) => !w.isLive).reduce((sum, w) => sum + w.durationSeconds, 0);
      estimatedOutSeconds = openIn.sec + Math.max(0, targetSeconds - completedBeforeOpen);
    }

    const hasHardAnomaly = anomalies.some((a) => a.type !== 'duplicate_ignored');
    const status = hasHardAnomaly
      ? 'anomaly'
      : isClockedIn && remainingSeconds > 0
      ? 'working'
      : effectiveSeconds >= targetSeconds
      ? 'completed'
      : 'deficit';

    return {
      swipes: items.map((x) => x.entry),
      workIntervals,
      breakIntervals,
      effectiveSeconds,
      totalBreakSeconds,
      grossSpanSeconds,
      targetSeconds,
      remainingSeconds,
      overtimeSeconds,
      progressPercent,
      isClockedIn,
      estimatedOutSeconds,
      anomalies,
      status
    };
  }

  function buildSessionTimeline(calc) {
    const items = [];
    (calc.workIntervals || []).forEach((w) => {
      items.push({
        kind: 'work',
        startSeconds: w.startSeconds,
        endSeconds: w.endSeconds,
        durationSeconds: w.durationSeconds,
        isLive: !!w.isLive
      });
    });
    (calc.breakIntervals || []).forEach((b) => {
      items.push({
        kind: 'break',
        startSeconds: b.startSeconds,
        endSeconds: b.endSeconds,
        durationSeconds: b.durationSeconds,
        isLive: false
      });
    });
    return items.sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      if (a.startSeconds !== b.startSeconds) return b.startSeconds - a.startSeconds;
      if (a.endSeconds !== b.endSeconds) return b.endSeconds - a.endSeconds;
      if (a.kind !== b.kind) return a.kind === 'break' ? -1 : 1;
      return 0;
    });
  }

  function getLocalDateKey(dateObj) {
    const d = dateObj || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /**
   * Recursively extracts today's IN/OUT swipes from greytHR v3 / legacy JSON API responses.
   * Handles common field variations: swipeTime, punchTime, punchDateTime, timestamp,
   * inOutIndicator (1/0 or IN/OUT), inOut, direction, type, and related date fields.
   */
  function extractSwipesFromApiPayload(payload, todayIso) {
    const targetDate = todayIso || getLocalDateKey();
    const found = [];
    const seen = new Set();
    const visited = new Set();

    function extractTimeFromValue(val) {
      if (val === null || val === undefined) return null;
      if (typeof val === 'number' && val > 1e11) {
        const dt = new Date(val);
        if (isNaN(dt.getTime())) return null;
        if (getLocalDateKey(dt) !== targetDate) return null;
        return dt.getHours() * 3600 + dt.getMinutes() * 60 + dt.getSeconds();
      }
      const str = String(val).trim();
      if (!str) return null;

      // API timestamps with an explicit zone (for example, a UTC `Z` suffix)
      // must be converted to the browser's local time, which greytHR displays.
      const zonedDateTime = str.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
      if (zonedDateTime) {
        const dt = new Date(str);
        if (isNaN(dt.getTime()) || getLocalDateKey(dt) !== targetDate) return null;
        return dt.getHours() * 3600 + dt.getMinutes() * 60 + dt.getSeconds();
      }

      // greytHR may omit the zone suffix even though its API datetime is UTC.
      // Treat a full ISO datetime as UTC; keep clock-only values as local times.
      const unzonedDateTime = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
      if (unzonedDateTime) {
        const dt = new Date(Date.UTC(
          Number(unzonedDateTime[1]), Number(unzonedDateTime[2]) - 1,
          Number(unzonedDateTime[3]), Number(unzonedDateTime[4]),
          Number(unzonedDateTime[5]), Number(unzonedDateTime[6] || 0)
        ));
        if (getLocalDateKey(dt) !== targetDate) return null;
        return dt.getHours() * 3600 + dt.getMinutes() * 60 + dt.getSeconds();
      }

      const isoDateMatch = str.match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?=T|\s|$|[^\d])/);
      if (isoDateMatch && isoDateMatch[1] !== targetDate) return null;
      const timeMatch = str.match(/(?:T|\s|^)(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?)(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?:\s|$)/i);
      if (!timeMatch) return null;
      return parseTimeToSeconds(timeMatch[1]);
    }

    function normalizeDir(raw) {
      if (raw === 1 || raw === '1' || raw === true) return 'IN';
      if (raw === 0 || raw === '0' || raw === false) return 'OUT';
      if (typeof raw !== 'string') return null;
      const up = raw.trim().toUpperCase();
      if (!up) return null;
      if (up === 'IN' || up === 'I' || up.includes('SIGN IN') || up.includes('SIGN-IN') || up.includes('SIGN_IN') || up.includes('CHECK IN') || up === 'CLOCK_IN') {
        return 'IN';
      }
      if (up === 'OUT' || up === 'O' || up.includes('SIGN OUT') || up.includes('SIGN-OUT') || up.includes('SIGN_OUT') || up.includes('CHECK OUT') || up === 'CLOCK_OUT') {
        return 'OUT';
      }
      return null;
    }

    function inspectRecord(obj, idx) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

      // Reject records explicitly stamped for another date
      const explicitDate = obj.date || obj.swipeDate || obj.attendanceDate || obj.punchDate;
      if (explicitDate) {
        const dm = String(explicitDate).match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?=T|\s|$|[^\d])/);
        if (dm && dm[1] !== targetDate) return false;
      }

      const rawTime =
        obj.punchDateTime !== undefined ? obj.punchDateTime :
        obj.swipeDateTime !== undefined ? obj.swipeDateTime :
        obj.timestamp !== undefined ? obj.timestamp :
        obj.swipeTime !== undefined ? obj.swipeTime :
        obj.punchTime !== undefined ? obj.punchTime :
        obj.time !== undefined ? obj.time :
        obj.actualTime;

      const rawDir =
        obj.inOutIndicator !== undefined ? obj.inOutIndicator :
        obj.inOut !== undefined ? obj.inOut :
        obj.inOutStatus !== undefined ? obj.inOutStatus :
        obj.direction !== undefined ? obj.direction :
        obj.indicator !== undefined ? obj.indicator :
        obj.swipeType !== undefined ? obj.swipeType :
        obj.punchType !== undefined ? obj.punchType :
        obj.type !== undefined ? obj.type :
        obj.status;

      const sec = extractTimeFromValue(rawTime);
      const dir = normalizeDir(rawDir);
      if (sec === null || !dir) return false;

      const normalizedTime = formatClock(sec, '24h', true);
      const key = normalizedTime + '|' + dir;
      if (seen.has(key)) return true;
      seen.add(key);

      found.push({
        id: 'api-' + idx + '-' + sec,
        time: normalizedTime,
        direction: dir
      });
      return true;
    }

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
      visited.add(node);

      if (Array.isArray(node)) {
        node.forEach((item, idx) => {
          if (!inspectRecord(item, idx)) {
            walk(item, depth + 1);
          }
        });
        return;
      }

      if (inspectRecord(node, found.length)) return;
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        walk(node[keys[i]], depth + 1);
      }
    }

    walk(payload, 0);
    return found.sort((a, b) => (parseTimeToSeconds(a.time) || 0) - (parseTimeToSeconds(b.time) || 0));
  }

  global.SwipeClockCalc = {
    DEFAULT_RULES,
    getLocalDateKey,
    parseDurationToSeconds,
    parseTimeToSeconds,
    formatClock,
    formatDuration,
    parseRawText,
    calculateDay,
    buildSessionTimeline,
    extractSwipesFromApiPayload
  };
})(typeof window !== 'undefined' ? window : globalThis);
