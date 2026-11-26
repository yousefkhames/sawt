/* Sawt core logic: pure functions, no DOM. Works in browser (window.SawtLib) and Node. */
(function (root) {
  'use strict';

  var COMMANDS = {
    ar: [
      [/\s*(?:علامة استفهام|علامه استفهام)\s*/g, '؟ '],
      [/\s*(?:نقطة|نقطه)\s*/g, '. '],
      [/\s*فاصلة منقوطة\s*/g, '؛ '],
      [/\s*(?:فاصلة|فاصله|فاصل)\s*/g, '، '],
      [/\s*(?:علامة تعجب|علامه تعجب)\s*/g, '! '],
      [/\s*(?:سطر جديد|سطر جديدة)\s*/g, '\n']
    ],
    en: [
      [/\s*\bquestion mark\b\s*/gi, '? '],
      [/\s*\bexclamation (?:mark|point)\b\s*/gi, '! '],
      [/\s*\bsemicolon\b\s*/gi, '; '],
      [/\s*\bperiod\b\s*/gi, '. '],
      [/\s*\bfull stop\b\s*/gi, '. '],
      [/\s*\bcomma\b\s*/gi, ', '],
      [/\s*\bnew (?:line|paragraph)\b\s*/gi, '\n']
    ]
  };

  function langFamily(code) {
    return String(code || '').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en';
  }

  /* Turn spoken punctuation words into punctuation. */
  function applyVoiceCommands(text, lang) {
    var rules = COMMANDS[langFamily(lang)];
    var out = String(text || '');
    for (var i = 0; i < rules.length; i++) out = out.replace(rules[i][0], rules[i][1]);
    out = out.replace(/ +\n/g, '\n').replace(/\n +/g, '\n').replace(/ {2,}/g, ' ');
    return out.replace(/^\s+/, '').replace(/[ \t]+$/g, '');
  }

  /* Join a new recognised chunk onto existing text with sensible spacing. */
  function joinChunks(prev, chunk) {
    prev = String(prev || ''); chunk = String(chunk || '');
    if (!chunk) return prev;
    if (!prev) return chunk;
    if (/\n$/.test(prev) || /^\n/.test(chunk) || /^[.،,!?؟;؛:]/.test(chunk)) return prev + chunk;
    return prev + ' ' + chunk;
  }

  function wordCount(text) {
    var m = String(text || '').trim().match(/[^\s]+/g);
    return m ? m.length : 0;
  }

  function charCount(text) { return Array.from(String(text || '')).length; }

  function pad(n, l) { n = String(n); while (n.length < (l || 2)) n = '0' + n; return n; }

  function formatDuration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(r);
  }

  function srtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000),
      s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(r, 3);
  }

  function segmentsText(segs) {
    return (segs || []).map(function (s) { return s.text; }).join(' ').replace(/ ?\n ?/g, '\n').trim();
  }

  function splitSentences(text) {
    var parts = String(text || '').split(/(?<=[.!?؟۔])\s+|\n+/u);
    return parts.map(function (p) { return p.trim(); }).filter(Boolean);
  }

  /* Cues come from the recorded segments. If the user edited the text, timing is
     estimated: sentences share the note duration in proportion to their length. */
  function buildCues(note) {
    var segs = note.segments || [];
    var text = (note.text || '').trim();
    var same = segs.length && normalizeWs(segmentsText(segs)) === normalizeWs(text);
    if (same) {
      return segs.map(function (s, i) {
        var end = i + 1 < segs.length ? segs[i + 1].t : Math.max(s.t + 1500, note.duration || 0);
        if (end <= s.t) end = s.t + 1500;
        return { start: s.t, end: end, text: s.text.trim() };
      });
    }
    var sentences = splitSentences(text);
    if (!sentences.length) return [];
    var total = Math.max(note.duration || 0, sentences.length * 1500);
    var chars = sentences.reduce(function (a, s) { return a + s.length; }, 0) || 1;
    var cur = 0;
    return sentences.map(function (s) {
      var d = total * (s.length / chars);
      var cue = { start: cur, end: cur + d, text: s };
      cur += d;
      return cue;
    });
  }

  function normalizeWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function toSRT(note) {
    return buildCues(note).map(function (c, i) {
      return (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n';
    }).join('\n');
  }

  function toTXT(note) {
    return (note.title ? note.title + '\n\n' : '') + (note.text || '') + '\n';
  }

  function toMD(note) {
    var d = new Date(note.created || Date.now());
    return '# ' + (note.title || 'Untitled') + '\n\n' +
      '*' + d.toISOString().slice(0, 16).replace('T', ' ') + ' · ' + note.lang + ' · ' +
      formatDuration(note.duration || 0) + '*\n\n' + (note.text || '') + '\n';
  }

  function toJSON(notes) {
    return JSON.stringify({ app: 'sawt', version: 1, exported: new Date().toISOString(), notes: notes }, null, 2);
  }

  function uid() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function makeNote(o) {
    o = o || {};
    var now = Date.now();
    return {
      id: o.id || uid(),
      title: o.title || '',
      lang: o.lang || 'ar-EG',
      created: o.created || now,
      updated: o.updated || now,
      duration: +o.duration || 0,
      segments: Array.isArray(o.segments) ? o.segments : [],
      text: typeof o.text === 'string' ? o.text : '',
      pinned: !!o.pinned
    };
  }

  /* Validate imported data defensively. Returns {notes, skipped}. */
  function parseImport(raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return { notes: [], skipped: 0, error: 'invalid-json' }; }
    var list = Array.isArray(data) ? data : (data && Array.isArray(data.notes) ? data.notes : null);
    if (!list) return { notes: [], skipped: 0, error: 'no-notes' };
    var notes = [], skipped = 0;
    list.forEach(function (n) {
      if (!n || typeof n !== 'object' || typeof n.text !== 'string') { skipped++; return; }
      var segs = Array.isArray(n.segments) ? n.segments.filter(function (s) {
        return s && typeof s.text === 'string' && isFinite(s.t);
      }).map(function (s) { return { t: +s.t, text: s.text }; }) : [];
      notes.push(makeNote({
        id: typeof n.id === 'string' ? n.id : undefined,
        title: typeof n.title === 'string' ? n.title : '',
        lang: typeof n.lang === 'string' ? n.lang : 'ar-EG',
        created: isFinite(n.created) ? +n.created : undefined,
        updated: isFinite(n.updated) ? +n.updated : undefined,
        duration: n.duration, segments: segs, text: n.text, pinned: n.pinned
      }));
    });
    return { notes: notes, skipped: skipped };
  }

  function mergeNotes(existing, incoming) {
    var byId = {};
    existing.forEach(function (n) { byId[n.id] = n; });
    var added = 0, updated = 0;
    incoming.forEach(function (n) {
      if (byId[n.id]) {
        if ((n.updated || 0) > (byId[n.id].updated || 0)) { byId[n.id] = n; updated++; }
      } else { byId[n.id] = n; added++; }
    });
    return { notes: Object.keys(byId).map(function (k) { return byId[k]; }), added: added, updated: updated };
  }

  function autoTitle(text, fallback) {
    var first = String(text || '').trim().split(/\n|(?<=[.!?؟])\s/u)[0] || '';
    var words = first.split(/\s+/).slice(0, 6).join(' ');
    return words.replace(/[.،,!?؟;؛]+$/, '') || fallback || '';
  }

  function matches(note, q) {
    q = normalizeWs(q).toLowerCase();
    if (!q) return true;
    return (note.title + ' ' + note.text).toLowerCase().indexOf(q) !== -1;
  }

  function sortNotes(notes) {
    return notes.slice().sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updated || 0) - (a.updated || 0);
    });
  }

  /* Find and replace; returns {text, count}. Case-insensitive literal match. */
  function replaceAll(text, find, repl) {
    if (!find) return { text: text, count: 0 };
    var esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp(esc, 'giu'), n = 0;
    var out = String(text).replace(re, function () { n++; return repl; });
    return { text: out, count: n };
  }

  /* Browser support probe, takes a window-like object. */
  function detectSupport(w) {
    var rec = !!(w && (w.SpeechRecognition || w.webkitSpeechRecognition));
    var media = !!(w && w.navigator && w.navigator.mediaDevices && w.navigator.mediaDevices.getUserMedia);
    return { recognition: rec, media: media, secure: !w || w.isSecureContext !== false };
  }

  var api = {
    joinChunks: joinChunks,
    applyVoiceCommands: applyVoiceCommands, wordCount: wordCount, charCount: charCount,
    formatDuration: formatDuration, srtTime: srtTime, buildCues: buildCues, toSRT: toSRT,
    toTXT: toTXT, toMD: toMD, toJSON: toJSON, makeNote: makeNote, parseImport: parseImport,
    mergeNotes: mergeNotes, autoTitle: autoTitle, matches: matches, sortNotes: sortNotes,
    replaceAll: replaceAll, detectSupport: detectSupport, langFamily: langFamily,
    splitSentences: splitSentences, segmentsText: segmentsText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SawtLib = api;
})(typeof window !== 'undefined' ? window : this);
