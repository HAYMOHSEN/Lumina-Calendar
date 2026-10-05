/* Lumina Calendar — natural-language event parser (English + Arabic).
 * parse("lunch with Sara tomorrow at 1pm for 2 hours remind me 30 min before at Cafe Nero")
 * → { title, date, time, endTime, allDay, repeat, reminder, location, category, ... }
 * Pure functions: no DOM, runs under Node for tests. */
(function (global) {
  'use strict';

  const C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : global.LuminaCore;

  /* ---------- helpers ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toDateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function clampDay(y, m, d) { const last = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(d, last)); }
  function fromMinutes(mins) { mins = Math.max(0, Math.min(1439, Math.round(mins))); return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }
  function longestFirst(src) { return src.split('|').sort(function (a, b) { return b.length - a.length; }).join('|'); }

  /* Character-by-character normalisation that keeps the string length, so matched spans map back onto the original. */
  function normalizeChar(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);      // Arabic-Indic digits
    if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);      // Persian digits
    if (ch === 'أ' || ch === 'إ' || ch === 'آ' || ch === 'ٱ') return 'ا';
    if (ch === 'ى') return 'ي';
    if (ch === 'ة') return 'ه';
    if (ch === 'ؤ') return 'و';
    if (ch === 'ئ') return 'ي';
    if ((code >= 0x064B && code <= 0x0652) || code === 0x0640 || code === 0x0670) return ' '; // tashkeel, tatweel
    if (ch === '،' || ch === '؛') return ',';
    if (ch === ' ') return ' ';
    return ch.toLowerCase();
  }

  function normalize(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) out += normalizeChar(text[i]);
    return out;
  }

  const AR = '\\u0600-\\u06FF';
  const WEEKDAYS_EN = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  const WEEKDAYS_AR = { 'احد': 0, 'اثنين': 1, 'ثلاثاء': 2, 'ثلاثا': 2, 'اربعاء': 3, 'اربعا': 3, 'خميس': 4, 'جمعه': 5, 'سبت': 6 };
  const MONTHS_EN = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
  const MONTHS_AR = {
    'يناير': 0, 'كانون الثاني': 0, 'فبراير': 1, 'شباط': 1, 'مارس': 2, 'اذار': 2, 'ابريل': 3, 'افريل': 3, 'نيسان': 3, 'مايو': 4, 'ايار': 4, 'ماي': 4,
    'يونيو': 5, 'حزيران': 5, 'يوليو': 6, 'تموز': 6, 'اغسطس': 7, 'اب': 7, 'سبتمبر': 8, 'ايلول': 8, 'اكتوبر': 9, 'تشرين الاول': 9,
    'نوفمبر': 10, 'تشرين الثاني': 10, 'ديسمبر': 11, 'كانون الاول': 11
  };
  const EN_WD = longestFirst(Object.keys(WEEKDAYS_EN).join('|'));
  const AR_WD = longestFirst(Object.keys(WEEKDAYS_AR).join('|'));
  const EN_MON = longestFirst(Object.keys(MONTHS_EN).join('|'));
  const AR_MON = longestFirst(Object.keys(MONTHS_AR).join('|'));
  const AR_SPECIAL_DUR = { 'ساعتين': 120, 'ساعه ونصف': 90, 'ساعه و نصف': 90, 'نصف ساعه': 30, 'ربع ساعه': 15, 'ثلاث ساعات': 180, 'دقيقتين': 2, 'يومين': 2880, 'اسبوعين': 20160 };

  const CATEGORY_WORDS = {
    health: ['gym', 'workout', 'yoga', 'run', 'running', 'jog', 'doctor', 'dentist', 'clinic', 'hospital', 'pharmacy', 'checkup', 'check-up', 'therapy', 'swim', 'swimming', 'physio', 'vaccine', 'fitness', 'training',
      'جيم', 'رياضه', 'تمرين', 'طبيب', 'دكتور', 'عياده', 'مستشفي', 'صيدليه', 'علاج', 'يوغا', 'سباحه', 'فحص', 'تحليل', 'اسنان'],
    work: ['meeting', 'call', 'sync', 'review', 'client', 'project', 'report', 'presentation', 'interview', 'standup', 'stand-up', 'office', 'work', 'demo', 'webinar', 'conference', 'workshop', 'proposal', 'invoice',
      'اجتماع', 'مكالمه', 'مراجعه', 'عميل', 'مشروع', 'تقرير', 'عرض', 'مقابله', 'عمل', 'مكتب', 'مؤتمر', 'ورشه', 'دوام', 'شغل'],
    study: ['lecture', 'class', 'exam', 'study', 'course', 'lab', 'homework', 'thesis', 'seminar', 'tutorial', 'quiz', 'assignment', 'school', 'university', 'midterm', 'final',
      'محاضره', 'امتحان', 'دراسه', 'درس', 'مختبر', 'واجب', 'رساله', 'ندوه', 'حصه', 'دوره', 'جامعه', 'مدرسه', 'كويز'],
    family: ['family', 'mom', 'dad', 'mother', 'father', 'kids', 'son', 'daughter', 'birthday', 'wedding', 'anniversary', 'parents', 'grandma', 'grandpa', 'sister', 'brother', 'wife', 'husband',
      'عائله', 'عيله', 'ماما', 'بابا', 'امي', 'ابي', 'اولاد', 'ابني', 'بنتي', 'عيد ميلاد', 'زفاف', 'عرس', 'خطوبه', 'اهل', 'جدتي', 'جدي', 'اختي', 'اخي', 'زوجتي', 'زوجي'],
    urgent: ['urgent', 'asap', 'emergency', 'deadline', 'due', 'overdue', 'critical',
      'عاجل', 'طارئ', 'موعد تسليم', 'تسليم', 'ضروري']
  };

  function guessCategory(norm, available) {
    const order = ['urgent', 'health', 'study', 'family', 'work'];
    const words = ' ' + norm.replace(/[^a-z0-9؀-ۿ]+/g, ' ') + ' ';
    for (const cat of order) {
      if (available && available.indexOf(cat) < 0) continue;
      for (const w of CATEGORY_WORDS[cat]) {
        if (words.indexOf(' ' + w + ' ') >= 0) return cat;
      }
    }
    return null;
  }

  /* ---------- the parser ---------- */
  function parse(text, opts) {
    opts = opts || {};
    const now = opts.now ? new Date(opts.now) : new Date();
    const lang = opts.lang === 'ar' ? 'ar' : 'en';
    const weekStart = typeof opts.weekStart === 'number' ? opts.weekStart : 0;
    const original = String(text || '').replace(/\s+/g, ' ').trim();
    const chars = original.split('');
    let norm = normalize(original);
    const used = new Array(chars.length).fill(false);
    const r = { title: '', date: null, time: null, endTime: null, allDay: null, repeat: null, reminder: null, location: '', category: null, categoryTag: null, tokens: [] };
    let relTimeSet = false;
    let explicitDate = false;
    let m;

    function consume(m, kind) {
      const start = m.index, end = m.index + m[0].length;
      for (let i = start; i < end; i++) used[i] = true;
      norm = norm.slice(0, start) + ' '.repeat(end - start) + norm.slice(end);
      r.tokens.push({ kind: kind, text: original.slice(start, end) });
    }
    function take(re, kind) {
      const m = re.exec(norm);
      if (!m) return null;
      consume(m, kind);
      return m;
    }
    /* whole-token boundaries that work for Arabic as well as Latin */
    function W(src) { return new RegExp('(?<![a-z0-9' + AR + '])(?:' + src + ')(?![a-z0-9' + AR + '])'); }
    function has(src) { return W(src).test(norm); }

    function minutesOf(n, unit) {
      unit = unit || '';
      if (/^(h|hr|hrs|hour|hours|ساعه|ساعات)$/.test(unit)) return n * 60;
      if (/^(d|day|days|يوم|ايام)$/.test(unit)) return n * 1440;
      if (/^(w|week|weeks|اسبوع|اسابيع)$/.test(unit)) return n * 10080;
      return n;
    }
    function unitEN(u) { u = u || 'm'; return /^h/.test(u) ? 'h' : /^d/.test(u) ? 'd' : /^w/.test(u) ? 'w' : 'm'; }
    function unitAR(u) { return /ساع/.test(u) ? 'h' : /يوم|ايام/.test(u) ? 'd' : /اسبوع|اسابيع/.test(u) ? 'w' : 'm'; }

    /* ---- 1. calendar hashtag ---- */
    m = take(/#([a-z0-9_\-؀-ۿ]+)/, 'calendar');
    if (m) r.categoryTag = m[1];

    /* ---- 2. all day ---- */
    if (take(W('all[ -]?day|whole day|طوال اليوم|كل اليوم|طول اليوم'), 'allday')) r.allDay = true;

    /* ---- 3. reminder ---- */
    m = take(W('(?:remind(?:er)?(?: me)?|alert(?: me)?|notify(?: me)?|notification)(?:\\s+(\\d+(?:\\.\\d+)?)\\s*(min(?:ute)?s?|m|h(?:ou)?rs?|h|d(?:ay)?s?)\\s*(?:before|early|ahead|prior)?)?'), 'reminder');
    if (m) r.reminder = m[1] ? Math.round(minutesOf(parseFloat(m[1]), unitEN(m[2]))) : 15;
    if (r.reminder === null) {
      m = take(W('(?:ذكرني|تذكير|نبهني|تنبيه)(?:\\s+(?:قبل(?:ها|ه)?\\s*)?(?:(\\d+)\\s*)?(دقيقه|دقائق|دقيقتين|ساعه|ساعات|ساعتين|يوم|ايام|يومين|نصف ساعه|ربع ساعه))?(?:\\s+قبل(?:ها|ه)?)?'), 'reminder');
      if (m) {
        if (!m[2]) r.reminder = 15;
        else if (AR_SPECIAL_DUR[m[2]] !== undefined) r.reminder = AR_SPECIAL_DUR[m[2]];
        else r.reminder = minutesOf(m[1] ? parseInt(m[1], 10) : 1, unitAR(m[2]));
      }
    }

    /* ---- 4. repeat ---- */
    function setRepeat(freq, interval) { r.repeat = { freq: freq, interval: interval || 1, until: null, exdates: [] }; }
    let repeatWeekday = null;
    if ((m = take(W('every\\s+(\\d+)\\s+(day|week|month|year)s?'), 'repeat'))) setRepeat(m[2] + 'ly', parseInt(m[1], 10));
    if (!r.repeat && (m = take(W('every\\s+other\\s+(day|week|month|year)'), 'repeat'))) setRepeat(m[1] + 'ly', 2);
    if (!r.repeat && (m = take(W('every\\s+(day|week|month|year)|each\\s+(day|week|month|year)|daily|weekly|monthly|yearly|annually'), 'repeat'))) {
      const word = m[1] || m[2] || m[0];
      setRepeat(/day|daily/.test(word) ? 'daily' : /week/.test(word) ? 'weekly' : /month/.test(word) ? 'monthly' : 'yearly');
    }
    if (!r.repeat && (m = take(W('every\\s+(' + EN_WD + ')s?'), 'repeat'))) { setRepeat('weekly'); repeatWeekday = WEEKDAYS_EN[m[1]]; }
    if (!r.repeat && (m = take(W('كل\\s+(\\d+)\\s+(ايام|يوم|اسابيع|اسبوع|اشهر|شهور|شهر|سنوات|سنه)'), 'repeat'))) {
      const u = m[2];
      setRepeat(/يوم|ايام/.test(u) ? 'daily' : /اسبوع|اسابيع/.test(u) ? 'weekly' : /شهر|اشهر|شهور/.test(u) ? 'monthly' : 'yearly', parseInt(m[1], 10));
    }
    if (!r.repeat && (m = take(W('كل\\s+(يومين|اسبوعين|شهرين|سنتين)'), 'repeat'))) {
      setRepeat(m[1] === 'يومين' ? 'daily' : m[1] === 'اسبوعين' ? 'weekly' : m[1] === 'شهرين' ? 'monthly' : 'yearly', 2);
    }
    if (!r.repeat && (m = take(W('كل\\s+(?:يوم\\s+)?(?:ال)?(' + AR_WD + ')'), 'repeat'))) { setRepeat('weekly'); repeatWeekday = WEEKDAYS_AR[m[1]]; }
    if (!r.repeat && (m = take(W('كل\\s+(يوم|اسبوع|شهر|سنه|عام)|يوميا|اسبوعيا|شهريا|سنويا'), 'repeat'))) {
      const w = m[1] || m[0];
      setRepeat(/يوم/.test(w) ? 'daily' : /اسبوع/.test(w) ? 'weekly' : /شهر/.test(w) ? 'monthly' : 'yearly');
    }

    /* ---- 6. relative "in N minutes/hours" ---- */
    m = take(W('in\\s+(\\d+(?:\\.\\d+)?|an?|half an?)\\s*(h(?:ou)?rs?|h|min(?:ute)?s?|m)'), 'reltime');
    if (!m) m = take(W('بعد\\s+(?:(\\d+)\\s*)?(دقيقه|دقائق|ساعه|ساعات|ساعتين|نصف ساعه|ربع ساعه)'), 'reltime');
    if (m) {
      let mins;
      if (!m[1] && AR_SPECIAL_DUR[m[2]] !== undefined) mins = AR_SPECIAL_DUR[m[2]];
      else {
        const n = (m[1] === undefined || m[1] === 'a' || m[1] === 'an') ? 1 : /^half/.test(m[1]) ? 0.5 : parseFloat(m[1]);
        mins = minutesOf(n, /[a-z]/.test(m[2]) ? unitEN(m[2]) : unitAR(m[2]));
      }
      const t = new Date(now.getTime() + mins * 60000);
      r.date = toDateStr(t);
      r.time = fromMinutes(Math.round((t.getHours() * 60 + t.getMinutes()) / 5) * 5);
      relTimeSet = true;
      explicitDate = true;
    }

    /* ---- 5. durations ---- */
    let durationMin = null;
    if ((m = take(W('for\\s+(\\d+(?:\\.\\d+)?|an?|half an?)\\s*(h(?:ou)?rs?|h|min(?:ute)?s?|m)'), 'duration'))) {
      const n = (m[1] === 'a' || m[1] === 'an') ? 1 : /^half/.test(m[1]) ? 0.5 : parseFloat(m[1]);
      durationMin = Math.round(minutesOf(n, unitEN(m[2])));
    }
    if (durationMin === null && (m = take(W('(\\d+(?:\\.\\d+)?)\\s*(hours?|hrs?)'), 'duration'))) durationMin = Math.round(parseFloat(m[1]) * 60);
    if (durationMin === null && (m = take(W('لمده\\s+(?:(\\d+)\\s*)?(دقيقه|دقائق|ساعه|ساعات|ساعتين|ساعه ونصف|ساعه و نصف|نصف ساعه|ربع ساعه|ثلاث ساعات)'), 'duration'))) {
      durationMin = AR_SPECIAL_DUR[m[2]] !== undefined ? AR_SPECIAL_DUR[m[2]] : minutesOf(m[1] ? parseInt(m[1], 10) : 1, unitAR(m[2]));
    }
    if (durationMin === null && (m = take(W('ساعتين|نصف ساعه|ربع ساعه|ساعه ونصف|ساعه و نصف'), 'duration'))) durationMin = AR_SPECIAL_DUR[m[0]];

    /* ---- 7. dates (before times, so "2026-10-08" or "8/10" are never read as time ranges) ---- */
    function setDate(d) { if (d && !isNaN(d.getTime())) { r.date = toDateStr(d); explicitDate = true; } }
    function nextWeekday(wd, fromDate, includeToday) {
      const d = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
      let diff = (wd - d.getDay() + 7) % 7;
      if (diff === 0 && !includeToday) diff = 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
    function rollForward(d, hadYear) { return (!hadYear && d < C.startOfDay(now)) ? new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()) : d; }
    function numericDate(a, b, yStr) {
      let y = yStr ? +yStr : now.getFullYear();
      if (yStr && yStr.length === 2) y += 2000;
      const dayFirst = lang === 'ar' || a > 12;
      const day = dayFirst ? a : b, mon = dayFirst ? b : a;
      if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
      return rollForward(new Date(y, mon - 1, day), !!yStr);
    }
    const UNTIL = '(?:until|till|through|حتي|حتى|لغايه|الي|الى)';
    function dateFromText(s) {
      let mm;
      if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return new Date(+mm[1], +mm[2] - 1, +mm[3]);
      if ((mm = /^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?$/.exec(s))) return numericDate(+mm[1], +mm[2], mm[3]);
      if ((mm = new RegExp('^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + EN_MON + ')(?:,?\\s+(\\d{4}))?$').exec(s))) return rollForward(new Date(mm[3] ? +mm[3] : now.getFullYear(), MONTHS_EN[mm[2]], +mm[1]), !!mm[3]);
      if ((mm = new RegExp('^(' + EN_MON + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$').exec(s))) return rollForward(new Date(mm[3] ? +mm[3] : now.getFullYear(), MONTHS_EN[mm[1]], +mm[2]), !!mm[3]);
      if ((mm = new RegExp('^(\\d{1,2})\\s+(?:من\\s+)?(?:شهر\\s+)?(' + AR_MON + ')(?:\\s+(\\d{4}))?$').exec(s))) return rollForward(new Date(mm[3] ? +mm[3] : now.getFullYear(), MONTHS_AR[mm[2]], +mm[1]), !!mm[3]);
      if (/year|السنه|العام/.test(s)) return new Date(now.getFullYear(), 11, 31);
      if (/month|الشهر/.test(s)) return new Date(now.getFullYear(), now.getMonth() + 1, 0);
      if (/semester|الفصل/.test(s)) return C.addDays(now, 120);
      return null;
    }
    const DATE_SRC = '(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{1,2})\\s*/\\s*(\\d{1,2})(?:\\s*/\\s*(\\d{2,4}))?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:' + EN_MON + ')(?:,?\\s+\\d{4})?|(?:' + EN_MON + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|(\\d{1,2})\\s+(?:من\\s+)?(?:شهر\\s+)?(?:' + AR_MON + ')(?:\\s+\\d{4})?';

    // repeat until <date>  (must run before plain dates so the until-date is not taken as the start date)
    if (r.repeat && (m = take(W(UNTIL + '\\s+(' + DATE_SRC + '|end of (?:the )?(?:year|month|semester)|نهايه (?:السنه|الشهر|الفصل))'), 'until'))) {
      const d = dateFromText(m[1].trim());
      if (d && !isNaN(d.getTime())) r.repeat.until = toDateStr(d);
    }
    if (!explicitDate && (m = take(W('(?:the )?day after tomorrow|بعد غد|بعد بكره|بعد بكرا'), 'date'))) setDate(C.addDays(now, 2));
    if (!explicitDate && (m = take(W('tomorrow|tmrw|tmr|غدا|غد|بكره|بكرا'), 'date'))) setDate(C.addDays(now, 1));
    if (!explicitDate && (m = take(W('today|اليوم'), 'date'))) setDate(now);
    if (!explicitDate && (m = take(W('in\\s+(\\d+)\\s*(days?|weeks?|months?)|بعد\\s+(\\d+)\\s*(يوم|ايام|اسبوع|اسابيع|شهر|اشهر|شهور)|بعد\\s+(اسبوع|اسبوعين|شهر|شهرين|يومين)'), 'date'))) {
      let n, unit;
      if (m[1]) { n = parseInt(m[1], 10); unit = m[2]; }
      else if (m[3]) { n = parseInt(m[3], 10); unit = m[4]; }
      else { n = /ين$/.test(m[5]) ? 2 : 1; unit = m[5]; }
      if (/^day|يوم|ايام/.test(unit)) setDate(C.addDays(now, n));
      else if (/^week|اسبوع|اسابيع/.test(unit)) setDate(C.addDays(now, 7 * n));
      else setDate(clampDay(now.getFullYear(), now.getMonth() + n, now.getDate()));
    }
    if (!explicitDate && take(W('next\\s+week|الاسبوع (?:القادم|الجاي|المقبل)'), 'date')) setDate(C.addDays(now, 7));
    if (!explicitDate && take(W('next\\s+month|الشهر (?:القادم|الجاي|المقبل)'), 'date')) setDate(clampDay(now.getFullYear(), now.getMonth() + 1, now.getDate()));
    if (!explicitDate && take(W('next\\s+year|السنه (?:القادمه|الجايه|المقبله)|العام (?:القادم|المقبل)'), 'date')) setDate(clampDay(now.getFullYear() + 1, now.getMonth(), now.getDate()));
    if (!explicitDate && (m = take(/(?<![0-9])(\d{4})-(\d{1,2})-(\d{1,2})(?![0-9])/, 'date'))) setDate(new Date(+m[1], +m[2] - 1, +m[3]));
    if (!explicitDate && (m = take(W('(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + EN_MON + ')(?:,?\\s+(\\d{4}))?'), 'date'))) setDate(rollForward(new Date(m[3] ? +m[3] : now.getFullYear(), MONTHS_EN[m[2]], +m[1]), !!m[3]));
    if (!explicitDate && (m = take(W('(?:on\\s+)?(' + EN_MON + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?'), 'date'))) setDate(rollForward(new Date(m[3] ? +m[3] : now.getFullYear(), MONTHS_EN[m[1]], +m[2]), !!m[3]));
    if (!explicitDate && (m = take(W('(\\d{1,2})\\s+(?:من\\s+)?(?:شهر\\s+)?(' + AR_MON + ')(?:\\s+(\\d{4}))?'), 'date'))) setDate(rollForward(new Date(m[3] ? +m[3] : now.getFullYear(), MONTHS_AR[m[2]], +m[1]), !!m[3]));
    if (!explicitDate && (m = take(W('(?:on\\s+)?(\\d{1,2})\\s*/\\s*(\\d{1,2})(?:\\s*/\\s*(\\d{2,4}))?'), 'date'))) setDate(numericDate(+m[1], +m[2], m[3]));
    if (!explicitDate && (m = take(W('(?:on\\s+)?the\\s+(\\d{1,2})(?:st|nd|rd|th)'), 'date'))) {
      let d = clampDay(now.getFullYear(), now.getMonth(), +m[1]);
      if (d < C.startOfDay(now)) d = clampDay(now.getFullYear(), now.getMonth() + 1, +m[1]);
      setDate(d);
    }
    if (!explicitDate) {
      let wd = null, next = false;
      if ((m = take(W('(?:on\\s+)?(?:(next|this|coming)\\s+)?(' + EN_WD + ')'), 'date'))) { wd = WEEKDAYS_EN[m[2]]; next = m[1] === 'next'; }
      else if ((m = take(W('(?:يوم\\s+)?(?:ال)?(' + AR_WD + ')(?:\\s+(القادم|الجاي|المقبل|القادمه|الجايه|المقبله))?'), 'date'))) { wd = WEEKDAYS_AR[m[1]]; next = !!m[2]; }
      if (wd !== null) {
        let d = nextWeekday(wd, now, true);
        if (next) { // "next Monday" = the Monday of next week
          const nextWeekStart = C.addDays(C.startOfWeek(now, weekStart), 7);
          if (d < nextWeekStart) d = C.addDays(d, 7);
        }
        setDate(d);
      }
    }
    if (!explicitDate && repeatWeekday !== null) setDate(nextWeekday(repeatWeekday, now, true));

    /* ---- 8. times ---- */
    const AMPM = '(am|pm|a\\.m\\.|p\\.m\\.|ص|صباحا|م|مساء|ظهرا|عصرا|ليلا|فجرا|بعد الظهر|بعد الضهر)';
    const TIME = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*' + AMPM + '?';
    function isPM(mark) { return /^(pm|p\.m\.|م|مساء|ظهرا|عصرا|ليلا|بعد الظهر|بعد الضهر)$/.test(mark || ''); }
    function isAM(mark) { return /^(am|a\.m\.|ص|صباحا|فجرا)$/.test(mark || ''); }
    const PERIODS = [
      [longestFirst('tonight|this evening|in the evening|evening|المساء|مساء|مساءا|هذا المساء'), true, 19 * 60],
      [longestFirst('this afternoon|in the afternoon|afternoon|بعد الظهر|بعد الضهر|العصر|عصرا'), true, 15 * 60],
      [longestFirst('at noon|noon|midday|الظهر|ظهرا'), true, 12 * 60],
      [longestFirst('at night|late night|night|الليل|ليلا|الليله'), true, 21 * 60],
      [longestFirst('this morning|in the morning|morning|الصباح|صباحا|الصبح'), false, 9 * 60],
      ['midnight|منتصف الليل', false, 0],
      ['dawn|الفجر|فجرا', false, 5 * 60]
    ];
    let hintPM = null;
    for (const p of PERIODS) { if (has(p[0])) { hintPM = p[1]; break; } }
    function toTime(h, mm, mark, hint) {
      h = parseInt(h, 10); mm = mm ? parseInt(mm, 10) : 0;
      if (h > 24 || mm > 59) return null;
      if (isPM(mark)) { if (h < 12) h += 12; }
      else if (isAM(mark)) { if (h === 12) h = 0; }
      else if (hint === true) { if (h < 12) h += 12; }
      else if (hint === false) { if (h === 12) h = 0; }
      else if (h >= 1 && h <= 6) h += 12; // "at 1" → 13:00
      if (h === 24) h = 0;
      return fromMinutes(h * 60 + mm);
    }
    // ranges: "from 9 to 11", "9-11am", "1pm to 3pm", "من 9 الى 11"
    if ((m = take(W('(?:from|من)?\\s*' + TIME + '\\s*(?:-|–|to|until|till|الي|الى|ل|حتي|حتى|لغايه)\\s*' + TIME), 'time'))) {
      const sMark = m[3] || null, eMark = m[6] || null;
      let en = toTime(m[4], m[5], eMark, hintPM);
      let st;
      if (sMark) st = toTime(m[1], m[2], sMark, hintPM);
      else if (eMark) { st = toTime(m[1], m[2], eMark, null); if (st && en && C.toMinutes(st) >= C.toMinutes(en)) st = toTime(m[1], m[2], isPM(eMark) ? 'am' : 'pm', null); }
      else st = toTime(m[1], m[2], null, hintPM);
      if (st && en && C.toMinutes(en) <= C.toMinutes(st) && !eMark && C.toMinutes(en) < 12 * 60) en = fromMinutes(C.toMinutes(en) + 720);
      if (st && en) { r.time = st; r.endTime = C.toMinutes(en) > C.toMinutes(st) ? en : null; }
      else if (st) r.time = st;
    }
    if (!r.time) {
      m = take(W('(?:at|@|الساعه|على الساعه|عالساعه|ع الساعه)\\s*' + TIME), 'time') || take(W('(\\d{1,2})[:.](\\d{2})\\s*' + AMPM + '?'), 'time') || take(W('(\\d{1,2})()\\s*' + AMPM), 'time');
      if (m) {
        r.time = toTime(m[1], m[2], m[3], hintPM);
        const u = take(W('(?:until|till|to|حتي|حتى|الي|الى|لغايه)\\s*' + TIME), 'time');
        if (u && r.time) {
          let en = toTime(u[1], u[2], u[3], C.toMinutes(r.time) >= 12 * 60 ? true : hintPM);
          if (en && C.toMinutes(en) <= C.toMinutes(r.time) && !u[3] && C.toMinutes(en) < 12 * 60) en = fromMinutes(C.toMinutes(en) + 720);
          if (en && C.toMinutes(en) > C.toMinutes(r.time)) r.endTime = en;
        }
      }
    }
    // period words: consumed; give a default time when none was given
    let periodDefault = null;
    for (const p of PERIODS) {
      const pm = take(W(p[0]), 'period');
      if (pm) {
        periodDefault = p[2];
        if (/tonight|الليله|هذا المساء|this (?:evening|afternoon|morning)/.test(pm[0]) && !explicitDate) setDate(now);
        break;
      }
    }
    if (!r.time && periodDefault !== null && r.allDay !== true) r.time = fromMinutes(periodDefault);

    /* ---- 9. location: trailing "at X" / "in X" / "في X" / "@X" ---- */
    m = take(/(?<![a-z0-9؀-ۿ])(?:at|in|@|في|بـ|ب)\s+([^,.;]+?)\s*$/, 'location');
    if (m && m[1] && m[1].trim().length > 1 && !/^\d/.test(m[1].trim())) {
      const off = m.index + m[0].indexOf(m[1]);
      r.location = original.slice(off, off + m[1].length).trim();
    } else if (m) {
      for (let i = m.index; i < m.index + m[0].length; i++) used[i] = false;
      r.tokens.pop();
    }

    /* ---- 10. title = whatever is left ---- */
    let title = '';
    for (let i = 0; i < chars.length; i++) {
      if (used[i]) { title += ' '; continue; }
      if (i > 0 && used[i - 1] && chars[i] !== ' ' && normalizeChar(chars[i]) === ' ') continue; // tashkeel left behind by a consumed word
      title += chars[i];
    }
    title = title.replace(/\s+/g, ' ').trim();
    const edge = /^(?:at|on|in|from|to|for|and|the|a|an|,|-|–|·|\.|:|في|من|الي|إلى|الى|علي|على|عند|يوم|و|،|ثم|الساعة|الساعه)\s+/i;
    const edgeEnd = /\s+(?:at|on|in|from|to|for|and|the|a|an|,|-|–|·|\.|:|في|من|الي|إلى|الى|علي|على|عند|يوم|و|،|ثم|الساعة|الساعه)$/i;
    let prev;
    do { prev = title; title = title.replace(edge, '').replace(edgeEnd, '').replace(/^[,.;:\-–·،]+|[,.;:\-–·،]+$/g, '').trim(); } while (title !== prev);
    if (title && /^[a-z]/.test(title)) title = title.charAt(0).toUpperCase() + title.slice(1);
    r.title = title;

    /* ---- 11. defaults ---- */
    if (!r.date) {
      r.date = toDateStr(now);
      if (r.time && !relTimeSet) { // a time clearly in the past today → tomorrow
        const mins = now.getHours() * 60 + now.getMinutes();
        if (C.toMinutes(r.time) < mins - 60) r.date = toDateStr(C.addDays(now, 1));
      }
    }
    if (r.allDay === null) r.allDay = !r.time;
    if (r.allDay) { r.time = null; r.endTime = null; }
    if (r.time && !r.endTime) {
      const end = C.toMinutes(r.time) + (durationMin || 60);
      r.endTime = end < 1440 ? fromMinutes(end) : '23:59';
    }
    r.durationMin = durationMin;
    r.category = r.categoryTag ? null : guessCategory(norm, opts.categories || null);
    r.explicitDate = explicitDate;
    return r;
  }

  const api = { parse: parse, normalize: normalize, guessCategory: guessCategory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.LuminaNLP = api;
})(typeof window !== 'undefined' ? window : globalThis);
