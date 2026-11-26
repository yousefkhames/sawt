(function () {
  'use strict';
  var L = window.SawtLib, T = window.SawtI18n;
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'sawt.v1', SKEY = 'sawt.settings';

  var settings = load(SKEY, { theme: 'auto', ui: null, lang: null, cmds: true });
  var notes = (load(KEY, { notes: [] }).notes || []).map(L.makeNote);
  if (!settings.ui) settings.ui = (navigator.language || '').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en';
  if (!settings.lang) settings.lang = settings.ui === 'ar' ? 'ar-EG' : 'en-US';
  var support = L.detectSupport(window);
  var currentId = null, view = 'record';
  var session = null; // active recording session
  var deletedStash = null, toastTimer = null, saveTimer = null;

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v || d; } catch (e) { return d; } }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ notes: notes })); localStorage.setItem(SKEY, JSON.stringify(settings)); return true; }
    catch (e) { toast(t('storageFull')); return false; }
  }
  function t(k, vars) {
    var s = (T[settings.ui] && T[settings.ui][k]) || T.en[k] || k;
    if (vars) Object.keys(vars).forEach(function (n) { s = s.replace('{' + n + '}', vars[n]); });
    return s;
  }
  function byId(id) { for (var i = 0; i < notes.length; i++) if (notes[i].id === id) return notes[i]; return null; }

  /* ---------- i18n / theme ---------- */
  function applyUi() {
    var rtl = settings.ui === 'ar';
    document.documentElement.lang = settings.ui;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    document.title = rtl ? 'صوت · Sawt' : 'Sawt · صوت';
    [].forEach.call(document.querySelectorAll('[data-i]'), function (el) { el.textContent = t(el.getAttribute('data-i')); });
    [].forEach.call(document.querySelectorAll('[data-ip]'), function (el) { el.placeholder = t(el.getAttribute('data-ip')); });
    $('btnUiLang').textContent = rtl ? 'EN' : 'ع';
    $('btnUiLang').setAttribute('aria-label', rtl ? 'English' : 'العربية');
    $('btnSettings').setAttribute('aria-label', t('settings'));
    $('btnPin').setAttribute('aria-label', t('pin'));
    $('btnDelete').setAttribute('aria-label', t('delete'));
    $('noteText').setAttribute('aria-label', t('text'));
    setRecUi(!!session);
    applyTheme();
    renderBanner();
    if (view === 'notes') renderList();
    if (view === 'edit') renderEdit(false);
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    [].forEach.call(document.querySelectorAll('#segTheme button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme)); });
    var m = document.querySelector('meta[name=theme-color]');
    var dark = settings.theme === 'dark' || (settings.theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    if (m) m.content = dark ? '#12142a' : '#f3ede1';
  }

  /* ---------- toast ---------- */
  function toast(msg, actLabel, act) {
    $('toastMsg').textContent = msg;
    var b = $('toastAct');
    b.hidden = !actLabel; b.textContent = actLabel || ''; b.onclick = function () { hideToast(); if (act) act(); };
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actLabel ? 7000 : 2600);
  }
  function hideToast() { $('toast').hidden = true; }

  /* ---------- routing ---------- */
  function route() {
    var h = location.hash;
    var m = h.match(/^#\/n\/(.+)$/);
    if (m && byId(decodeURIComponent(m[1]))) { currentId = decodeURIComponent(m[1]); show('edit'); }
    else if (h === '#notes') show('notes');
    else show('record');
  }
  function show(v) {
    if (session && v !== 'edit' && session.mode === 'append') stopSession(true);
    view = v;
    $('viewRecord').hidden = v !== 'record';
    $('viewNotes').hidden = v !== 'notes';
    $('viewEdit').hidden = v !== 'edit';
    document.body.classList.toggle('editing', v === 'edit');
    [].forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('on', b.dataset.tab === (v === 'record' ? 'record' : 'notes')); });
    if (v === 'notes') renderList();
    if (v === 'edit') renderEdit(true);
    window.scrollTo(0, 0);
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  /* ---------- support banner ---------- */
  function renderBanner() {
    var b = $('banner');
    if (support.recognition && support.secure) { b.hidden = true; return; }
    b.hidden = false;
    $('bannerTitle').textContent = t('unsupportedTitle');
    $('bannerBody').textContent = support.recognition ? t('insecure') : t('unsupportedBody');
    $('btnRec').disabled = true;
    $('btnRec').style.opacity = .45;
    $('status').textContent = '';
  }

  /* ---------- recognition session ---------- */
  var wave = { ctx: null, an: null, stream: null, raf: 0, data: null };

  function setRecUi(on) {
    var b = $('btnRec');
    b.setAttribute('aria-pressed', String(on));
    $('recLabel').textContent = on ? t('stop') : t('start');
    if (!session) $('status').textContent = support.recognition && support.secure ? t('tapToStart') : '';
  }

  function startSession(mode, noteId) {
    if (session) return;
    if (!support.recognition || !support.secure) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var lang = mode === 'append' ? byId(noteId).lang : $('selLang').value;
    var rec = new SR();
    rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    session = { mode: mode, noteId: noteId, rec: rec, lang: lang, t0: Date.now(), text: '', segs: [], segStart: null, want: true, fatal: false, tick: 0, base: mode === 'append' ? (byId(noteId).duration || 0) : 0 };
    var fin = mode === 'append' ? $('editFinal') : $('liveFinal');
    var inter = mode === 'append' ? $('editInterim') : $('liveInterim');
    session.finEl = fin; session.interEl = inter;
    fin.textContent = ''; inter.textContent = '';
    if (mode === 'record') $('livePh').hidden = true; else { $('editLive').hidden = false; $('btnAppend').classList.add('live-on'); }

    rec.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i], txt = r[0].transcript;
        if (r.isFinal) {
          var clean = settings.cmds ? L.applyVoiceCommands(txt.trim(), lang) : txt.trim();
          if (clean) {
            var start = session.segStart != null ? session.segStart : Math.max(0, Date.now() - session.t0 - 1500);
            session.segs.push({ t: session.base + start, text: clean });
            session.text = L.joinChunks(session.text, clean);
          }
          session.segStart = null;
        } else {
          if (session.segStart == null) session.segStart = Date.now() - session.t0;
          interim += txt;
        }
      }
      fin.textContent = session.text;
      inter.textContent = interim ? ' ' + interim : '';
      var box = mode === 'append' ? $('editLive') : $('live');
      box.scrollTop = box.scrollHeight;
    };
    rec.onerror = function (ev) {
      var e = ev && ev.error;
      if (e === 'no-speech' || e === 'aborted') return; // restart handled in onend
      if (e === 'not-allowed' || e === 'service-not-allowed') { session.fatal = true; $('status').textContent = t('micDenied'); toast(t('micDenied')); }
      else if (e === 'network') { session.fatal = true; $('status').textContent = t('netErr'); toast(t('netErr')); }
      else if (e === 'language-not-supported') { session.fatal = true; $('status').textContent = t('recErr') + e; }
      else { $('status').textContent = t('recErr') + e; }
    };
    rec.onend = function () {
      if (!session || session.rec !== rec) return;
      if (session.want && !session.fatal) { try { rec.start(); } catch (e) { /* already started */ } }
      else finishSession(session.fatal);
    };
    try { rec.start(); } catch (e) { session = null; toast(t('recErr') + e.message); return; }
    $('status').textContent = t('listening');
    setRecUi(true);
    session.timer = setInterval(updateTimer, 250);
    updateTimer();
    startWave();
  }

  function updateTimer() {
    if (!session) return;
    var ms = Date.now() - session.t0;
    $('timer').textContent = L.formatDuration(ms);
  }

  function stopSession(silent) {
    if (!session) return;
    session.want = false; session.silent = !!silent;
    try { session.rec.stop(); } catch (e) { finishSession(false); }
    // Safety net if the engine never fires onend.
    var s = session;
    setTimeout(function () { if (session === s) finishSession(false); }, 1800);
  }

  function finishSession() {
    var s = session; if (!s) return;
    session = null;
    clearInterval(s.timer);
    stopWave();
    var dur = Date.now() - s.t0;
    $('liveInterim').textContent = ''; $('editInterim').textContent = '';
    setRecUi(false);
    $('btnAppend').classList.remove('live-on');
    $('editLive').hidden = true;
    $('timer').textContent = '0:00';
    if (s.mode === 'record') {
      $('liveFinal').textContent = ''; $('livePh').hidden = false;
      if (!s.text.trim()) { $('status').textContent = t('noSpeech'); toast(t('discarded')); return; }
      var n = L.makeNote({ lang: s.lang, duration: dur, segments: s.segs, text: s.text });
      n.title = L.autoTitle(n.text, t('untitled'));
      notes.unshift(n); persist(); updateCounts();
      toast(t('saved'));
      go('#/n/' + encodeURIComponent(n.id));
    } else {
      var note = byId(s.noteId);
      if (note && s.text.trim()) {
        var ta = $('noteText');
        note.text = L.joinChunks(ta.value.replace(/\s+$/, ''), s.text);
        note.segments = (note.segments || []).concat(s.segs);
        note.duration = (note.duration || 0) + dur;
        note.updated = Date.now();
        persist(); renderEdit(false); toast(t('saved'));
      }
    }
  }

  /* ---------- waveform ---------- */
  function startWave() {
    var cv = $('wave');
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC && support.media) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        if (!session) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        wave.stream = stream; wave.ctx = new AC();
        wave.an = wave.ctx.createAnalyser(); wave.an.fftSize = 256;
        wave.ctx.createMediaStreamSource(stream).connect(wave.an);
        wave.data = new Uint8Array(wave.an.frequencyBinCount);
      }).catch(function () { /* waveform is optional */ });
    }
    var g = cv.getContext('2d'), n = 0;
    (function frame() {
      wave.raf = requestAnimationFrame(frame);
      n++;
      var w = cv.width, h = cv.height, bars = 48, bw = w / bars;
      g.clearRect(0, 0, w, h);
      var cs = getComputedStyle(document.documentElement);
      g.fillStyle = cs.getPropertyValue('--acc').trim() || '#ef5b45';
      if (wave.an) wave.an.getByteFrequencyData(wave.data);
      for (var i = 0; i < bars; i++) {
        var v;
        if (wave.an) v = wave.data[Math.min(wave.data.length - 1, Math.floor(i * 0.6))] / 255;
        else v = 0.12 + 0.1 * Math.sin(n / 9 + i / 2.5);
        var bh = Math.max(4, v * h * 0.95), x = i * bw + bw * 0.2;
        g.beginPath();
        if (g.roundRect) g.roundRect(x, (h - bh) / 2, bw * 0.6, bh, 4); else g.rect(x, (h - bh) / 2, bw * 0.6, bh);
        g.fill();
      }
    })();
  }
  function stopWave() {
    cancelAnimationFrame(wave.raf);
    if (wave.stream) wave.stream.getTracks().forEach(function (t) { t.stop(); });
    if (wave.ctx && wave.ctx.close) wave.ctx.close().catch(function () {});
    wave.stream = wave.ctx = wave.an = wave.data = null;
    var cv = $('wave'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  }

  /* ---------- notes list ---------- */
  function fmtDate(ts) {
    try { return new Intl.DateTimeFormat(settings.ui === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts)); }
    catch (e) { return new Date(ts).toLocaleString(); }
  }
  function highlight(el, text, q) {
    el.textContent = '';
    q = (q || '').trim();
    if (!q) { el.textContent = text; return; }
    var lower = text.toLowerCase(), ql = q.toLowerCase(), i = 0, j;
    while ((j = lower.indexOf(ql, i)) !== -1) {
      el.appendChild(document.createTextNode(text.slice(i, j)));
      var m = document.createElement('mark'); m.textContent = text.slice(j, j + q.length); el.appendChild(m);
      i = j + q.length;
    }
    el.appendChild(document.createTextNode(text.slice(i)));
  }
  function updateCounts() {
    var c = $('tabCount'); c.hidden = !notes.length; c.textContent = notes.length;
    var w = notes.reduce(function (a, n) { return a + L.wordCount(n.text); }, 0);
    $('stats').textContent = settings.ui === 'en' && notes.length === 1 ? '1 note · ' + w + (w === 1 ? ' word' : ' words') : t('stats', { n: notes.length, w: w });
  }
  function renderList() {
    updateCounts();
    var q = $('search').value;
    var list = L.sortNotes(notes).filter(function (n) { return L.matches(n, q); });
    var ul = $('list'); ul.textContent = '';
    $('empty').hidden = list.length > 0;
    if (!list.length) {
      $('empty').querySelector('b').textContent = notes.length ? t('noResults') : t('empty');
      $('empty').querySelector('p').textContent = notes.length ? '' : t('emptyHint');
    }
    list.forEach(function (n) {
      var li = document.createElement('li');
      var b = document.createElement('button'); b.type = 'button'; b.className = 'item'; b.dataset.id = n.id;
      var h = document.createElement('h3');
      if (n.pinned) { var p = document.createElement('span'); p.className = 'pin'; p.textContent = '★'; p.setAttribute('aria-label', t('pinned')); h.appendChild(p); }
      var ts = document.createElement('span'); ts.dir = 'auto'; highlight(ts, n.title || t('untitled'), q); h.appendChild(ts);
      var pr = document.createElement('p'); pr.dir = 'auto'; highlight(pr, n.text.slice(0, 220), q);
      var m = document.createElement('div'); m.className = 'm';
      [fmtDate(n.updated), L.wordCount(n.text) + ' ' + t('words'), n.duration ? L.formatDuration(n.duration) : '', n.lang].forEach(function (x) { if (x) { var s = document.createElement('span'); s.textContent = x; m.appendChild(s); } });
      b.appendChild(h); b.appendChild(pr); b.appendChild(m);
      b.addEventListener('click', function () { go('#/n/' + encodeURIComponent(n.id)); });
      li.appendChild(b); ul.appendChild(li);
    });
  }

  /* ---------- editor ---------- */
  function renderEdit(full) {
    var n = byId(currentId); if (!n) { go('#notes'); return; }
    if (full || document.activeElement !== $('noteTitle')) $('noteTitle').value = n.title;
    if (full || document.activeElement !== $('noteText')) $('noteText').value = n.text;
    $('btnPin').setAttribute('aria-pressed', String(!!n.pinned));
    $('btnPin').setAttribute('aria-label', n.pinned ? t('unpin') : t('pin'));
    $('btnShare').hidden = !navigator.share;
    updateMeta();
  }
  function updateMeta() {
    var n = byId(currentId); if (!n) return;
    var txt = $('noteText').value;
    $('noteMeta').textContent = '';
    [fmtDate(n.created), L.wordCount(txt) + ' ' + t('words'), L.charCount(txt) + ' ✎', n.duration ? L.formatDuration(n.duration) : '', n.lang].forEach(function (x) {
      if (!x) return; var s = document.createElement('span'); s.textContent = x; $('noteMeta').appendChild(s);
    });
  }
  function queueSave() {
    var n = byId(currentId); if (!n) return;
    n.title = $('noteTitle').value; n.text = $('noteText').value; n.updated = Date.now();
    updateMeta();
    clearTimeout(saveTimer); saveTimer = setTimeout(persist, 300);
  }
  function flushSave() { clearTimeout(saveTimer); if (view === 'edit' && byId(currentId)) { var n = byId(currentId); n.title = $('noteTitle').value; n.text = $('noteText').value; } persist(); }

  /* ---------- export ---------- */
  function safeName(n, ext) {
    var base = (n.title || 'sawt-note').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) || 'sawt-note';
    return base + '.' + ext;
  }
  function download(name, mime, content) {
    var blob = new Blob(['\ufeff' + content], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function exportNote(kind) {
    flushSave();
    var n = byId(currentId); if (!n) return;
    if (kind === 'txt') download(safeName(n, 'txt'), 'text/plain', L.toTXT(n));
    if (kind === 'md') download(safeName(n, 'md'), 'text/markdown', L.toMD(n));
    if (kind === 'srt') download(safeName(n, 'srt'), 'application/x-subrip', L.toSRT(n));
    if (kind === 'json') download(safeName(n, 'json'), 'application/json', L.toJSON([n]));
  }
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea'); ta.value = s; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); } ta.remove();
    });
  }

  /* ---------- events ---------- */
  $('btnRec').addEventListener('click', function () { session ? stopSession() : startSession('record'); });
  $('selLang').addEventListener('change', function () { settings.lang = this.value; persist(); });
  $('chkCmds').addEventListener('change', function () { settings.cmds = this.checked; persist(); });
  $('btnManual').addEventListener('click', function () {
    var n = L.makeNote({ lang: $('selLang').value }); n.title = ''; notes.unshift(n); persist(); updateCounts();
    go('#/n/' + encodeURIComponent(n.id)); setTimeout(function () { $('noteText').focus(); }, 50);
  });
  [].forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.addEventListener('click', function () { go(b.dataset.tab === 'notes' ? '#notes' : '#record'); });
  });
  $('search').addEventListener('input', renderList);
  $('btnBack').addEventListener('click', function () { flushSave(); go('#notes'); });
  $('noteTitle').addEventListener('input', queueSave);
  $('noteText').addEventListener('input', queueSave);
  $('btnPin').addEventListener('click', function () { var n = byId(currentId); n.pinned = !n.pinned; persist(); renderEdit(false); });
  $('btnDelete').addEventListener('click', function () {
    var n = byId(currentId); if (!n) return;
    var idx = notes.indexOf(n); deletedStash = { n: n, idx: idx };
    notes.splice(idx, 1); persist(); updateCounts(); go('#notes');
    toast(t('deleted'), t('undo'), function () {
      if (!deletedStash) return; notes.splice(Math.min(deletedStash.idx, notes.length), 0, deletedStash.n); deletedStash = null; persist(); renderList();
    });
  });
  $('btnAppend').addEventListener('click', function () { session ? stopSession() : startSession('append', currentId); });
  $('btnCopy').addEventListener('click', function () { copyText($('noteText').value).then(function () { toast(t('copied')); }, function () {}); });
  $('btnShare').addEventListener('click', function () { var n = byId(currentId); navigator.share({ title: n.title, text: $('noteText').value }).catch(function () {}); });
  $('frGo').addEventListener('click', function () {
    var r = L.replaceAll($('noteText').value, $('frFind').value, $('frRepl').value);
    if (r.count) { $('noteText').value = r.text; queueSave(); }
    toast(t('replaced') + r.count);
  });
  [].forEach.call(document.querySelectorAll('[data-exp]'), function (b) { b.addEventListener('click', function () { exportNote(b.dataset.exp); }); });
  $('btnUiLang').addEventListener('click', function () { settings.ui = settings.ui === 'ar' ? 'en' : 'ar'; persist(); applyUi(); });
  $('btnSettings').addEventListener('click', function () { $('dlgSettings').showModal(); });
  [].forEach.call(document.querySelectorAll('#segTheme button'), function (b) { b.addEventListener('click', function () { settings.theme = b.dataset.theme; persist(); applyTheme(); }); });
  $('btnExportAll').addEventListener('click', function () { download('sawt-backup.json', 'application/json', L.toJSON(notes)); });
  $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
  $('fileImport').addEventListener('change', function () {
    var f = this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var r = L.parseImport(String(rd.result));
      if (r.error || (!r.notes.length)) { toast(t('importBad')); return; }
      var m = L.mergeNotes(notes, r.notes); notes = m.notes; persist(); updateCounts();
      toast(t('imported', { a: m.added, u: m.updated }) + (r.skipped ? t('importSkipped', { s: r.skipped }) : ''));
      if (view === 'notes') renderList();
    };
    rd.readAsText(f); this.value = '';
  });
  $('btnWipe').addEventListener('click', function () {
    if (!confirm(t('wipeConfirm'))) return;
    notes = []; persist(); updateCounts(); $('dlgSettings').close(); go('#notes'); renderList();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', function () { flushSave(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(); });

  /* ---------- boot ---------- */
  $('selLang').value = settings.lang; $('chkCmds').checked = settings.cmds !== false;
  applyUi(); updateCounts(); route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') { /* intentionally no service worker: keeps the demo simple and honest */ }
})();
