/* Lumina Calendar — application (views, editor, quick add, calendars, feeds, settings, reminders, sync, sharing). */
(function () {
  'use strict';

  const APP_VERSION = '1.1.0';
  const T = LuminaI18n.t;
  const C = LuminaCore;
  const S = LuminaStore;
  const NLP = LuminaNLP;
  const ICON = LuminaIcons.icon;
  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  const REMINDER_OPTIONS = [null, 0, 5, 10, 15, 30, 60, 120, 1440];
  const PX_PER_HOUR = 56;
  const SETTINGS_KEY = 'lumina.settings';
  const FIRED_KEY = 'lumina.fired';
  const DEVICE_KEY = 'lumina.device';
  const BACKUP_FILE = 'lumina-calendar-backup.json';
  const FS_SUPPORTED = typeof window.showDirectoryPicker === 'function';
  const SYNC_POLL_MS = 20000;
  const FEED_REFRESH_MS = 6 * 3600000;

  function defaultSettings() {
    return {
      lang: (navigator.language || 'en').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en',
      theme: 'system',
      weekStart: 0,
      timeFormat: '12',
      numerals: 'latn',
      hijri: false,
      sound: true,
      welcomed: false,
      lastBackup: null
    };
  }

  const state = {
    settings: defaultSettings(),
    events: [],
    calendars: [],
    feedEvents: {},
    deleted: [],
    view: 'month',
    prevView: 'month',
    cursor: C.startOfDay(new Date()),
    selected: C.startOfDay(new Date()),
    query: '',
    editing: null,
    backupHandle: null,
    backupPermission: 'none',
    syncing: false,
    syncFileModified: null,
    deviceId: null,
    fired: new Set(),
    swReg: null,
    updateAccepted: false,
    weekScrollTop: null,
    lastFocus: null,
    quickParse: null
  };

  /* ======================================================================
     Helpers
     ====================================================================== */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
  }

  function locale() {
    if (state.settings.lang === 'ar') return 'ar-u-nu-' + (state.settings.numerals === 'arab' ? 'arab' : 'latn');
    return 'en-US';
  }

  function hijriLocale() {
    return (state.settings.lang === 'ar' ? 'ar' : 'en') + '-u-ca-islamic-umalqura-nu-' + (state.settings.lang === 'ar' && state.settings.numerals === 'arab' ? 'arab' : 'latn');
  }

  function fmtDate(d, opts) {
    try { return new Intl.DateTimeFormat(locale(), opts).format(d); } catch (e) { return d.toDateString(); }
  }

  function fmtRange(a, b, opts) {
    try {
      const f = new Intl.DateTimeFormat(locale(), opts);
      if (typeof f.formatRange === 'function') return f.formatRange(a, b);
      return f.format(a) + ' – ' + f.format(b);
    } catch (e) { return fmtDate(a, opts) + ' – ' + fmtDate(b, opts); }
  }

  function fmtNum(n) {
    try { return new Intl.NumberFormat(locale(), { useGrouping: false }).format(n); } catch (e) { return String(n); }
  }

  function hourCycle() { return state.settings.timeFormat === '24' ? 'h23' : 'h12'; }

  function fmtTime(hhmm, compact) {
    if (!C.isTimeStr(hhmm)) return '';
    const m = C.toMinutes(hhmm);
    const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
    const opts = { hour: 'numeric', hourCycle: hourCycle() };
    if (!compact || m % 60 !== 0 || state.settings.timeFormat === '24') opts.minute = '2-digit';
    return fmtDate(d, opts);
  }

  function fmtHour(h) {
    const d = new Date(2000, 0, 1, h, 0);
    if (state.settings.timeFormat === '24') return fmtDate(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return fmtDate(d, { hour: 'numeric', hourCycle: 'h12' });
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return fmtDate(d, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: hourCycle() });
  }

  function fmtHijri(d, opts) {
    try { return new Intl.DateTimeFormat(hijriLocale(), opts || { day: 'numeric', month: 'long', year: 'numeric' }).format(d); } catch (e) { return ''; }
  }

  function hijriCell(d) {
    try {
      const parts = new Intl.DateTimeFormat(hijriLocale(), { day: 'numeric', month: 'short' }).formatToParts(d);
      const day = parts.filter(function (p) { return p.type === 'day'; }).map(function (p) { return p.value; })[0] || '';
      const dayNum = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric' }).format(d);
      if (dayNum === '1') return parts.map(function (p) { return p.value; }).join('');
      return day;
    } catch (e) { return ''; }
  }

  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(total / 60), m = total % 60;
    return T('durationHM', { h: h, m: m, H: fmtNum(h), M: fmtNum(m) });
  }

  function countLabel(n) { return T('events', { n: n, N: fmtNum(n) }); }

  function todayStr() { return C.toDateStr(new Date()); }

  function nowIso() { return new Date().toISOString(); }

  function isWeekend(d) {
    const wd = d.getDay();
    return state.settings.lang === 'ar' ? (wd === 5 || wd === 6) : (wd === 0 || wd === 6);
  }

  function reminderLabel(mins) {
    if (mins === null || mins === undefined) return T('rem_none');
    if (LuminaI18n.has('rem_' + mins)) return T('rem_' + mins);
    return fmtDuration(mins * 60000);
  }

  function reminderShort(mins) {
    if (mins === 0) return T('rem_0');
    if (mins === 1440) return T('oneDay');
    return fmtDuration(mins * 60000);
  }

  function repeatLabel(rep) {
    if (!rep || rep.freq === 'none') return T('rep_none');
    let s = T('rep_' + rep.freq);
    if (rep.interval > 1) s += ' ×' + fmtNum(rep.interval);
    return s;
  }

  function findEvent(id) { return state.events.find(function (e) { return e.id === id; }); }

  function findAnyEvent(id) {
    const local = findEvent(id);
    if (local) return local;
    for (const key in state.feedEvents) {
      const hit = (state.feedEvents[key] || []).find(function (e) { return e.id === id; });
      if (hit) return hit;
    }
    return null;
  }

  function plainEvents() { return JSON.parse(JSON.stringify(state.events)); }
  function plainCalendars() { return JSON.parse(JSON.stringify(state.calendars)); }

  /* ---------- calendars ---------- */
  function cal(id) { return state.calendars.find(function (c) { return c.id === id; }); }
  function calName(c) { if (!c) return ''; return c.name || (c.builtin ? T('cat_' + c.id) : c.id); }
  function calColor(id) { const c = cal(id); return c ? c.color : (C.CATEGORY_COLORS[id] || '#a855f7'); }
  function catStyle(id) { return ' style="--cat:' + esc(calColor(id)) + '"'; }
  function localCalendars() { return state.calendars.filter(function (c) { return c.kind === 'local'; }); }
  function fallbackCalendarId() { return cal('personal') ? 'personal' : (localCalendars()[0] || state.calendars[0]).id; }
  function calendarNames() {
    const map = {};
    state.calendars.forEach(function (c) { map[c.id] = calName(c); });
    return map;
  }

  /* Events that should currently be shown: local events of visible calendars + visible feed events. */
  function allEvents() {
    const visible = {};
    state.calendars.forEach(function (c) { visible[c.id] = c.visible; });
    const out = state.events.filter(function (e) { return visible[e.category] !== false; });
    state.calendars.forEach(function (c) {
      if (c.kind === 'feed' && c.visible) (state.feedEvents[c.id] || []).forEach(function (e) { out.push(e); });
    });
    return out;
  }

  /* ======================================================================
     Settings / theme / language
     ====================================================================== */
  function loadSettingsSync() {
    try { Object.assign(state.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* ignore */ }
  }

  async function loadSettings() {
    loadSettingsSync();
    try {
      const saved = await S.kvGet('settings');
      if (saved && typeof saved === 'object') Object.assign(state.settings, saved);
    } catch (e) { /* ignore */ }
    const s = state.settings;
    s.weekStart = [0, 1, 6].indexOf(Number(s.weekStart)) >= 0 ? Number(s.weekStart) : 0;
    s.lang = s.lang === 'ar' ? 'ar' : 'en';
    s.theme = ['system', 'light', 'dark'].indexOf(s.theme) >= 0 ? s.theme : 'system';
    s.timeFormat = s.timeFormat === '24' ? '24' : '12';
    s.numerals = s.numerals === 'arab' ? 'arab' : 'latn';
    try {
      state.deviceId = localStorage.getItem(DEVICE_KEY);
      if (!state.deviceId) { state.deviceId = C.uid(); localStorage.setItem(DEVICE_KEY, state.deviceId); }
    } catch (e) { state.deviceId = 'device'; }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
    S.kvSet('settings', JSON.parse(JSON.stringify(state.settings))).catch(function () { /* ignore */ });
  }

  const mqLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function resolvedTheme() {
    const t = state.settings.theme;
    if (t === 'system') return (mqLight && mqLight.matches) ? 'light' : 'dark';
    return t;
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.setAttribute('data-theme', theme);
    const color = theme === 'light' ? '#eef0f6' : '#0a0a0c';
    $$('meta[name="theme-color"]').forEach(function (m) { m.setAttribute('content', color); });
    $$('#theme-seg .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.themeOpt === state.settings.theme); });
  }

  if (mqLight && mqLight.addEventListener) mqLight.addEventListener('change', function () { if (state.settings.theme === 'system') applyTheme(); });

  function applyLang() {
    const lang = LuminaI18n.setLanguage(state.settings.lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = T('appName');
    $$('[data-i18n]').forEach(function (el) { el.textContent = T(el.getAttribute('data-i18n')); });
    $$('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = T(el.getAttribute('data-i18n-placeholder')); });
    $$('[data-i18n-title]').forEach(function (el) { const v = T(el.getAttribute('data-i18n-title')); el.title = v; el.setAttribute('aria-label', v); });
    $$('#lang-seg .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.lang === lang); });
    $('#row-numerals').hidden = lang !== 'ar';
    buildCategoryGrid();
    buildSelects();
    syncSettingsUI();
    renderQuickPreview();
    if (!$('#calendars-modal').hidden) renderCalendarManager();
  }

  function buildCategoryGrid() {
    const grid = $('#cat-grid');
    const current = (grid.querySelector('input:checked') || {}).value || 'work';
    grid.innerHTML = localCalendars().map(function (c) {
      return '<label class="cat-option"><input type="radio" name="category" value="' + esc(c.id) + '"' + (c.id === current ? ' checked' : '') + '><span' + catStyle(c.id) + '>' + esc(calName(c)) + '</span></label>';
    }).join('');
    if (!grid.querySelector('input:checked')) { const first = grid.querySelector('input'); if (first) first.checked = true; }
  }

  function buildSelects() {
    const rep = $('#ev-repeat');
    const repVal = rep.value || 'none';
    rep.innerHTML = C.FREQS.map(function (f) { return '<option value="' + f + '">' + esc(T('rep_' + f)) + '</option>'; }).join('');
    rep.value = repVal;
    const rem = $('#ev-reminder');
    const remVal = rem.value;
    rem.innerHTML = REMINDER_OPTIONS.map(function (r) { return '<option value="' + (r === null ? '' : r) + '">' + esc(reminderLabel(r)) + '</option>'; }).join('');
    rem.value = remVal;
  }

  function syncSettingsUI() {
    const s = state.settings;
    $('#set-weekstart').value = String(s.weekStart);
    $('#set-timefmt').value = s.timeFormat;
    $('#set-numerals').value = s.numerals;
    $('#set-hijri').checked = !!s.hijri;
    $('#set-sound').checked = !!s.sound;
    $('#app-version').textContent = APP_VERSION;
    $$('#theme-seg .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.themeOpt === s.theme); });
    updateNotifUI();
    updateBackupUI();
  }

  /* ======================================================================
     Rendering
     ====================================================================== */
  function render() {
    renderPeriodLabel();
    renderView();
    renderSidebar();
    renderStats();
    renderCalendarList();
    $$('.seg-btn[data-view]').forEach(function (b) {
      const active = b.dataset.view === state.view;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function renderPeriodLabel() {
    const el = $('#period-label');
    if (state.view === 'month') {
      el.textContent = fmtDate(state.cursor, { month: 'long', year: 'numeric' });
    } else if (state.view === 'week') {
      const start = C.startOfWeek(state.cursor, state.settings.weekStart);
      const end = C.addDays(start, 6);
      el.textContent = fmtRange(start, end, { month: 'short', day: 'numeric', year: 'numeric' });
    } else {
      el.textContent = state.query ? T('searchResults') : (T('upcoming') + ' · ' + fmtDate(state.selected, { month: 'short', day: 'numeric' }));
    }
  }

  function renderView() {
    const root = $('#view-root');
    if (state.view === 'month') renderMonth(root);
    else if (state.view === 'week') renderWeek(root);
    else renderAgenda(root);
  }

  /* ---------- Month ---------- */
  function chipHtml(o) {
    const draggable = !o.recurring && !o.feed;
    return '<div class="chip' + (o.allDay ? ' allday' : '') + (o.recurring ? ' recurring' : '') + (o.feed ? ' feed' : '') + '"' + catStyle(o.category) + ' draggable="' + draggable + '" data-id="' + esc(o.event.id) + '" data-occ="' + o.occDate + '" title="' + esc(o.title) + (o.allDay ? '' : ' · ' + esc(fmtTime(o.time))) + '" tabindex="0" role="button">' +
      (o.allDay ? '' : '<span class="chip-time">' + esc(fmtTime(o.time, true)) + '</span>') +
      '<span class="chip-title">' + esc(o.title) + '</span></div>';
  }

  /* How many event chips fit in a month cell at the current window size. */
  function monthChipLimit(root) {
    const fixedHeight = window.matchMedia && window.matchMedia('(min-width: 1101px)').matches;
    if (!fixedHeight) return 3;
    const gridHeight = root.clientHeight - 40 - 34 - 40; // paddings, weekday row, row gaps
    const rowHeight = gridHeight / 6;
    const chipRows = Math.floor((rowHeight - 30) / 23);
    return Math.max(1, Math.min(4, chipRows));
  }

  function renderMonth(root) {
    const y = state.cursor.getFullYear(), m = state.cursor.getMonth();
    const gridStart = C.startOfWeek(new Date(y, m, 1), state.settings.weekStart);
    const gridEnd = C.addDays(gridStart, 41);
    const occ = C.expand(allEvents(), C.toDateStr(gridStart), C.toDateStr(gridEnd));
    const byDate = {};
    occ.forEach(function (o) { (byDate[o.occDate] = byDate[o.occDate] || []).push(o); });
    const tStr = todayStr(), sStr = C.toDateStr(state.selected);
    const showHijri = !!state.settings.hijri;
    const maxChips = monthChipLimit(root);

    let html = '<div class="weekdays">';
    for (let i = 0; i < 7; i++) {
      const d = C.addDays(gridStart, i);
      html += '<div class="' + (isWeekend(d) ? 'weekend' : '') + '">' + esc(fmtDate(d, { weekday: 'short' })) + '</div>';
    }
    html += '</div><div class="month-grid" id="month-grid">';
    for (let i = 0; i < 42; i++) {
      const d = C.addDays(gridStart, i);
      const ds = C.toDateStr(d);
      const list = byDate[ds] || [];
      const cls = ['day'];
      if (d.getMonth() !== m) cls.push('other');
      if (ds === tStr) cls.push('today');
      if (ds === sStr) cls.push('selected');
      html += '<div class="' + cls.join(' ') + '" data-date="' + ds + '" tabindex="0" role="button" aria-label="' + esc(fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })) + (list.length ? ', ' + esc(countLabel(list.length)) : '') + '">';
      html += '<div class="day-head"><span class="day-num">' + fmtNum(d.getDate()) + '</span>' + (showHijri ? '<span class="day-hijri">' + esc(hijriCell(d)) + '</span>' : '') + '</div>';
      html += '<button type="button" class="icon-btn sm day-add" data-add="' + ds + '" title="' + esc(T('addEventOn', { date: fmtDate(d, { month: 'short', day: 'numeric' }) })) + '" tabindex="-1">' + ICON('plus', 'xs') + '</button>';
      if (list.length) {
        html += '<div class="day-events">';
        const shown = list.length <= maxChips ? list.length : (maxChips >= 2 ? maxChips - 1 : 0);
        list.slice(0, shown).forEach(function (o) { html += chipHtml(o); });
        if (list.length > shown) {
          html += '<span class="day-more">' + esc(shown ? T('more', { n: list.length - shown, N: fmtNum(list.length - shown) }) : countLabel(list.length)) + '</span>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    root.innerHTML = html;
  }

  /* ---------- Week ---------- */
  function renderWeek(root) {
    const start = C.startOfWeek(state.cursor, state.settings.weekStart);
    const end = C.addDays(start, 6);
    const occ = C.expand(allEvents(), C.toDateStr(start), C.toDateStr(end));
    const byDate = {};
    occ.forEach(function (o) { (byDate[o.occDate] = byDate[o.occDate] || []).push(o); });
    const tStr = todayStr(), sStr = C.toDateStr(state.selected);
    const now = new Date();

    let head = '<div class="week-head"><div></div>';
    let allday = '<div class="week-allday"><div class="lbl">' + esc(T('allDay')) + '</div>';
    let cols = '';
    for (let i = 0; i < 7; i++) {
      const d = C.addDays(start, i);
      const ds = C.toDateStr(d);
      const list = byDate[ds] || [];
      head += '<div class="week-day-head' + (ds === tStr ? ' today' : '') + (ds === sStr ? ' selected' : '') + '" data-date="' + ds + '" role="button" tabindex="0"><div class="wd">' + esc(fmtDate(d, { weekday: 'short' })) + '</div><div class="dn">' + fmtNum(d.getDate()) + '</div></div>';
      allday += '<div class="cell" data-date="' + ds + '">' + list.filter(function (o) { return o.allDay; }).map(chipHtml).join('') + '</div>';

      let col = '<div class="week-col' + (ds === tStr ? ' today' : '') + '" data-date="' + ds + '">';
      for (let h = 1; h < 24; h++) {
        col += '<div class="hour-line" style="top:' + (h * PX_PER_HOUR) + 'px"></div>';
        col += '<div class="hour-line half" style="top:' + ((h - 0.5) * PX_PER_HOUR) + 'px"></div>';
      }
      col += '<div class="hour-line half" style="top:' + (23.5 * PX_PER_HOUR) + 'px"></div>';
      const timed = list.filter(function (o) { return !o.allDay; });
      const layout = C.layoutDay(timed);
      timed.forEach(function (o) {
        const sMin = C.toMinutes(o.time);
        let eMin = C.isTimeStr(o.endTime) ? C.toMinutes(o.endTime) : sMin + 60;
        if (eMin <= sMin) eMin = sMin + 60;
        eMin = Math.min(eMin, 1440);
        const top = sMin / 60 * PX_PER_HOUR;
        const height = Math.max((eMin - sMin) / 60 * PX_PER_HOUR, 22);
        const lay = layout[o.key] || { col: 0, cols: 1 };
        const w = 100 / lay.cols;
        col += '<div class="wk-event' + (o.feed ? ' feed' : '') + '" data-id="' + esc(o.event.id) + '" data-occ="' + o.occDate + '" tabindex="0" role="button" title="' + esc(o.title) + '" style="--cat:' + esc(calColor(o.category)) + ';top:' + top + 'px;height:' + height + 'px;inset-inline-start:calc(' + (lay.col * w) + '% + 2px);width:calc(' + w + '% - 4px)">' +
          '<div class="t">' + esc(o.title) + '</div>' +
          (height >= 34 ? '<div class="m">' + esc(fmtTime(o.time, true)) + (C.isTimeStr(o.endTime) ? ' – ' + esc(fmtTime(o.endTime, true)) : '') + '</div>' : '') +
          '</div>';
      });
      if (ds === tStr) col += '<div class="now-line" id="now-line" style="top:' + ((now.getHours() * 60 + now.getMinutes()) / 60 * PX_PER_HOUR) + 'px"></div>';
      col += '</div>';
      cols += col;
    }
    head += '</div>';
    allday += '</div>';

    let hours = '<div class="hours">';
    for (let h = 1; h < 24; h++) hours += '<div class="hour-lbl" style="top:' + (h * PX_PER_HOUR) + 'px">' + esc(fmtHour(h)) + '</div>';
    hours += '</div>';

    root.innerHTML = '<div class="week">' + head + allday + '<div class="week-body" id="week-body"><div class="week-grid">' + hours + cols + '</div></div></div>';

    const body = $('#week-body');
    if (state.weekScrollTop === null) {
      const inWeek = C.daysBetween(start, now) >= 0 && C.daysBetween(start, now) <= 6;
      body.scrollTop = inWeek ? Math.max(0, (now.getHours() - 1) * PX_PER_HOUR) : 7 * PX_PER_HOUR;
    } else {
      body.scrollTop = state.weekScrollTop;
    }
    body.addEventListener('scroll', function () { state.weekScrollTop = body.scrollTop; }, { passive: true });
  }

  /* ---------- Agenda item (shared) ---------- */
  function agendaItemHtml(o, opts) {
    opts = opts || {};
    const now = Date.now();
    const start = C.occurrenceStart(o, o.occDate), end = C.occurrenceEnd(o, o.occDate);
    let cls = '';
    if (o.occDate === todayStr() && !o.allDay) {
      if (end <= now) cls = ' past';
      else if (start <= now) cls = ' now';
    } else if (o.occDate < todayStr()) {
      cls = ' past';
    }
    const timeHtml = o.allDay
      ? '<span class="s">' + esc(T('allDay')) + '</span>'
      : '<span class="s">' + esc(fmtTime(o.time)) + '</span>' + (C.isTimeStr(o.endTime) ? '<span class="e">' + esc(fmtTime(o.endTime)) + '</span>' : '');
    const meta = [];
    if (opts.showDate) meta.push('<span>' + ICON('calendar', 'xs') + esc(fmtDate(C.parseDateStr(o.occDate), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })) + '</span>');
    if (o.location) meta.push('<span class="loc">' + ICON('map-pin', 'xs') + esc(o.location) + '</span>');
    if (o.recurring) meta.push('<span>' + ICON('repeat', 'xs') + esc(T('repeatsBadge')) + '</span>');
    if (o.reminder !== null && o.reminder !== undefined) meta.push('<span title="' + esc(reminderLabel(o.reminder)) + '">' + ICON('bell', 'xs') + esc(reminderShort(o.reminder)) + '</span>');
    if (opts.overlap) meta.push('<span class="badge warn">' + esc(T('overlaps')) + '</span>');
    meta.push('<span class="badge"' + catStyle(o.category) + '>' + (o.feed ? ICON('globe', 'xs') : '') + esc(calName(cal(o.category)) || o.category) + '</span>');
    return '<div class="agenda-item' + cls + (o.feed ? ' feed' : '') + '"' + catStyle(o.category) + ' data-id="' + esc(o.event.id) + '" data-occ="' + o.occDate + '" tabindex="0" role="button">' +
      '<div class="bar"></div><div class="time">' + timeHtml + '</div>' +
      '<div class="body"><div class="title">' + esc(o.title) + '</div><div class="meta">' + meta.join('') + '</div></div>' +
      '<div class="actions"><button type="button" class="icon-btn sm" data-edit title="' + esc(T(o.feed ? 'shareEvent' : 'edit')) + '" aria-label="' + esc(T('edit')) + '">' + ICON(o.feed ? 'eye' : 'pencil', 'sm') + '</button>' +
      (o.feed ? '' : '<button type="button" class="icon-btn sm" data-del title="' + esc(T('delete')) + '" aria-label="' + esc(T('delete')) + '">' + ICON('trash-2', 'sm') + '</button>') + '</div></div>';
  }

  function overlapKeys(list) {
    const keys = new Set();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (C.overlaps(list[i], list[j])) { keys.add(list[i].key); keys.add(list[j].key); }
      }
    }
    return keys;
  }

  function emptyStateHtml(title, hint, withButton) {
    return '<div class="empty fade-in">' + ICON('coffee') + '<p>' + esc(title) + '</p>' + (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') +
      (withButton ? '<button type="button" class="btn btn-sm btn-primary" data-add="' + C.toDateStr(state.selected) + '" style="margin-top:10px">' + ICON('plus', 'sm') + esc(T('firstEvent')) + '</button>' : '') + '</div>';
  }

  /* ---------- Agenda view ---------- */
  function renderAgenda(root) {
    let html = '<div class="agenda-view">';
    if (state.query) {
      const matched = allEvents().filter(function (e) { return C.matches(e, state.query); })
        .map(function (e) { return C.occurrence(e, e.date); })
        .sort(function (a, b) { return (a.occDate + (a.time || '')).localeCompare(b.occDate + (b.time || '')); });
      html += '<div class="agenda-group"><div class="agenda-group-head"><span class="d">' + esc(T('searchResults')) + '</span><span class="w">' + esc(countLabel(matched.length)) + '</span></div>';
      html += matched.length ? matched.map(function (o) { return agendaItemHtml(o, { showDate: true }); }).join('') : emptyStateHtml(T('noResults'), '');
      html += '</div>';
    } else {
      const from = C.toDateStr(state.selected);
      const to = C.toDateStr(C.addDays(state.selected, 90));
      const occ = C.expand(allEvents(), from, to);
      if (!occ.length) {
        html += emptyStateHtml(T('nothingUpcoming'), '', true);
      } else {
        const groups = [];
        let cur = null;
        occ.forEach(function (o) {
          if (!cur || cur.date !== o.occDate) { cur = { date: o.occDate, items: [] }; groups.push(cur); }
          cur.items.push(o);
        });
        groups.forEach(function (g) {
          const d = C.parseDateStr(g.date);
          const ov = overlapKeys(g.items);
          html += '<div class="agenda-group"><div class="agenda-group-head glass' + (g.date === todayStr() ? ' today' : '') + '" style="border-radius:12px"><span class="d">' + fmtNum(d.getDate()) + '</span><span class="w">' + esc(fmtDate(d, { weekday: 'long' })) + ' · ' + esc(fmtDate(d, { month: 'long', year: 'numeric' })) + (g.date === todayStr() ? ' · ' + esc(T('today')) : '') + '</span>' + (state.settings.hijri ? '<span class="h">' + esc(fmtHijri(d)) + '</span>' : '') + '</div>';
          html += g.items.map(function (o) { return agendaItemHtml(o, { overlap: ov.has(o.key) }); }).join('');
          html += '</div>';
        });
      }
    }
    html += '</div>';
    root.innerHTML = html;
  }

  /* ---------- Sidebar ---------- */
  function renderSidebar() {
    const d = state.selected, ds = C.toDateStr(d);
    const isToday = ds === todayStr();
    $('#side-date').textContent = fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' }) + (isToday ? ' · ' + T('today') : '');
    const hj = $('#side-hijri');
    hj.hidden = !state.settings.hijri;
    if (state.settings.hijri) hj.textContent = fmtHijri(d);

    const list = C.expand(allEvents(), ds, ds);
    const ov = overlapKeys(list);
    const listEl = $('#side-list');
    listEl.innerHTML = list.length
      ? list.map(function (o) { return agendaItemHtml(o, { overlap: ov.has(o.key) }); }).join('')
      : emptyStateHtml(T('noEventsTitle'), isToday ? T('freeDay') : T('noEventsHint'), true);

    const nextEl = $('#next-up');
    if (isToday && list.length) {
      const now = Date.now();
      let html = '';
      const current = list.find(function (o) { return !o.allDay && C.occurrenceStart(o, o.occDate) <= now && C.occurrenceEnd(o, o.occDate) > now; });
      const upcoming = list.find(function (o) { return !o.allDay && C.occurrenceStart(o, o.occDate) > now; });
      if (current) html = ICON('timer', 'sm') + '<span><b>' + esc(current.title) + '</b> · ' + esc(T('inProgress')) + '</span>';
      else if (upcoming) html = ICON('bell', 'sm') + '<span>' + esc(T('nextUp')) + ': <b>' + esc(upcoming.title) + '</b> ' + esc(T('startsIn', { time: fmtDuration(C.occurrenceStart(upcoming, upcoming.occDate) - now) })) + '</span>';
      else if (list.some(function (o) { return !o.allDay; })) html = ICON('circle-check', 'sm') + '<span>' + esc(T('allDone')) + '</span>';
      nextEl.innerHTML = html;
      nextEl.hidden = !html;
    } else {
      nextEl.hidden = true;
    }
  }

  function renderStats() {
    const y = state.cursor.getFullYear(), m = state.cursor.getMonth();
    const mStart = new Date(y, m, 1), mEnd = new Date(y, m + 1, 0);
    const events = allEvents();
    const monthCount = C.expand(events, C.toDateStr(mStart), C.toDateStr(mEnd)).length;
    const wStart = C.startOfWeek(new Date(), state.settings.weekStart);
    const weekCount = C.expand(events, C.toDateStr(wStart), C.toDateStr(C.addDays(wStart, 6))).length;
    $('#stat-month').textContent = countLabel(monthCount);
    $('#stat-week').textContent = countLabel(weekCount);
  }

  function renderCalendarList() {
    $('#cal-list').innerHTML = state.calendars.map(function (c) {
      return '<div class="cal-row' + (c.visible ? '' : ' off') + '"' + catStyle(c.id) + ' data-cal="' + esc(c.id) + '" role="checkbox" aria-checked="' + (c.visible ? 'true' : 'false') + '" tabindex="0" title="' + esc(T(c.visible ? 'hideCalendar' : 'showCalendar')) + '"><i class="cal-dot"></i>' + esc(calName(c)) + (c.kind === 'feed' ? ICON('globe', 'xs') : '') + '</div>';
    }).join('');
  }

  function updateNowLine() {
    const line = $('#now-line');
    if (!line) return;
    const now = new Date();
    line.style.top = ((now.getHours() * 60 + now.getMinutes()) / 60 * PX_PER_HOUR) + 'px';
  }

  /* ======================================================================
     Navigation
     ====================================================================== */
  function setView(v) {
    if (v !== 'agenda' && state.query) clearSearch(false);
    if (v === 'week' && state.view !== 'week') {
      state.weekScrollTop = null;
      const sameMonth = state.selected.getMonth() === state.cursor.getMonth() && state.selected.getFullYear() === state.cursor.getFullYear();
      state.cursor = (sameMonth || state.view === 'agenda') ? new Date(state.selected) : new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
    }
    state.view = v;
    render();
  }

  function navigate(delta) {
    if (state.view === 'month') state.cursor = C.addMonths(state.cursor, delta);
    else if (state.view === 'week') state.cursor = C.addDays(state.cursor, 7 * delta);
    else { state.selected = C.addDays(state.selected, 30 * delta); state.cursor = new Date(state.selected.getFullYear(), state.selected.getMonth(), 1); }
    render();
  }

  function goToday() {
    const now = C.startOfDay(new Date());
    state.cursor = state.view === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : now;
    state.selected = now;
    state.weekScrollTop = null;
    render();
  }

  function selectDay(ds) {
    const d = C.parseDateStr(ds);
    if (!d) return;
    state.selected = d;
    if (state.view === 'month' && (d.getMonth() !== state.cursor.getMonth() || d.getFullYear() !== state.cursor.getFullYear())) {
      state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
    } else if (state.view === 'week') {
      state.cursor = d;
    }
    render();
  }

  function goToDate(ds) {
    const d = C.parseDateStr(ds);
    if (!d) return;
    state.selected = d;
    state.cursor = state.view === 'month' ? new Date(d.getFullYear(), d.getMonth(), 1) : d;
    render();
  }

  function clearSearch(doRender) {
    state.query = '';
    $('#search').value = '';
    $('#search').classList.remove('has-value');
    $('#search-clear').hidden = true;
    if (state.view === 'agenda' && state.prevView !== 'agenda') state.view = state.prevView;
    if (doRender !== false) render();
  }

  function onSearchInput() {
    const q = $('#search').value.trim();
    $('#search-clear').hidden = !q;
    $('#search').classList.toggle('has-value', !!q);
    if (q && !state.query) { state.prevView = state.view; state.view = 'agenda'; }
    state.query = q;
    if (!q && state.view === 'agenda' && state.prevView !== 'agenda') state.view = state.prevView;
    render();
  }

  /* ======================================================================
     Modals
     ====================================================================== */
  function openModal(id) {
    const m = $('#' + id);
    state.lastFocus = document.activeElement;
    m.hidden = false;
    const first = m.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=color]), select, textarea, button:not([data-close])');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function closeModal(m) {
    if (typeof m === 'string') m = $('#' + m);
    if (!m || m.hidden) return;
    m.hidden = true;
    m.dispatchEvent(new CustomEvent('modal:close'));
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') { try { state.lastFocus.focus(); } catch (e) { /* ignore */ } }
  }

  function closeTopModal() {
    const open = $$('.modal').filter(function (m) { return !m.hidden; });
    if (open.length) { closeModal(open[open.length - 1]); return true; }
    return false;
  }

  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      const m = $('#confirm-modal');
      $('#confirm-title').textContent = opts.title || '';
      const msg = $('#confirm-msg');
      msg.textContent = opts.message || '';
      msg.style.whiteSpace = opts.pre ? 'pre-line' : '';
      const box = $('#confirm-buttons');
      box.innerHTML = '';
      let settled = false;
      const finish = function (v) { if (settled) return; settled = true; resolve(v); };
      (opts.buttons || []).forEach(function (b, i) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn' + (b.danger ? ' btn-danger' : b.primary ? ' btn-primary' : b.ghost ? ' btn-ghost' : '');
        btn.textContent = b.label;
        btn.addEventListener('click', function () { finish(b.value); closeModal(m); });
        if (i === 0 && !b.ghost) btn.style.marginInlineStart = 'auto';
        box.appendChild(btn);
      });
      m.addEventListener('modal:close', function () { finish(null); }, { once: true });
      openModal('confirm-modal');
    });
  }

  /* ======================================================================
     Toasts
     ====================================================================== */
  function toast(message, type, opts) {
    opts = opts || {};
    const stack = $('#toast-stack');
    while (stack.children.length >= 4) stack.removeChild(stack.firstChild);
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    const iconName = type === 'success' ? 'circle-check' : type === 'danger' ? 'circle-alert' : type === 'reminder' ? 'bell-ring' : type === 'warn' ? 'triangle-alert' : 'info';
    el.innerHTML = ICON(iconName) + '<div class="msg">' + (opts.title ? '<b>' + esc(opts.title) + '</b>' : '') + esc(message) + '</div>' +
      (opts.action ? '<button type="button" class="btn btn-sm btn-primary">' + esc(opts.action) + '</button>' : '') +
      '<button type="button" class="icon-btn sm" aria-label="' + esc(T('close')) + '">' + ICON('x', 'sm') + '</button>';
    const buttons = el.querySelectorAll('button');
    if (opts.action) buttons[0].addEventListener('click', function () { el.remove(); if (opts.onAction) opts.onAction(); });
    buttons[buttons.length - 1].addEventListener('click', function () { el.remove(); });
    stack.appendChild(el);
    const ttl = opts.sticky ? 0 : (opts.duration || 4500);
    if (ttl) setTimeout(function () { if (el.parentNode) el.remove(); }, ttl);
    return el;
  }

  /* ======================================================================
     Persistence
     ====================================================================== */
  let persistChain = Promise.resolve();

  /* Save to IndexedDB only. */
  function persistLocal() {
    const events = plainEvents(), calendars = plainCalendars(), deleted = state.deleted.slice();
    persistChain = persistChain
      .then(function () { return S.replaceAllEvents(events); })
      .then(function () { return S.kvSet('calendars', calendars); })
      .then(function () { return S.kvSet('tombstones', deleted); })
      .catch(function (err) { console.error('Could not save', err); });
    return persistChain;
  }

  /* Save locally and push the change to the sync folder. */
  function persist() {
    persistLocal();
    scheduleSync();
    return persistChain;
  }

  function tombstone(id, type) {
    type = type || 'event';
    state.deleted = state.deleted.filter(function (t) { return !(t.id === id && t.type === type); });
    state.deleted.push({ id: id, at: nowIso(), type: type });
  }

  function untombstone(id, type) {
    type = type || 'event';
    state.deleted = state.deleted.filter(function (t) { return !(t.id === id && t.type === type); });
  }

  async function loadData() {
    let list = [];
    try { list = await S.getAllEvents(); } catch (e) { console.error(e); }
    list = (list || []).map(C.normalizeEvent);
    if (!list.length) {
      // Migrate data saved by the original single-page version of Lumina.
      try {
        const old = JSON.parse(localStorage.getItem('lumina_events') || 'null');
        if (Array.isArray(old) && old.length) {
          list = old.map(C.normalizeEvent);
          await S.replaceAllEvents(list);
          localStorage.removeItem('lumina_events');
        }
      } catch (e) { /* ignore */ }
    }
    state.events = list;
    let cals = null, dead = null;
    try { cals = await S.kvGet('calendars'); dead = await S.kvGet('tombstones'); } catch (e) { /* ignore */ }
    state.calendars = C.normalizeCalendars(cals || []);
    state.deleted = Array.isArray(dead) ? dead : [];
    // events pointing at a calendar that no longer exists fall back to Personal
    const ids = {};
    state.calendars.forEach(function (c) { ids[c.id] = true; });
    state.events.forEach(function (e) { if (!ids[e.category]) e.category = fallbackCalendarId(); });
    for (const c of state.calendars) {
      if (c.kind !== 'feed') continue;
      try { state.feedEvents[c.id] = ((await S.kvGet('feed:' + c.id)) || []).map(C.normalizeEvent).map(function (e) { e.category = c.id; e.feed = true; return e; }); } catch (e) { state.feedEvents[c.id] = []; }
    }
  }

  /* ======================================================================
     Event editor
     ====================================================================== */
  function nextSlot(forDate) {
    const now = new Date();
    if (forDate !== todayStr()) return '09:00';
    const mins = now.getHours() * 60 + now.getMinutes();
    const rounded = Math.ceil((mins + 1) / 30) * 30;
    return C.fromMinutes(Math.min(rounded, 23 * 60 + 30));
  }

  function setCategory(c) {
    const r = $('#cat-grid input[value="' + c + '"]');
    if (r) r.checked = true;
    else { const first = $('#cat-grid input'); if (first) first.checked = true; }
  }

  function updateEditorUI() {
    const allDay = $('#ev-allday').checked;
    $('#ev-time').disabled = allDay;
    $('#ev-end').disabled = allDay;
    $('#f-start').style.opacity = allDay ? 0.45 : 1;
    $('#f-end').style.opacity = allDay ? 0.45 : 1;
    const noRepeat = $('#ev-repeat').value === 'none';
    $('#ev-until').disabled = noRepeat;
    $('#f-until').style.opacity = noRepeat ? 0.45 : 1;
    if (noRepeat) $('#ev-until').value = '';
  }

  function openEventModal(opts) {
    opts = opts || {};
    const form = $('#event-form');
    form.reset();
    form.classList.remove('editor-readonly');
    $$('.field.invalid', form).forEach(function (f) { f.classList.remove('invalid'); });
    $('#err-end').style.display = 'none';
    state.editing = null;
    $('#btn-delete').hidden = true;
    $('#btn-save').hidden = false;
    $('#ev-tools').hidden = true;
    $('#ev-recurring-hint').hidden = true;
    $('#ev-readonly-hint').hidden = true;
    $('#event-modal-title').textContent = T('newEvent');
    buildCategoryGrid();

    if (opts.id) {
      const ev = findAnyEvent(opts.id);
      if (!ev) return;
      state.editing = { id: ev.id, occDate: opts.occDate || ev.date, feed: !!ev.feed };
      $('#ev-id').value = ev.id;
      $('#ev-title').value = ev.title;
      $('#ev-date').value = ev.date;
      $('#ev-allday').checked = !!ev.allDay;
      $('#ev-time').value = ev.allDay ? '' : ev.time;
      $('#ev-end').value = ev.allDay ? '' : (ev.endTime || '');
      setCategory(ev.category);
      $('#ev-repeat').value = ev.repeat ? ev.repeat.freq : 'none';
      $('#ev-until').value = ev.repeat && ev.repeat.until ? ev.repeat.until : '';
      $('#ev-reminder').value = ev.reminder === null || ev.reminder === undefined ? '' : String(ev.reminder);
      if ($('#ev-reminder').value !== String(ev.reminder === null ? '' : ev.reminder)) $('#ev-reminder').value = '';
      $('#ev-location').value = ev.location || '';
      $('#ev-notes').value = ev.notes || '';
      $('#event-modal-title').textContent = ev.feed ? ev.title : T('editEvent');
      $('#ev-tools').hidden = false;
      if (ev.feed) {
        form.classList.add('editor-readonly');
        $('#btn-save').hidden = true;
        $('#ev-readonly-hint').hidden = false;
      } else {
        $('#btn-delete').hidden = false;
        $('#ev-recurring-hint').hidden = !C.isRecurring(ev);
      }
    } else if (opts.prefill) {
      const p = opts.prefill;
      $('#ev-id').value = '';
      $('#ev-title').value = p.title || '';
      $('#ev-date').value = p.date || C.toDateStr(state.selected);
      $('#ev-allday').checked = !!p.allDay;
      $('#ev-time').value = p.allDay ? '' : (p.time || nextSlot(p.date));
      $('#ev-end').value = p.allDay ? '' : (p.endTime || '');
      setCategory(p.category || 'work');
      $('#ev-repeat').value = p.repeat ? p.repeat.freq : 'none';
      $('#ev-until').value = p.repeat && p.repeat.until ? p.repeat.until : '';
      $('#ev-reminder').value = p.reminder === null || p.reminder === undefined ? '' : String(p.reminder);
      if ($('#ev-reminder').value === '' && p.reminder) $('#ev-reminder').value = '';
      $('#ev-location').value = p.location || '';
      $('#ev-notes').value = p.notes || '';
    } else {
      const date = opts.date || C.toDateStr(state.selected);
      const time = opts.time || nextSlot(date);
      $('#ev-id').value = '';
      $('#ev-date').value = date;
      $('#ev-allday').checked = !!opts.allDay;
      $('#ev-time').value = time;
      $('#ev-end').value = C.fromMinutes(Math.min(C.toMinutes(time) + 60, 23 * 60 + 59));
      setCategory('work');
      $('#ev-repeat').value = 'none';
      $('#ev-until').value = '';
      $('#ev-reminder').value = '15';
    }
    updateEditorUI();
    openModal('event-modal');
    setTimeout(function () { $('#ev-title').focus(); }, 40);
  }

  function readForm() {
    const title = $('#ev-title').value.trim();
    const date = $('#ev-date').value;
    const allDay = $('#ev-allday').checked;
    const time = $('#ev-time').value;
    const end = $('#ev-end').value;
    let ok = true;
    $('#f-title').classList.toggle('invalid', !title);
    if (!title) ok = false;
    if (!C.isDateStr(date)) { ok = false; $('#ev-date').focus(); }
    const endInvalid = !allDay && C.isTimeStr(time) && C.isTimeStr(end) && C.toMinutes(end) <= C.toMinutes(time);
    $('#f-end').classList.toggle('invalid', endInvalid);
    $('#err-end').style.display = endInvalid ? 'block' : 'none';
    if (endInvalid) ok = false;
    if (!ok) { if (!title) $('#ev-title').focus(); return null; }
    const catEl = $('#cat-grid input:checked');
    const freq = $('#ev-repeat').value;
    const remVal = $('#ev-reminder').value;
    return {
      title: title,
      date: date,
      allDay: allDay || !C.isTimeStr(time),
      time: allDay ? '' : time,
      endTime: allDay ? '' : end,
      category: catEl ? catEl.value : fallbackCalendarId(),
      repeat: freq === 'none' ? null : { freq: freq, interval: 1, until: $('#ev-until').value || null, exdates: [] },
      reminder: remVal === '' ? null : Number(remVal),
      location: $('#ev-location').value.trim(),
      notes: $('#ev-notes').value.trim()
    };
  }

  function afterSave(ev) {
    const d = C.parseDateStr(ev.date);
    state.selected = d;
    if (state.view === 'month') state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
    else if (state.view === 'week') state.cursor = d;
    render();
    toast(T('eventSaved'), 'success');
    checkReminders();
  }

  function onSubmitEvent(e) {
    e.preventDefault();
    if (state.editing && state.editing.feed) return;
    const data = readForm();
    if (!data) return;
    const now = nowIso();
    let ev;
    if (state.editing) {
      ev = findEvent(state.editing.id);
      if (!ev) { closeModal('event-modal'); return; }
      const keepEx = ev.repeat && data.repeat && ev.repeat.freq === data.repeat.freq && ev.date === data.date;
      const exdates = keepEx ? ev.repeat.exdates : [];
      Object.assign(ev, data);
      if (ev.repeat) ev.repeat.exdates = exdates;
      ev.updatedAt = now;
      Object.assign(ev, C.normalizeEvent(ev));
    } else {
      ev = C.normalizeEvent(Object.assign({ id: C.uid(), createdAt: now, updatedAt: now }, data));
      state.events.push(ev);
    }
    persist();
    closeModal('event-modal');
    afterSave(ev);
  }

  function removeEvent(ev) {
    const idx = state.events.indexOf(ev);
    if (idx >= 0) state.events.splice(idx, 1);
    tombstone(ev.id, 'event');
    return idx;
  }

  function restoreEvent(ev, idx) {
    untombstone(ev.id, 'event');
    ev.updatedAt = nowIso();
    state.events.splice(Math.min(idx < 0 ? state.events.length : idx, state.events.length), 0, ev);
  }

  async function requestDelete(id, occDate) {
    const ev = findEvent(id);
    if (!ev) return;
    if (C.isRecurring(ev)) {
      const choice = await confirmDialog({
        title: T('deleteRecurringTitle'),
        message: T('deleteRecurringMsg'),
        buttons: [
          { label: T('cancel'), value: null, ghost: true },
          { label: T('thisOccurrence'), value: 'one' },
          { label: T('allOccurrences'), value: 'all', danger: true }
        ]
      });
      if (!choice) return;
      closeModal('event-modal');
      if (choice === 'one') {
        const d = occDate || ev.date;
        if (ev.repeat.exdates.indexOf(d) < 0) ev.repeat.exdates.push(d);
        ev.updatedAt = nowIso();
        persist(); render();
        toast(T('eventDeleted'), 'success', { action: T('undo'), onAction: function () {
          ev.repeat.exdates = ev.repeat.exdates.filter(function (x) { return x !== d; });
          ev.updatedAt = nowIso();
          persist(); render();
        } });
        return;
      }
    } else {
      closeModal('event-modal');
    }
    const idx = removeEvent(ev);
    persist(); render();
    toast(T('eventDeleted'), 'success', { action: T('undo'), onAction: function () { restoreEvent(ev, idx); persist(); render(); } });
  }

  function moveEvent(id, newDate) {
    const ev = findEvent(id);
    if (!ev || !C.isDateStr(newDate)) return;
    if (C.isRecurring(ev)) { toast(T('cantMoveRecurring'), 'warn'); return; }
    if (ev.date === newDate) return;
    const old = ev.date;
    ev.date = newDate;
    ev.updatedAt = nowIso();
    state.selected = C.parseDateStr(newDate);
    persist(); render();
    toast(T('eventMoved', { date: fmtDate(C.parseDateStr(newDate), { weekday: 'short', month: 'short', day: 'numeric' }) }), 'success', {
      action: T('undo'), onAction: function () { ev.date = old; ev.updatedAt = nowIso(); persist(); render(); }
    });
  }

  /* ======================================================================
     Quick add (natural language)
     ====================================================================== */
  function parseQuick(text) {
    return NLP.parse(text, { lang: state.settings.lang, weekStart: state.settings.weekStart, now: new Date(), categories: localCalendars().map(function (c) { return c.id; }) });
  }

  function resolveQuickCalendar(r) {
    if (r.categoryTag) {
      const tag = NLP.normalize(r.categoryTag);
      const hit = localCalendars().find(function (c) { return NLP.normalize(calName(c)) === tag || c.id.toLowerCase() === tag; });
      if (hit) return hit.id;
    }
    if (r.category && cal(r.category)) return r.category;
    return fallbackCalendarId();
  }

  function quickToEvent(r) {
    return {
      title: r.title,
      date: r.date,
      allDay: !!r.allDay,
      time: r.allDay ? '' : (r.time || ''),
      endTime: r.allDay ? '' : (r.endTime || ''),
      category: resolveQuickCalendar(r),
      repeat: r.repeat,
      reminder: r.reminder,
      location: r.location || '',
      notes: ''
    };
  }

  function renderQuickPreview() {
    const box = $('#quick-preview');
    const text = $('#quick-add').value.trim();
    $('#quick-open').hidden = !text;
    if (!text) { box.hidden = true; box.innerHTML = ''; state.quickParse = null; return; }
    const r = parseQuick(text);
    state.quickParse = r;
    const calId = resolveQuickCalendar(r);
    const d = C.parseDateStr(r.date);
    const parts = [];
    parts.push('<span class="qp-title' + (r.title ? '' : ' qp-warn') + '">' + (r.title ? esc(r.title) : esc(T('quickTitleMissing'))) + '</span>');
    parts.push('<span>' + ICON('calendar', 'xs') + esc(fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })) + '</span>');
    parts.push('<span>' + ICON('clock', 'xs') + (r.allDay ? esc(T('allDay')) : esc(fmtTime(r.time)) + (r.endTime ? ' – ' + esc(fmtTime(r.endTime)) : '')) + '</span>');
    if (r.repeat) parts.push('<span>' + ICON('repeat', 'xs') + esc(repeatLabel(r.repeat)) + (r.repeat.until ? ' → ' + esc(fmtDate(C.parseDateStr(r.repeat.until), { month: 'short', day: 'numeric' })) : '') + '</span>');
    if (r.reminder !== null && r.reminder !== undefined) parts.push('<span>' + ICON('bell', 'xs') + esc(reminderShort(r.reminder)) + '</span>');
    if (r.location) parts.push('<span>' + ICON('map-pin', 'xs') + esc(r.location) + '</span>');
    parts.push('<span' + catStyle(calId) + '><i class="qp-dot"></i>' + esc(calName(cal(calId))) + '</span>');
    box.innerHTML = parts.join('');
    box.hidden = false;
  }

  function submitQuick(openEditor) {
    const input = $('#quick-add');
    const text = input.value.trim();
    if (!text) return;
    const r = parseQuick(text);
    const data = quickToEvent(r);
    if (openEditor) {
      openEventModal({ prefill: data });
      return;
    }
    if (!r.title) { toast(T('quickTitleMissing'), 'warn'); return; }
    const now = nowIso();
    const ev = C.normalizeEvent(Object.assign({ id: C.uid(), createdAt: now, updatedAt: now }, data));
    state.events.push(ev);
    persist();
    input.value = '';
    renderQuickPreview();
    afterSave(ev);
    input.focus();
  }

  /* ======================================================================
     Calendars manager & feeds
     ====================================================================== */
  function touchCalendar(c) { c.updatedAt = nowIso(); }

  function renderCalendarManager() {
    const list = $('#cal-manage-list');
    list.innerHTML = state.calendars.map(function (c) {
      const isFeed = c.kind === 'feed';
      let meta = '';
      if (isFeed) {
        let host = c.url;
        try { host = new URL(c.url.replace(/^webcal:/i, 'https:')).host; } catch (e) { /* keep */ }
        meta = '<div class="meta">' + ICON('globe', 'xs') + '<span>' + esc(host) + '</span>' +
          '<span>' + esc(c.loading ? T('refreshing') : (c.lastFetched ? T('feedUpdated', { time: fmtDateTime(c.lastFetched) }) : T('feedNever'))) + '</span>' +
          (c.error ? '<span class="err">' + ICON('triangle-alert', 'xs') + esc(T('feedBlocked')) + '</span>' : '') + '</div>';
      }
      return '<div class="cal-manage-row" data-cal="' + esc(c.id) + '">' +
        '<input type="color" class="color-input" value="' + esc(c.color) + '" data-color title="' + esc(T('calendarColor')) + '">' +
        '<input type="text" class="input" maxlength="60" value="' + esc(c.name || '') + '" placeholder="' + esc(c.builtin ? T('cat_' + c.id) : T('calendarName')) + '" data-name aria-label="' + esc(T('calendarName')) + '">' +
        '<div class="acts">' +
        (isFeed ? '<button type="button" class="icon-btn sm" data-refresh title="' + esc(T('refresh')) + '">' + ICON('refresh-cw', 'sm') + '</button>' : '') +
        '<button type="button" class="icon-btn sm" data-toggle title="' + esc(T(c.visible ? 'hideCalendar' : 'showCalendar')) + '">' + ICON(c.visible ? 'eye' : 'eye-off', 'sm') + '</button>' +
        (c.id === 'personal' ? '' : '<button type="button" class="icon-btn sm" data-remove title="' + esc(T('delete')) + '">' + ICON('trash-2', 'sm') + '</button>') +
        '</div>' + meta + '</div>';
    }).join('');
  }

  function openCalendarManager() {
    renderCalendarManager();
    $('#newcal-name').value = '';
    $('#newcal-color').value = C.PALETTE[state.calendars.length % C.PALETTE.length];
    $('#feed-url').value = '';
    $('#feed-name').value = '';
    openModal('calendars-modal');
  }

  function addCalendar() {
    const name = $('#newcal-name').value.trim();
    if (!name) { $('#newcal-name').focus(); return; }
    const c = C.normalizeCalendar({ id: C.uid(), name: name, color: $('#newcal-color').value, visible: true, kind: 'local', order: state.calendars.length, updatedAt: nowIso() }, state.calendars.length);
    state.calendars.push(c);
    persist();
    $('#newcal-name').value = '';
    $('#newcal-color').value = C.PALETTE[state.calendars.length % C.PALETTE.length];
    renderCalendarManager();
    render();
    buildCategoryGrid();
  }

  async function addFeed() {
    let url = $('#feed-url').value.trim().replace(/^webcal:/i, 'https:');
    if (!(/^https:\/\/.+/i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url))) { toast(T('invalidUrl'), 'warn'); $('#feed-url').focus(); return; }
    const c = C.normalizeCalendar({ id: C.uid(), name: $('#feed-name').value.trim() || null, color: $('#feed-color').value, visible: true, kind: 'feed', url: url, order: state.calendars.length, updatedAt: nowIso() }, state.calendars.length);
    if (!c.name) { try { c.name = new URL(url).host; } catch (e) { c.name = 'Feed'; } }
    state.calendars.push(c);
    state.feedEvents[c.id] = [];
    persist();
    renderCalendarManager();
    $('#feed-url').value = ''; $('#feed-name').value = '';
    const ok = await fetchFeed(c, true);
    if (ok) toast(T('feedSubscribed', { events: countLabel((state.feedEvents[c.id] || []).length) }), 'success');
  }

  async function fetchFeed(c, interactive) {
    if (!c || c.kind !== 'feed' || !c.url) return false;
    c.loading = true;
    if (!$('#calendars-modal').hidden) renderCalendarManager();
    let ok = false;
    try {
      const res = await fetch(c.url.replace(/^webcal:/i, 'https:'), { cache: 'no-store', mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Not an iCalendar file');
      const nameM = /X-WR-CALNAME:(.+)/i.exec(text);
      if (nameM && (!c.name || c.name === 'Feed' || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.name))) c.name = nameM[1].trim().slice(0, 60);
      const list = C.parseICS(text).map(function (e) { e.category = c.id; e.feed = true; e.reminder = null; return e; });
      state.feedEvents[c.id] = list;
      await S.kvSet('feed:' + c.id, JSON.parse(JSON.stringify(list)));
      c.lastFetched = nowIso();
      c.error = null;
      ok = true;
    } catch (e) {
      console.warn('Feed failed', c.url, e);
      c.error = navigator.onLine === false ? 'offline' : 'blocked';
      if (interactive) toast(T('feedBlocked'), 'warn', { duration: 8000 });
    }
    c.loading = false;
    persistLocal();
    render();
    if (!$('#calendars-modal').hidden) renderCalendarManager();
    return ok;
  }

  async function refreshFeeds(force) {
    if (navigator.onLine === false) return;
    for (const c of state.calendars) {
      if (c.kind !== 'feed') continue;
      const stale = !c.lastFetched || (Date.now() - new Date(c.lastFetched).getTime()) > FEED_REFRESH_MS;
      if (force || stale) await fetchFeed(c, false);
    }
  }

  async function removeCalendar(id) {
    const c = cal(id);
    if (!c || id === 'personal') return;
    const count = state.events.filter(function (e) { return e.category === id; }).length;
    const choice = await confirmDialog({
      title: T('deleteCalendarTitle'),
      message: c.kind === 'feed' ? T('deleteFeedMsg', { name: calName(c) }) : T('deleteCalendarMsg', { name: calName(c), events: countLabel(count) }),
      buttons: [{ label: T('cancel'), value: null, ghost: true }, { label: T('delete'), value: 'yes', danger: true }]
    });
    if (choice !== 'yes') return;
    state.calendars = state.calendars.filter(function (x) { return x.id !== id; });
    tombstone(id, 'calendar');
    if (c.kind === 'feed') {
      delete state.feedEvents[id];
      try { await S.kvDelete('feed:' + id); } catch (e) { /* ignore */ }
    } else {
      const fb = fallbackCalendarId();
      state.events.forEach(function (e) { if (e.category === id) { e.category = fb; e.updatedAt = nowIso(); } });
    }
    persist();
    renderCalendarManager();
    buildCategoryGrid();
    render();
    toast(T('calendarDeleted'), 'success');
  }

  function toggleCalendar(id) {
    const c = cal(id);
    if (!c) return;
    c.visible = !c.visible;
    persistLocal();
    render();
    if (!$('#calendars-modal').hidden) renderCalendarManager();
  }

  /* ======================================================================
     Reminders & notifications
     ====================================================================== */
  function loadFired() {
    try { state.fired = new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || '[]')); } catch (e) { state.fired = new Set(); }
  }

  function saveFired() {
    try { localStorage.setItem(FIRED_KEY, JSON.stringify(Array.from(state.fired).slice(-600))); } catch (e) { /* ignore */ }
  }

  function checkReminders() {
    const now = Date.now();
    const today = new Date();
    const from = C.toDateStr(C.addDays(today, -1)), to = C.toDateStr(C.addDays(today, 2));
    const withReminder = state.events.filter(function (e) { return e.reminder !== null && e.reminder !== undefined; });
    if (!withReminder.length) return;
    const occ = C.expand(withReminder, from, to);
    occ.forEach(function (o) {
      let start = C.occurrenceStart(o, o.occDate);
      if (o.allDay) start += 9 * 3600000; // all-day reminders are based on 09:00
      const fireAt = start - o.reminder * 60000;
      const key = o.key + '#' + o.reminder;
      if (fireAt <= now && now - fireAt < 3 * 60000 && !state.fired.has(key)) {
        state.fired.add(key);
        saveFired();
        fireReminder(o, start);
      }
    });
  }

  function fireReminder(o, start) {
    const diff = start - Date.now();
    const body = diff < 60000 ? T('reminderNow', { title: o.title }) : T('reminderIn', { title: o.title, time: fmtDuration(diff) });
    toast(body, 'reminder', { title: T('reminderTitle'), sticky: true, action: T('agenda'), onAction: function () { goToDate(o.occDate); } });
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(T('reminderTitle') + ' · ' + o.title, { body: o.allDay ? T('allDay') : (fmtTime(o.time) + (o.location ? ' · ' + o.location : '')), icon: 'icons/icon-192.png', tag: o.key, lang: state.settings.lang });
        n.onclick = function () { try { window.focus(); } catch (e) { /* ignore */ } goToDate(o.occDate); n.close(); };
      } catch (e) { /* ignore */ }
    }
    if (state.settings.sound) beep();
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime;
      o.frequency.setValueAtTime(880, t);
      o.frequency.setValueAtTime(1174.66, t + 0.16);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.start(t); o.stop(t + 0.75);
      o.onended = function () { ctx.close().catch(function () { /* ignore */ }); };
    } catch (e) { /* ignore */ }
  }

  function updateNotifUI() {
    const status = $('#notif-status'), btn = $('#btn-notif');
    if (!('Notification' in window)) { status.textContent = T('notifUnsupported'); btn.hidden = true; return; }
    const p = Notification.permission;
    status.textContent = p === 'granted' ? T('notifOn') : p === 'denied' ? T('notifBlocked') : T('notifHint');
    btn.hidden = p !== 'default';
  }

  async function enableNotifications() {
    if (!('Notification' in window)) return;
    try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    updateNotifUI();
  }

  /* ======================================================================
     Sync folder (File System Access API, two-way merge)
     ====================================================================== */
  function settingsForBackup() {
    const s = state.settings;
    return { lang: s.lang, theme: s.theme, weekStart: s.weekStart, timeFormat: s.timeFormat, numerals: s.numerals, hijri: s.hijri, sound: s.sound };
  }

  function updateBackupUI() {
    const h = state.backupHandle;
    $('#backup-banner').hidden = !(h && state.backupPermission !== 'granted');
    if (!FS_SUPPORTED) {
      $('#backup-hint span').textContent = T('backupUnsupported');
      $('#btn-choose-folder').hidden = true;
      $('#backup-status').textContent = T('noFolder');
      return;
    }
    $('#backup-hint span').textContent = T('syncHint');
    $('#btn-choose-folder').hidden = !!h;
    $('#btn-backup-now').hidden = !h;
    $('#btn-restore-folder').hidden = !h;
    $('#btn-forget-folder').hidden = !h;
    if (!h) { $('#backup-status').textContent = T('noFolder'); return; }
    let txt = h.name || '';
    if (state.settings.lastBackup) txt += ' · ' + T('lastSync', { time: fmtDateTime(state.settings.lastBackup) });
    $('#backup-status').textContent = txt;
  }

  async function ensureBackupPermission(interactive) {
    const h = state.backupHandle;
    if (!h) return false;
    let p = 'denied';
    try {
      p = await h.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted' && interactive) p = await h.requestPermission({ mode: 'readwrite' });
    } catch (e) { p = 'denied'; }
    state.backupPermission = p;
    updateBackupUI();
    return p === 'granted';
  }

  async function initBackup() {
    if (!FS_SUPPORTED) { updateBackupUI(); return; }
    try {
      const h = await S.kvGet('backupHandle');
      if (h && typeof h.queryPermission === 'function') {
        state.backupHandle = h;
        if (await ensureBackupPermission(false)) syncNow({});
      }
    } catch (e) { /* ignore */ }
    updateBackupUI();
  }

  async function chooseBackupFolder() {
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'lumina-backup', startIn: 'documents' });
      state.backupHandle = h;
      state.backupPermission = 'granted';
      await S.kvSet('backupHandle', h);
      updateBackupUI();
      await syncNow({ interactive: true });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn(e);
      toast(T('backupFailed'), 'danger');
    }
  }

  /* Local data in the shape the merge expects (visibility is a per-device preference and stays out). */
  function localSyncData() {
    return {
      events: plainEvents(),
      calendars: plainCalendars().map(function (c) { c.visible = true; delete c.loading; return c; }),
      deleted: state.deleted.slice()
    };
  }

  async function readSyncFile() {
    const fh = await state.backupHandle.getFileHandle(BACKUP_FILE);
    const file = await fh.getFile();
    const text = await file.text();
    const data = C.parseBackup(JSON.parse(text));
    if (!data) throw new Error('Unreadable sync file');
    data.calendars = data.calendars.map(function (c) { c.visible = true; return c; });
    return { data: data, modified: file.lastModified };
  }

  async function writeSyncFile(merged) {
    const fh = await state.backupHandle.getFileHandle(BACKUP_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(C.toBackup(merged.events, settingsForBackup(), APP_VERSION, { calendars: merged.calendars, deleted: merged.deleted, device: state.deviceId }), null, 2));
    await w.close();
    const file = await (await state.backupHandle.getFileHandle(BACKUP_FILE)).getFile();
    return file.lastModified;
  }

  function adoptMerged(merged) {
    const visibility = {};
    state.calendars.forEach(function (c) { visibility[c.id] = c.visible; });
    const before = {};
    state.events.forEach(function (e) { before[e.id] = e.updatedAt; });
    state.events = merged.events.map(C.normalizeEvent);
    state.calendars = C.normalizeCalendars(merged.calendars).map(function (c) { if (visibility[c.id] !== undefined) c.visible = visibility[c.id]; return c; });
    state.deleted = merged.deleted;
    const ids = {};
    state.calendars.forEach(function (c) { ids[c.id] = true; });
    state.events.forEach(function (e) { if (!ids[e.category]) e.category = fallbackCalendarId(); });
    let changed = 0;
    state.events.forEach(function (e) { if (before[e.id] !== e.updatedAt) changed++; });
    Object.keys(before).forEach(function (id) { if (!state.events.some(function (e) { return e.id === id; })) changed++; });
    return changed;
  }

  async function syncNow(opts) {
    opts = opts || {};
    if (!state.backupHandle || state.syncing) return false;
    if (!(await ensureBackupPermission(!!opts.interactive))) return false;
    state.syncing = true;
    let ok = false;
    try {
      let remote = null, modified = null;
      try { const r = await readSyncFile(); remote = r.data; modified = r.modified; } catch (e) { remote = null; }
      const local = localSyncData();
      const merged = C.mergeSync(local, remote || { events: [], calendars: [], deleted: [] });
      const localSig = C.syncSignature(local), mergedSig = C.syncSignature(merged);
      const remoteSig = remote ? C.syncSignature(remote) : null;
      let changed = 0;
      if (mergedSig !== localSig) {
        changed = adoptMerged(merged);
        await persistLocal();
        buildCategoryGrid();
        render();
        refreshFeeds(false);
      }
      if (!remote || mergedSig !== remoteSig) modified = await writeSyncFile(merged);
      state.syncFileModified = modified;
      state.settings.lastBackup = nowIso();
      saveSettings();
      updateBackupUI();
      if (opts.interactive) toast(changed ? T('syncedChanges', { events: countLabel(changed) }) : T('synced'), 'success');
      else if (changed) toast(T('syncedChanges', { events: countLabel(changed) }), 'success');
      ok = true;
    } catch (e) {
      console.warn('Sync failed', e);
      if (opts.interactive) toast(T('backupFailed'), 'danger');
    }
    state.syncing = false;
    return ok;
  }

  let syncTimer = null;
  function scheduleSync() {
    if (!state.backupHandle) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow({}); }, 1500);
  }

  async function pollSyncFile() {
    if (!state.backupHandle || state.backupPermission !== 'granted' || state.syncing || document.hidden) return;
    try {
      const file = await (await state.backupHandle.getFileHandle(BACKUP_FILE)).getFile();
      if (file.lastModified !== state.syncFileModified) await syncNow({});
    } catch (e) { /* file missing or folder unavailable */ }
  }

  async function restoreFromFolder() {
    const h = state.backupHandle;
    if (!h) return;
    if (!(await ensureBackupPermission(true))) return;
    let data;
    try { data = (await readSyncFile()).data; } catch (e) { toast(T('noBackupFile'), 'danger'); return; }
    const choice = await confirmDialog({
      title: T('restoreTitle'),
      message: T('restoreMsg', { events: countLabel(data.events.length) }),
      buttons: [{ label: T('cancel'), value: null, ghost: true }, { label: T('merge'), value: 'merge' }, { label: T('replace'), value: 'replace', danger: true }]
    });
    if (!choice) return;
    if (choice === 'replace') {
      state.events.forEach(function (e) { tombstone(e.id, 'event'); });
      state.events = [];
      state.calendars = C.normalizeCalendars(data.calendars);
    }
    applyImport(data.events, 'merge');
    toast(T('restored'), 'success');
  }

  async function forgetBackupFolder() {
    state.backupHandle = null;
    state.backupPermission = 'none';
    try { await S.kvDelete('backupHandle'); } catch (e) { /* ignore */ }
    updateBackupUI();
  }

  /* ======================================================================
     Export / import / share
     ====================================================================== */
  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  async function saveTextFile(name, text, mime, ext, description) {
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const accept = {}; accept[mime] = [ext];
        const fh = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: description, accept: accept }] });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
        /* fall through to a download */
      }
    }
    downloadFile(name, text, mime);
    return true;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fallback below */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  async function exportJSON() {
    const text = JSON.stringify(C.toBackup(plainEvents(), settingsForBackup(), APP_VERSION, { calendars: plainCalendars(), deleted: state.deleted.slice(), device: state.deviceId }), null, 2);
    const ok = await saveTextFile('lumina-calendar-backup-' + todayStr() + '.json', text, 'application/json', '.json', 'Lumina backup');
    if (ok) toast(T('exported'), 'success');
  }

  async function exportICS() {
    const text = C.toICS(plainEvents(), { version: APP_VERSION, name: 'Lumina Calendar', calendarNames: calendarNames() });
    const ok = await saveTextFile('lumina-calendar.ics', text, 'text/calendar', '.ics', 'iCalendar file');
    if (ok) toast(T('exported'), 'success');
  }

  function applyImport(list, mode) {
    const now = nowIso();
    if (mode === 'replace') {
      state.events.forEach(function (e) { tombstone(e.id, 'event'); });
      state.events = [];
    }
    const ids = new Set(state.events.map(function (e) { return e.id; }));
    const sig = new Set(state.events.map(function (e) { return e.title + '|' + e.date + '|' + e.time; }));
    const calIds = {};
    state.calendars.forEach(function (c) { calIds[c.id] = true; });
    list.forEach(function (raw) {
      const ev = C.normalizeEvent(raw);
      if (ids.has(ev.id)) return;
      if (sig.has(ev.title + '|' + ev.date + '|' + ev.time)) return;
      if (!calIds[ev.category]) ev.category = fallbackCalendarId();
      ev.updatedAt = now;
      untombstone(ev.id, 'event');
      delete ev.feed;
      state.events.push(ev);
      ids.add(ev.id);
    });
    persist();
    buildCategoryGrid();
    render();
    checkReminders();
  }

  async function importFromFile(file) {
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (e) { toast(T('invalidFile'), 'danger'); return; }
    let list = null, calendars = null;
    if (/BEGIN:VCALENDAR/i.test(text)) {
      try { list = C.parseICS(text); } catch (e) { list = null; }
    } else {
      try { const data = C.parseBackup(JSON.parse(text)); if (data) { list = data.events; calendars = data.calendars; } } catch (e) { list = null; }
    }
    if (!list) { toast(T('invalidFile'), 'danger'); return; }
    if (!list.length) { toast(T('nothingToImport'), 'warn'); return; }
    const choice = await confirmDialog({
      title: T('importTitle'),
      message: T('importMsg', { events: countLabel(list.length) }),
      buttons: [{ label: T('cancel'), value: null, ghost: true }, { label: T('merge'), value: 'merge', primary: true }, { label: T('replace'), value: 'replace', danger: true }]
    });
    if (!choice) return;
    if (calendars && calendars.length) {
      const have = {};
      state.calendars.forEach(function (c) { have[c.id] = true; });
      calendars.forEach(function (c) { if (!have[c.id] && c.kind === 'local') { c.updatedAt = nowIso(); state.calendars.push(c); } });
      state.calendars = C.normalizeCalendars(state.calendars);
    }
    const before = state.events.length;
    applyImport(list, choice);
    const added = choice === 'replace' ? state.events.length : state.events.length - before;
    toast(T('imported', { events: countLabel(added) }), 'success');
  }

  async function deleteAllEvents() {
    const choice = await confirmDialog({
      title: T('deleteAllTitle'),
      message: T('deleteAllMsg'),
      buttons: [{ label: T('cancel'), value: null, ghost: true }, { label: T('deleteAll'), value: 'yes', danger: true }]
    });
    if (choice !== 'yes') return;
    const backup = state.events.slice();
    state.events.forEach(function (e) { tombstone(e.id, 'event'); });
    state.events = [];
    persist(); render();
    closeModal('settings-modal');
    toast(T('allDeleted'), 'success', { action: T('undo'), onAction: function () {
      backup.forEach(function (e) { untombstone(e.id, 'event'); e.updatedAt = nowIso(); });
      state.events = backup; persist(); render();
    } });
  }

  /* ---------- sharing & Windows Calendar hand-off ---------- */
  function shareText(ev) {
    const d = C.parseDateStr(ev.date);
    const when = fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + (ev.allDay ? ' · ' + T('allDay') : ' · ' + fmtTime(ev.time) + (ev.endTime ? ' – ' + fmtTime(ev.endTime) : ''));
    const lines = [ev.title, T('when') + ': ' + when];
    if (C.isRecurring(ev)) lines.push(T('repeat') + ': ' + repeatLabel(ev.repeat));
    if (ev.location) lines.push(T('where') + ': ' + ev.location);
    if (ev.notes) lines.push('', ev.notes);
    lines.push('', '— ' + T('sentFrom'));
    return lines.join('\n');
  }

  function eventFileName(ev) {
    return (ev.title || 'event').replace(/[^\w؀-ۿ\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'event';
  }

  function singleICS(ev) {
    return C.toICS([JSON.parse(JSON.stringify(ev))], { version: APP_VERSION, name: ev.title, calendarNames: calendarNames() });
  }

  async function shareEvent(ev) {
    const text = shareText(ev);
    const ics = singleICS(ev);
    const name = eventFileName(ev) + '.ics';
    let file = null;
    try { file = new File([ics], name, { type: 'text/calendar' }); } catch (e) { file = null; }
    const canFiles = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    const canShare = typeof navigator.share === 'function';
    const buttons = [{ label: T('cancel'), value: null, ghost: true }];
    if (canShare) buttons.push({ label: T('shareWindows'), value: 'share', primary: true });
    buttons.push({ label: T('copyDetails'), value: 'copy' }, { label: T('saveInvite'), value: 'ics' });
    const choice = await confirmDialog({ title: T('shareEvent'), message: text, pre: true, buttons: buttons });
    if (choice === 'share') {
      try {
        await navigator.share(canFiles ? { title: ev.title, text: text, files: [file] } : { title: ev.title, text: text });
      } catch (e) {
        if (!e || e.name !== 'AbortError') { await copyText(text); toast(T('shareFailed'), 'warn'); }
      }
    } else if (choice === 'copy') {
      if (await copyText(text)) toast(T('shareCopied'), 'success');
    } else if (choice === 'ics') {
      if (await saveTextFile(name, ics, 'text/calendar', '.ics', 'Calendar invitation')) toast(T('exported'), 'success');
    }
  }

  function addToWindowsCalendar(ev) {
    downloadFile(eventFileName(ev) + '.ics', singleICS(ev), 'text/calendar');
    toast(T('icsSaved'), 'success', { duration: 7000 });
  }

  /* ======================================================================
     Service worker
     ====================================================================== */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;
    const start = function () {
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        state.swReg = reg;
        const showUpdate = function () {
          toast(T('updateReady'), 'info', { sticky: true, action: T('reload'), onAction: function () {
            state.updateAccepted = true;
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          } });
        };
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
        reg.addEventListener('updatefound', function () {
          const w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed') {
              if (navigator.serviceWorker.controller) showUpdate();
              else toast(T('offlineReady'), 'success');
            }
          });
        });
      }).catch(function (e) { console.warn('Service worker registration failed', e); });
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (state.updateAccepted) { state.updateAccepted = false; location.reload(); }
      });
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  }

  /* ======================================================================
     Wiring
     ====================================================================== */
  function wireHeader() {
    $$('.seg-btn[data-view]').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.view); }); });
    $('#btn-today').addEventListener('click', goToday);
    $('#btn-prev').addEventListener('click', function () { navigate(-1); });
    $('#btn-next').addEventListener('click', function () { navigate(1); });
    $('#btn-new').addEventListener('click', function () { openEventModal(); });
    $('#btn-new-side').addEventListener('click', function () { openEventModal(); });
    $('#btn-settings').addEventListener('click', function () { syncSettingsUI(); openModal('settings-modal'); });
    $('#search').addEventListener('input', onSearchInput);
    $('#search').addEventListener('keydown', function (e) { if (e.key === 'Escape') { clearSearch(); $('#search').blur(); } });
    $('#search-clear').addEventListener('click', function () { clearSearch(); $('#search').focus(); });
    $('#btn-welcome-ok').addEventListener('click', function () { state.settings.welcomed = true; saveSettings(); $('#welcome-card').hidden = true; });
    $('#backup-banner').addEventListener('click', async function () { if (await ensureBackupPermission(true)) syncNow({ interactive: true }); });
    $('#backup-banner').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#backup-banner').click(); } });

    // quick add
    let quickTimer = null;
    $('#quick-add').addEventListener('input', function () { clearTimeout(quickTimer); quickTimer = setTimeout(renderQuickPreview, 120); });
    $('#quick-add').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(quickTimer); submitQuick(e.shiftKey); }
      else if (e.key === 'Escape') { $('#quick-add').value = ''; renderQuickPreview(); $('#quick-add').blur(); }
    });
    $('#quick-open').addEventListener('click', function () { submitQuick(true); });

    // calendars list
    $('#btn-manage-cals').addEventListener('click', openCalendarManager);
    $('#cal-list').addEventListener('click', function (e) { const row = e.target.closest('.cal-row'); if (row) toggleCalendar(row.dataset.cal); });
    $('#cal-list').addEventListener('keydown', function (e) { const row = e.target.closest('.cal-row'); if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleCalendar(row.dataset.cal); } });
  }

  function wireViews() {
    const root = $('#view-root');
    const side = $('#side-list');

    const onClick = function (e) {
      const add = e.target.closest('[data-add]');
      if (add) { e.stopPropagation(); openEventModal({ date: add.getAttribute('data-add') }); return; }
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      const item = e.target.closest('.agenda-item, .chip, .wk-event');
      if (del && item) { e.stopPropagation(); requestDelete(item.dataset.id, item.dataset.occ); return; }
      if (item) { e.stopPropagation(); openEventModal({ id: item.dataset.id, occDate: item.dataset.occ }); return; }
      if (edit) return;
      const head = e.target.closest('.week-day-head');
      if (head) { selectDay(head.dataset.date); return; }
      const day = e.target.closest('.day');
      if (day) { selectDay(day.dataset.date); return; }
      const col = e.target.closest('.week-col');
      if (col) {
        const rect = col.getBoundingClientRect();
        const mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor((e.clientY - rect.top) / PX_PER_HOUR * 60 / 30) * 30));
        openEventModal({ date: col.dataset.date, time: C.fromMinutes(mins) });
        return;
      }
      const cell = e.target.closest('.week-allday .cell');
      if (cell) openEventModal({ date: cell.dataset.date, allDay: true });
    };
    root.addEventListener('click', onClick);
    side.addEventListener('click', onClick);

    root.addEventListener('dblclick', function (e) {
      const day = e.target.closest('.day');
      if (day && !e.target.closest('.chip')) openEventModal({ date: day.dataset.date });
    });

    const onKey = function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target;
      if (t.classList.contains('day') || t.classList.contains('week-day-head') || t.classList.contains('chip') || t.classList.contains('agenda-item') || t.classList.contains('wk-event')) {
        e.preventDefault();
        t.click();
      }
    };
    root.addEventListener('keydown', onKey);
    side.addEventListener('keydown', onKey);

    /* drag & drop between days */
    root.addEventListener('dragstart', function (e) {
      const chip = e.target.closest('.chip[draggable="true"]');
      if (!chip) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', chip.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    root.addEventListener('dragend', function (e) {
      const chip = e.target.closest('.chip');
      if (chip) chip.classList.remove('dragging');
      $$('.drop-target', root).forEach(function (el) { el.classList.remove('drop-target'); });
    });
    const dropZone = function (e) { return e.target.closest('.day, .week-col, .week-allday .cell'); };
    root.addEventListener('dragover', function (e) {
      const z = dropZone(e);
      if (!z) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!z.classList.contains('drop-target')) {
        $$('.drop-target', root).forEach(function (el) { el.classList.remove('drop-target'); });
        z.classList.add('drop-target');
      }
    });
    root.addEventListener('dragleave', function (e) {
      const z = dropZone(e);
      if (z && !z.contains(e.relatedTarget)) z.classList.remove('drop-target');
    });
    root.addEventListener('drop', function (e) {
      const z = dropZone(e);
      if (!z) return;
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      $$('.drop-target', root).forEach(function (el) { el.classList.remove('drop-target'); });
      if (id) moveEvent(id, z.dataset.date);
    });
  }

  function wireEditor() {
    $('#event-form').addEventListener('submit', onSubmitEvent);
    $('#ev-allday').addEventListener('change', updateEditorUI);
    $('#ev-repeat').addEventListener('change', updateEditorUI);
    $('#ev-time').addEventListener('change', function () {
      const s = $('#ev-time').value, e = $('#ev-end').value;
      if (C.isTimeStr(s) && (!C.isTimeStr(e) || C.toMinutes(e) <= C.toMinutes(s))) $('#ev-end').value = C.fromMinutes(Math.min(C.toMinutes(s) + 60, 23 * 60 + 59));
      $('#f-end').classList.remove('invalid');
      $('#err-end').style.display = 'none';
    });
    $('#ev-title').addEventListener('input', function () { if ($('#ev-title').value.trim()) $('#f-title').classList.remove('invalid'); });
    $('#btn-delete').addEventListener('click', function () { if (state.editing) requestDelete(state.editing.id, state.editing.occDate); });
    $('#btn-share').addEventListener('click', function () { if (state.editing) { const ev = findAnyEvent(state.editing.id); if (ev) shareEvent(ev); } });
    $('#btn-win-cal').addEventListener('click', function () { if (state.editing) { const ev = findAnyEvent(state.editing.id); if (ev) addToWindowsCalendar(ev); } });
  }

  function wireCalendarManager() {
    const list = $('#cal-manage-list');
    list.addEventListener('input', function (e) {
      const row = e.target.closest('.cal-manage-row');
      if (!row) return;
      const c = cal(row.dataset.cal);
      if (!c) return;
      if (e.target.matches('[data-color]')) { if (C.isColor(e.target.value)) { c.color = e.target.value.toLowerCase(); touchCalendar(c); render(); buildCategoryGrid(); } }
    });
    list.addEventListener('change', function (e) {
      const row = e.target.closest('.cal-manage-row');
      if (!row) return;
      const c = cal(row.dataset.cal);
      if (!c) return;
      if (e.target.matches('[data-name]')) {
        const v = e.target.value.trim().slice(0, 60);
        c.name = v || (c.builtin ? null : c.id);
        touchCalendar(c);
        persist(); render(); buildCategoryGrid();
      } else if (e.target.matches('[data-color]')) {
        touchCalendar(c); persist(); render(); buildCategoryGrid();
      }
    });
    list.addEventListener('click', function (e) {
      const row = e.target.closest('.cal-manage-row');
      if (!row) return;
      const id = row.dataset.cal;
      if (e.target.closest('[data-toggle]')) toggleCalendar(id);
      else if (e.target.closest('[data-remove]')) removeCalendar(id);
      else if (e.target.closest('[data-refresh]')) fetchFeed(cal(id), true);
    });
    $('#btn-add-cal').addEventListener('click', addCalendar);
    $('#newcal-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCalendar(); } });
    $('#btn-add-feed').addEventListener('click', addFeed);
    $('#feed-url').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addFeed(); } });
  }

  function wireSettings() {
    $$('#lang-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.settings.lang === b.dataset.lang) return;
        state.settings.lang = b.dataset.lang;
        saveSettings(); applyLang(); render();
      });
    });
    $$('#theme-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { state.settings.theme = b.dataset.themeOpt; saveSettings(); applyTheme(); });
    });
    $('#set-weekstart').addEventListener('change', function (e) { state.settings.weekStart = Number(e.target.value); state.weekScrollTop = null; saveSettings(); render(); renderQuickPreview(); });
    $('#set-timefmt').addEventListener('change', function (e) { state.settings.timeFormat = e.target.value; saveSettings(); buildSelects(); render(); updateBackupUI(); renderQuickPreview(); });
    $('#set-numerals').addEventListener('change', function (e) { state.settings.numerals = e.target.value; saveSettings(); buildSelects(); render(); renderQuickPreview(); });
    $('#set-hijri').addEventListener('change', function (e) { state.settings.hijri = e.target.checked; saveSettings(); render(); });
    $('#set-sound').addEventListener('change', function (e) { state.settings.sound = e.target.checked; saveSettings(); });
    $('#btn-notif').addEventListener('click', enableNotifications);
    $('#btn-copy-startup').addEventListener('click', async function () { if (await copyText('shell:startup')) toast(T('copied'), 'success'); });
    $('#btn-choose-folder').addEventListener('click', chooseBackupFolder);
    $('#btn-backup-now').addEventListener('click', function () { syncNow({ interactive: true }); });
    $('#btn-restore-folder').addEventListener('click', restoreFromFolder);
    $('#btn-forget-folder').addEventListener('click', forgetBackupFolder);
    $('#btn-export-json').addEventListener('click', exportJSON);
    $('#btn-export-ics').addEventListener('click', exportICS);
    $('#btn-import').addEventListener('click', function () { $('#import-file').value = ''; $('#import-file').click(); });
    $('#import-file').addEventListener('change', function (e) { importFromFile(e.target.files && e.target.files[0]); });
    $('#btn-delete-all').addEventListener('click', deleteAllEvents);
  }

  function wireModals() {
    $$('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeModal(m); });
    });
  }

  function wireKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (closeTopModal()) { e.preventDefault(); return; }
        if (document.activeElement === $('#search') && state.query) { clearSearch(); $('#search').blur(); }
        return;
      }
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if ($$('.modal').some(function (m) { return !m.hidden; })) return;
      const rtl = document.documentElement.dir === 'rtl';
      switch (e.code) {
        case 'KeyN': e.preventDefault(); openEventModal(); break;
        case 'KeyT': e.preventDefault(); goToday(); break;
        case 'KeyQ': e.preventDefault(); $('#quick-add').focus(); break;
        case 'ArrowLeft': e.preventDefault(); navigate(rtl ? 1 : -1); break;
        case 'ArrowRight': e.preventDefault(); navigate(rtl ? -1 : 1); break;
        case 'Digit1': case 'Numpad1': setView('month'); break;
        case 'Digit2': case 'Numpad2': setView('week'); break;
        case 'Digit3': case 'Numpad3': setView('agenda'); break;
        case 'Slash': e.preventDefault(); $('#search').focus(); $('#search').select(); break;
        default: break;
      }
    });
  }

  function handleUrlActions() {
    try {
      const params = new URLSearchParams(location.search);
      const view = params.get('view');
      if (view && ['month', 'week', 'agenda'].indexOf(view) >= 0) state.view = view;
      if (params.get('action') === 'new') setTimeout(function () { openEventModal(); }, 350);
      if (view || params.get('action')) history.replaceState(null, '', location.pathname);
    } catch (e) { /* ignore */ }
  }

  /* ======================================================================
     Init
     ====================================================================== */
  async function init() {
    LuminaIcons.mount(document);
    await loadSettings();
    applyTheme();
    await loadData();
    applyLang();
    loadFired();
    wireHeader(); wireViews(); wireEditor(); wireCalendarManager(); wireSettings(); wireModals(); wireKeyboard();
    handleUrlActions();
    render();
    $('#welcome-card').hidden = !!state.settings.welcomed;
    S.requestPersistence();
    initBackup();
    registerServiceWorker();
    refreshFeeds(false);
    checkReminders();
    setInterval(checkReminders, 20000);
    setInterval(pollSyncFile, SYNC_POLL_MS);
    setInterval(function () { refreshFeeds(false); }, 3600000);
    setInterval(function () {
      updateNowLine();
      if (C.toDateStr(state.selected) === todayStr()) renderSidebar();
    }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { checkReminders(); render(); pollSyncFile(); } });
    window.addEventListener('online', function () { refreshFeeds(false); pollSyncFile(); });
    let resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (state.view === 'month') renderView(); }, 150);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* A small automation surface (used by the test-suite). */
  window.Lumina = {
    version: APP_VERSION,
    get state() { return state; },
    render: render, openEventModal: openEventModal, setView: setView, goToDate: goToDate, toast: toast,
    importEvents: function (list, mode) { applyImport(list, mode || 'merge'); },
    checkReminders: checkReminders, parseQuick: parseQuick, syncNow: syncNow, fetchFeed: fetchFeed,
    mergeFromFile: function (obj) { const data = C.parseBackup(obj); if (!data) return 0; const merged = C.mergeSync(localSyncData(), data); const n = adoptMerged(merged); persistLocal(); render(); return n; }
  };
})();
