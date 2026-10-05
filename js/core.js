/* Lumina Calendar — core logic (dates, recurrence, iCalendar).
 * Pure functions only: no DOM access, so this file also runs under Node for tests. */
(function (global) {
  'use strict';

  const CATEGORIES = ['work', 'personal', 'health', 'urgent', 'family', 'study'];
  const CATEGORY_COLORS = { work: '#3b82f6', personal: '#a855f7', health: '#10b981', urgent: '#ef4444', family: '#f59e0b', study: '#06b6d4' };
  const PALETTE = ['#3b82f6', '#a855f7', '#10b981', '#ef4444', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#6366f1', '#eab308'];
  const FREQS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
  const MAX_OCCURRENCES = 2000;
  const TOMBSTONE_DAYS = 90;

  /* ---------- Dates ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function toDateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseDateStr(s) {
    const p = String(s || '').split('-').map(Number);
    if (p.length !== 3 || p.some(isNaN)) return null;
    const d = new Date(p[0], p[1] - 1, p[2]);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function isDateStr(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !!parseDateStr(s);
  }

  function isTimeStr(s) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
  }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function addDays(d, n) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
    return r;
  }

  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }

  /* weekStart: 0 = Sunday, 1 = Monday, 6 = Saturday */
  function startOfWeek(d, weekStart) {
    const r = startOfDay(d);
    const diff = (r.getDay() - (weekStart || 0) + 7) % 7;
    r.setDate(r.getDate() - diff);
    return r;
  }

  function daysBetween(a, b) {
    const A = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const B = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((B - A) / 86400000);
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function toMinutes(hhmm) {
    if (!isTimeStr(hhmm)) return 0;
    const p = hhmm.split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  function fromMinutes(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);
  }

  /* Absolute start timestamp (ms) of an occurrence. All-day events start at 00:00. */
  function occurrenceStart(ev, occDate) {
    const d = parseDateStr(occDate || ev.date);
    if (!d) return NaN;
    if (!ev.allDay && isTimeStr(ev.time)) {
      const m = toMinutes(ev.time);
      d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    }
    return d.getTime();
  }

  function occurrenceEnd(ev, occDate) {
    const start = occurrenceStart(ev, occDate);
    if (ev.allDay || !isTimeStr(ev.time)) return start + 86400000;
    if (isTimeStr(ev.endTime) && toMinutes(ev.endTime) > toMinutes(ev.time)) {
      return start + (toMinutes(ev.endTime) - toMinutes(ev.time)) * 60000;
    }
    return start + 60 * 60000; // default duration: one hour
  }

  /* ISO week number (1-53) */
  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  }

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- Calendars ---------- */
  function defaultCalendars() {
    return CATEGORIES.map(function (id, i) {
      return { id: id, name: null, color: CATEGORY_COLORS[id], visible: true, kind: 'local', builtin: true, order: i, updatedAt: '2000-01-01T00:00:00.000Z' };
    });
  }

  function isColor(s) { return /^#[0-9a-f]{6}$/i.test(String(s || '')); }

  function normalizeCalendar(raw, index) {
    const c = Object.assign({}, raw || {});
    c.id = String(c.id || uid()).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64) || uid();
    c.name = c.name ? String(c.name).trim().slice(0, 60) : null;
    c.builtin = CATEGORIES.indexOf(c.id) >= 0;
    if (!c.name && !c.builtin) c.name = c.id;
    c.color = isColor(c.color) ? c.color.toLowerCase() : (CATEGORY_COLORS[c.id] || PALETTE[(index || 0) % PALETTE.length]);
    c.visible = c.visible !== false;
    c.kind = c.kind === 'feed' ? 'feed' : 'local';
    if (c.kind === 'feed') {
      c.url = String(c.url || '').trim();
      c.lastFetched = c.lastFetched || null;
      c.error = c.error || null;
    } else { delete c.url; delete c.lastFetched; delete c.error; }
    c.order = typeof c.order === 'number' ? c.order : (index || 0);
    c.updatedAt = c.updatedAt || new Date().toISOString();
    return c;
  }

  /* Make sure every built-in calendar exists exactly once and the list is ordered. */
  function normalizeCalendars(list) {
    const seen = {};
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (raw, i) {
      const c = normalizeCalendar(raw, i);
      if (seen[c.id]) return;
      seen[c.id] = true;
      out.push(c);
    });
    defaultCalendars().forEach(function (d) { if (!seen[d.id]) { out.push(d); seen[d.id] = true; } });
    out.sort(function (a, b) { return a.order - b.order; });
    out.forEach(function (c, i) { c.order = i; });
    return out;
  }

  function calendarColor(calendars, id) {
    const c = (calendars || []).find(function (x) { return x.id === id; });
    return c ? c.color : (CATEGORY_COLORS[id] || '#a855f7');
  }

  /* ---------- Events ---------- */
  function normalizeEvent(raw) {
    const ev = Object.assign({}, raw || {});
    ev.id = String(ev.id || uid());
    ev.title = String(ev.title || '').trim();
    ev.date = isDateStr(ev.date) ? ev.date : toDateStr(new Date());
    ev.allDay = !!ev.allDay || !isTimeStr(ev.time);
    ev.time = ev.allDay ? '' : ev.time;
    ev.endTime = (!ev.allDay && isTimeStr(ev.endTime) && toMinutes(ev.endTime) > toMinutes(ev.time)) ? ev.endTime : '';
    const cat = String(ev.category || ev.type || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64);
    ev.category = cat || 'personal';
    delete ev.type;
    ev.location = String(ev.location || '').trim();
    ev.notes = String(ev.notes || '').trim();
    ev.reminder = (ev.reminder === null || ev.reminder === undefined || ev.reminder === '' || isNaN(Number(ev.reminder))) ? null : Number(ev.reminder);
    if (ev.repeat && ev.repeat.freq && ev.repeat.freq !== 'none' && FREQS.indexOf(ev.repeat.freq) >= 0) {
      ev.repeat = {
        freq: ev.repeat.freq,
        interval: Math.max(1, Math.min(99, Number(ev.repeat.interval) || 1)),
        until: isDateStr(ev.repeat.until) ? ev.repeat.until : null,
        exdates: Array.isArray(ev.repeat.exdates) ? ev.repeat.exdates.filter(isDateStr) : []
      };
    } else {
      ev.repeat = null;
    }
    const now = new Date().toISOString();
    ev.createdAt = ev.createdAt || now;
    ev.updatedAt = ev.updatedAt || now;
    return ev;
  }

  function isRecurring(ev) {
    return !!(ev && ev.repeat && ev.repeat.freq && ev.repeat.freq !== 'none');
  }

  function makeOccurrence(ev, dateStr) {
    const o = Object.create(ev);
    o.occDate = dateStr;
    o.key = ev.id + '@' + dateStr;
    o.recurring = isRecurring(ev);
    o.event = ev;
    return o;
  }

  /* Expand one event into occurrences within [startStr, endStr] (inclusive). */
  function expandEvent(ev, startStr, endStr) {
    const out = [];
    const base = parseDateStr(ev.date);
    const rangeStart = parseDateStr(startStr);
    const rangeEnd = parseDateStr(endStr);
    if (!base || !rangeStart || !rangeEnd) return out;
    if (base > rangeEnd) return out;

    if (!isRecurring(ev)) {
      if (base >= rangeStart) out.push(makeOccurrence(ev, ev.date));
      return out;
    }

    const rep = ev.repeat;
    const interval = Math.max(1, rep.interval || 1);
    let end = rangeEnd;
    if (rep.until) {
      const u = parseDateStr(rep.until);
      if (u && u < end) end = u;
    }
    if (end < rangeStart) return out;
    const ex = new Set(rep.exdates || []);
    const push = function (d) {
      if (d < rangeStart || d > end) return;
      const s = toDateStr(d);
      if (!ex.has(s)) out.push(makeOccurrence(ev, s));
    };

    if (rep.freq === 'daily' || rep.freq === 'weekly') {
      const step = rep.freq === 'daily' ? interval : interval * 7;
      let k = 0;
      const gap = daysBetween(base, rangeStart);
      if (gap > 0) k = Math.floor(gap / step);
      let d = addDays(base, k * step);
      let guard = 0;
      while (d <= end && guard++ < MAX_OCCURRENCES) {
        push(d);
        d = addDays(d, step);
      }
    } else if (rep.freq === 'monthly') {
      const day = base.getDate();
      let k = 0;
      const monthsGap = (rangeStart.getFullYear() - base.getFullYear()) * 12 + (rangeStart.getMonth() - base.getMonth());
      if (monthsGap > 1) k = Math.floor((monthsGap - 1) / interval);
      let guard = 0;
      while (guard++ < MAX_OCCURRENCES) {
        const cand = new Date(base.getFullYear(), base.getMonth() + k * interval, day);
        if (new Date(base.getFullYear(), base.getMonth() + k * interval, 1) > end) break;
        if (cand.getDate() === day) push(cand);
        k++;
      }
    } else if (rep.freq === 'yearly') {
      let k = 0;
      const yearsGap = rangeStart.getFullYear() - base.getFullYear();
      if (yearsGap > 1) k = Math.floor((yearsGap - 1) / interval);
      let guard = 0;
      while (guard++ < MAX_OCCURRENCES) {
        const y = base.getFullYear() + k * interval;
        if (new Date(y, 0, 1) > end) break;
        const cand = new Date(y, base.getMonth(), base.getDate());
        if (cand.getMonth() === base.getMonth()) push(cand);
        k++;
      }
    }
    return out;
  }

  function compareOccurrences(a, b) {
    if (a.occDate !== b.occDate) return a.occDate < b.occDate ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const ta = a.allDay ? 0 : toMinutes(a.time);
    const tb = b.allDay ? 0 : toMinutes(b.time);
    if (ta !== tb) return ta - tb;
    return a.title.localeCompare(b.title);
  }

  /* Expand all events into a sorted occurrence list for the range. */
  function expand(events, startStr, endStr) {
    const out = [];
    for (const ev of events) {
      const occ = expandEvent(ev, startStr, endStr);
      for (const o of occ) out.push(o);
    }
    out.sort(compareOccurrences);
    return out;
  }

  /* Do two timed occurrences on the same day overlap? */
  function overlaps(a, b) {
    if (a.allDay || b.allDay) return false;
    if (a.occDate !== b.occDate) return false;
    const as = occurrenceStart(a, a.occDate), ae = occurrenceEnd(a, a.occDate);
    const bs = occurrenceStart(b, b.occDate), be = occurrenceEnd(b, b.occDate);
    return as < be && bs < ae;
  }

  /* Lay out timed occurrences of one day into columns (for the week view).
     Returns a map key -> {col, cols}. */
  function layoutDay(occs) {
    const timed = occs.filter(function (o) { return !o.allDay; }).slice().sort(function (a, b) {
      const d = occurrenceStart(a, a.occDate) - occurrenceStart(b, b.occDate);
      return d || (occurrenceEnd(b, b.occDate) - occurrenceEnd(a, a.occDate));
    });
    const result = {};
    let cluster = [], clusterEnd = -Infinity, colEnds = [];
    const flush = function () {
      const cols = colEnds.length || 1;
      for (const c of cluster) result[c.key].cols = cols;
      cluster = []; colEnds = []; clusterEnd = -Infinity;
    };
    for (const o of timed) {
      const s = occurrenceStart(o, o.occDate), e = occurrenceEnd(o, o.occDate);
      if (cluster.length && s >= clusterEnd) flush();
      let col = colEnds.findIndex(function (end) { return end <= s; });
      if (col === -1) { col = colEnds.length; colEnds.push(e); } else { colEnds[col] = e; }
      result[o.key] = { col: col, cols: 1 };
      cluster.push(o);
      if (e > clusterEnd) clusterEnd = e;
    }
    if (cluster.length) flush();
    return result;
  }

  /* ---------- Search ---------- */
  function matches(ev, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return [ev.title, ev.location, ev.notes].some(function (f) { return f && f.toLowerCase().indexOf(q) >= 0; });
  }

  /* ---------- iCalendar (RFC 5545) ---------- */
  function icsEscape(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  function icsUnescape(s) {
    return String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  }

  function foldLine(line) {
    // Fold at 74 characters (RFC 5545 asks for 75 octets; we stay on the safe side for multibyte text).
    const out = [];
    let s = line;
    while (s.length > 74) {
      out.push(s.slice(0, 74));
      s = ' ' + s.slice(74);
    }
    out.push(s);
    return out.join('\r\n');
  }

  function icsDateTime(dateStr, timeStr) {
    const d = dateStr.replace(/-/g, '');
    if (!timeStr) return d;
    return d + 'T' + timeStr.replace(':', '') + '00';
  }

  function icsStampUTC(date) {
    const d = date || new Date();
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  function toICS(events, opts) {
    opts = opts || {};
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lumina Calendar//' + (opts.version || '1.0') + '//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    if (opts.name) lines.push('X-WR-CALNAME:' + icsEscape(opts.name));
    const stamp = icsStampUTC(opts.now);
    for (const ev of events) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + ev.id + '@lumina-calendar');
      lines.push('DTSTAMP:' + stamp);
      if (ev.allDay) {
        lines.push('DTSTART;VALUE=DATE:' + icsDateTime(ev.date));
        lines.push('DTEND;VALUE=DATE:' + icsDateTime(toDateStr(addDays(parseDateStr(ev.date), 1))));
      } else {
        lines.push('DTSTART:' + icsDateTime(ev.date, ev.time));
        const endMin = isTimeStr(ev.endTime) && toMinutes(ev.endTime) > toMinutes(ev.time) ? toMinutes(ev.endTime) : toMinutes(ev.time) + 60;
        if (endMin >= 1440) {
          lines.push('DTEND:' + icsDateTime(toDateStr(addDays(parseDateStr(ev.date), 1)), fromMinutes(endMin)));
        } else {
          lines.push('DTEND:' + icsDateTime(ev.date, fromMinutes(endMin)));
        }
      }
      lines.push('SUMMARY:' + icsEscape(ev.title));
      if (ev.location) lines.push('LOCATION:' + icsEscape(ev.location));
      if (ev.notes) lines.push('DESCRIPTION:' + icsEscape(ev.notes));
      const catName = (opts.calendarNames && opts.calendarNames[ev.category]) || (ev.category.charAt(0).toUpperCase() + ev.category.slice(1));
      lines.push('CATEGORIES:' + icsEscape(catName));
      lines.push('X-LUMINA-CATEGORY:' + ev.category);
      if (isRecurring(ev)) {
        let rr = 'RRULE:FREQ=' + ev.repeat.freq.toUpperCase();
        if (ev.repeat.interval > 1) rr += ';INTERVAL=' + ev.repeat.interval;
        if (ev.repeat.until) rr += ';UNTIL=' + icsDateTime(ev.repeat.until) + (ev.allDay ? '' : 'T235959');
        lines.push(rr);
        for (const x of ev.repeat.exdates || []) {
          lines.push(ev.allDay ? 'EXDATE;VALUE=DATE:' + icsDateTime(x) : 'EXDATE:' + icsDateTime(x, ev.time));
        }
      }
      if (ev.reminder !== null && ev.reminder !== undefined) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(ev.title), 'TRIGGER:-PT' + ev.reminder + 'M', 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  function parseICSDate(value, params) {
    // Returns {date:'YYYY-MM-DD', time:'HH:MM'|'' , allDay}
    const v = String(value || '').trim();
    let m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    const allDay = (params && /VALUE=DATE(?!-TIME)/i.test(params)) || !m[4];
    if (allDay) return { date: m[1] + '-' + m[2] + '-' + m[3], time: '', allDay: true };
    if (m[7] === 'Z') {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
      return { date: toDateStr(d), time: pad(d.getHours()) + ':' + pad(d.getMinutes()), allDay: false };
    }
    // Floating or TZID times are taken as local time.
    return { date: m[1] + '-' + m[2] + '-' + m[3], time: m[4] + ':' + m[5], allDay: false };
  }

  function parseRRule(value) {
    const parts = {};
    String(value || '').split(';').forEach(function (p) {
      const i = p.indexOf('=');
      if (i > 0) parts[p.slice(0, i).toUpperCase()] = p.slice(i + 1);
    });
    const freq = (parts.FREQ || '').toLowerCase();
    if (FREQS.indexOf(freq) < 0 || freq === 'none') return null;
    const rule = { freq: freq, interval: Math.max(1, parseInt(parts.INTERVAL, 10) || 1), until: null, exdates: [] };
    if (parts.UNTIL) {
      const u = parseICSDate(parts.UNTIL, '');
      if (u) rule.until = u.date;
    }
    if (parts.COUNT) rule._count = parseInt(parts.COUNT, 10);
    return rule;
  }

  function mapCategory(value) {
    const v = String(value || '').toLowerCase();
    for (const c of CATEGORIES) if (v.indexOf(c) >= 0) return c;
    const ar = { 'عمل': 'work', 'شخصي': 'personal', 'صحة': 'health', 'عاجل': 'urgent', 'عائلة': 'family', 'دراسة': 'study' };
    for (const k in ar) if (v.indexOf(k) >= 0) return ar[k];
    return null;
  }

  function parseICS(text) {
    const unfolded = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
    const lines = unfolded.split('\n');
    const events = [];
    let cur = null, inAlarm = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; inAlarm = false; continue; }
      if (line === 'END:VEVENT') {
        if (cur && cur.start) {
          const ev = {
            id: uid(),
            title: cur.summary || '(untitled)',
            date: cur.start.date,
            time: cur.start.time,
            allDay: cur.start.allDay,
            endTime: '',
            category: cur.category || mapCategory(cur.categories) || 'personal',
            location: cur.location || '',
            notes: cur.description || '',
            reminder: cur.reminder !== undefined ? cur.reminder : null,
            repeat: null
          };
          if (!ev.allDay && cur.end && cur.end.date === ev.date && cur.end.time && toMinutes(cur.end.time) > toMinutes(ev.time)) ev.endTime = cur.end.time;
          if (cur.rrule) {
            ev.repeat = { freq: cur.rrule.freq, interval: cur.rrule.interval, until: cur.rrule.until, exdates: cur.exdates };
            if (cur.rrule._count && !ev.repeat.until) {
              // Convert COUNT into an until date by walking the occurrences.
              const probe = normalizeEvent(Object.assign({}, ev, { repeat: { freq: ev.repeat.freq, interval: ev.repeat.interval, until: null, exdates: [] } }));
              const far = toDateStr(new Date(parseDateStr(ev.date).getFullYear() + 60, 0, 1));
              const occ = expandEvent(probe, ev.date, far);
              const n = Math.min(cur.rrule._count, occ.length);
              if (n > 0) ev.repeat.until = occ[n - 1].occDate;
            }
          }
          events.push(normalizeEvent(ev));
        }
        cur = null; continue;
      }
      if (!cur) continue;
      if (line === 'BEGIN:VALARM') { inAlarm = true; continue; }
      if (line === 'END:VALARM') { inAlarm = false; continue; }
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const left = line.slice(0, colon), value = line.slice(colon + 1);
      const semi = left.indexOf(';');
      const name = (semi >= 0 ? left.slice(0, semi) : left).toUpperCase();
      const params = semi >= 0 ? left.slice(semi + 1) : '';
      if (inAlarm) {
        if (name === 'TRIGGER') {
          const m = value.match(/^-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/i);
          if (m) cur.reminder = (parseInt(m[1] || 0, 10) * 1440) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
        }
        continue;
      }
      switch (name) {
        case 'SUMMARY': cur.summary = icsUnescape(value).trim(); break;
        case 'DESCRIPTION': cur.description = icsUnescape(value).trim(); break;
        case 'LOCATION': cur.location = icsUnescape(value).trim(); break;
        case 'CATEGORIES': cur.categories = icsUnescape(value); break;
        case 'X-LUMINA-CATEGORY': cur.category = CATEGORIES.indexOf(value.trim()) >= 0 ? value.trim() : null; break;
        case 'DTSTART': cur.start = parseICSDate(value, params); break;
        case 'DTEND': cur.end = parseICSDate(value, params); break;
        case 'RRULE': cur.rrule = parseRRule(value); break;
        case 'EXDATE':
          value.split(',').forEach(function (v) { const d = parseICSDate(v, params); if (d) cur.exdates.push(d.date); });
          break;
        default: break;
      }
    }
    return events;
  }

  /* ---------- Backup / sync JSON ---------- */
  function toBackup(events, settings, version, extra) {
    extra = extra || {};
    return {
      app: 'Lumina Calendar',
      format: 2,
      version: version || '1.1.0',
      exportedAt: new Date().toISOString(),
      device: extra.device || null,
      settings: settings || {},
      calendars: extra.calendars || [],
      deleted: extra.deleted || [],
      events: events
    };
  }

  /* Full parse of a backup/sync file: { events, calendars, deleted, exportedAt } or null. */
  function parseBackup(obj) {
    const events = fromBackup(obj);
    if (!events) return null;
    const calendars = (obj && Array.isArray(obj.calendars)) ? obj.calendars.map(function (c, i) { return normalizeCalendar(c, i); }) : [];
    const deleted = (obj && Array.isArray(obj.deleted)) ? obj.deleted.filter(function (t) { return t && t.id && t.at; }).map(function (t) { return { id: String(t.id), at: String(t.at), type: t.type === 'calendar' ? 'calendar' : 'event' }; }) : [];
    return { events: events, calendars: calendars, deleted: deleted, exportedAt: (obj && obj.exportedAt) || null, device: (obj && obj.device) || null };
  }

  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    return (String(b.updatedAt || '') > String(a.updatedAt || '')) ? b : a;
  }

  /* Signature of a data set — equal signatures mean nothing needs saving or writing. */
  function syncSignature(data) {
    const ev = (data.events || []).map(function (e) { return e.id + '@' + (e.updatedAt || ''); }).sort();
    const cal = (data.calendars || []).map(function (c) { return c.id + '@' + (c.updatedAt || '') + '@' + (c.visible ? 1 : 0) + '@' + c.color + '@' + (c.name || ''); }).sort();
    const del = (data.deleted || []).map(function (t) { return t.type + ':' + t.id + '@' + t.at; }).sort();
    return ev.join('|') + '#' + cal.join('|') + '#' + del.join('|');
  }

  /* Two-way merge used by folder sync: newest edit wins per item, deletions carried by tombstones. */
  function mergeSync(local, remote, now) {
    now = now || new Date();
    const del = {};
    [].concat(local.deleted || [], remote.deleted || []).forEach(function (t) {
      if (!t || !t.id) return;
      const key = (t.type === 'calendar' ? 'calendar:' : 'event:') + t.id;
      if (!del[key] || t.at > del[key].at) del[key] = { id: String(t.id), at: String(t.at), type: t.type === 'calendar' ? 'calendar' : 'event' };
    });
    const events = {};
    [].concat(local.events || [], remote.events || []).forEach(function (e) { events[e.id] = newer(events[e.id], e); });
    const outEvents = Object.keys(events).map(function (id) { return events[id]; }).filter(function (e) {
      const t = del['event:' + e.id];
      return !(t && t.at > String(e.updatedAt || ''));
    });
    const cals = {};
    [].concat(local.calendars || [], remote.calendars || []).forEach(function (c) { cals[c.id] = newer(cals[c.id], c); });
    const outCals = Object.keys(cals).map(function (id) { return cals[id]; }).filter(function (c) {
      const t = del['calendar:' + c.id];
      return !(t && t.at > String(c.updatedAt || ''));
    });
    const cutoff = new Date(now.getTime() - TOMBSTONE_DAYS * 86400000).toISOString();
    const outDeleted = Object.keys(del).map(function (k) { return del[k]; }).filter(function (t) {
      if (t.at < cutoff) return false;
      const live = t.type === 'calendar' ? cals[t.id] : events[t.id];
      return !(live && String(live.updatedAt || '') > t.at);
    });
    outEvents.sort(function (a, b) { return (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')); });
    return { events: outEvents, calendars: normalizeCalendars(outCals), deleted: outDeleted };
  }

  function fromBackup(obj) {
    if (!obj || typeof obj !== 'object') return null;
    let list = null;
    if (Array.isArray(obj)) list = obj;
    else if (Array.isArray(obj.events)) list = obj.events;
    if (!list) return null;
    const out = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      if (!raw.title && !raw.date) continue;
      out.push(normalizeEvent(raw));
    }
    return out;
  }

  const api = {
    CATEGORIES: CATEGORIES, FREQS: FREQS, TOMBSTONE_DAYS: TOMBSTONE_DAYS,
    pad: pad, toDateStr: toDateStr, parseDateStr: parseDateStr, isDateStr: isDateStr, isTimeStr: isTimeStr,
    startOfDay: startOfDay, addDays: addDays, addMonths: addMonths, startOfWeek: startOfWeek, daysBetween: daysBetween, sameDay: sameDay,
    toMinutes: toMinutes, fromMinutes: fromMinutes, occurrenceStart: occurrenceStart, occurrenceEnd: occurrenceEnd, isoWeek: isoWeek, uid: uid,
    normalizeEvent: normalizeEvent, isRecurring: isRecurring, occurrence: makeOccurrence, expandEvent: expandEvent, expand: expand, overlaps: overlaps, layoutDay: layoutDay, matches: matches,
    toICS: toICS, parseICS: parseICS, toBackup: toBackup, fromBackup: fromBackup, parseBackup: parseBackup, mergeSync: mergeSync, syncSignature: syncSignature,
    CATEGORY_COLORS: CATEGORY_COLORS, PALETTE: PALETTE, defaultCalendars: defaultCalendars, normalizeCalendar: normalizeCalendar, normalizeCalendars: normalizeCalendars, calendarColor: calendarColor, isColor: isColor
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.LuminaCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
