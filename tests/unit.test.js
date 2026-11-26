const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/lib.js');

test('arabic spoken punctuation', () => {
  assert.equal(L.applyVoiceCommands('مرحبا نقطة كيف حالك علامة استفهام', 'ar-EG'), 'مرحبا. كيف حالك؟');
  assert.equal(L.applyVoiceCommands('واحد فاصلة اتنين سطر جديد تلاتة', 'ar-SA'), 'واحد، اتنين\nتلاتة');
});
test('english spoken punctuation', () => {
  assert.equal(L.applyVoiceCommands('hello comma world period', 'en-US'), 'hello, world.');
  assert.equal(L.applyVoiceCommands('really question mark new line yes', 'en-GB'), 'really?\nyes');
});
test('words are untouched when no command', () => {
  assert.equal(L.applyVoiceCommands('the comma is a mark', 'ar-EG'), 'the comma is a mark');
  assert.equal(L.applyVoiceCommands('  plain text ', 'en-US'), 'plain text');
});
test('joinChunks spacing', () => {
  assert.equal(L.joinChunks('', 'a'), 'a');
  assert.equal(L.joinChunks('a', 'b'), 'a b');
  assert.equal(L.joinChunks('a', '.'), 'a.');
  assert.equal(L.joinChunks('a\n', 'b'), 'a\nb');
});
test('word and char counts, arabic included', () => {
  assert.equal(L.wordCount('  هذا نص تجريبي  '), 3);
  assert.equal(L.wordCount(''), 0);
  assert.equal(L.charCount('a😀b'), 3);
});
test('duration and srt time', () => {
  assert.equal(L.formatDuration(65000), '1:05');
  assert.equal(L.formatDuration(3725000), '1:02:05');
  assert.equal(L.srtTime(3723456), '01:02:03,456');
});
test('SRT from recorded segments', () => {
  const n = L.makeNote({ duration: 9000, text: 'one two', segments: [{ t: 0, text: 'one' }, { t: 4000, text: 'two' }] });
  assert.equal(L.toSRT(n), '1\n00:00:00,000 --> 00:00:04,000\none\n\n2\n00:00:04,000 --> 00:00:09,000\ntwo\n');
});
test('SRT falls back to estimated timing after an edit', () => {
  const n = L.makeNote({ duration: 10000, text: 'Edited one. Edited two.', segments: [{ t: 0, text: 'old' }] });
  const cues = L.buildCues(n);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0);
  assert.ok(Math.abs(cues[1].end - 10000) < 1);
});
test('SRT empty note gives empty output', () => {
  assert.equal(L.toSRT(L.makeNote({ text: '' })), '');
});
test('markdown and txt export', () => {
  const n = L.makeNote({ title: 'Idea', text: 'body', lang: 'en-US', duration: 5000, created: Date.UTC(2026, 0, 2, 3, 4) });
  assert.match(L.toMD(n), /^# Idea\n\n\*2026-01-02 03:04 · en-US · 0:05\*\n\nbody\n$/);
  assert.equal(L.toTXT(n), 'Idea\n\nbody\n');
});
test('import validates and skips bad rows', () => {
  const raw = JSON.stringify({ notes: [{ text: 'ok', title: 'a', segments: [{ t: 1, text: 'x' }, { bad: 1 }] }, { title: 'no text' }, null] });
  const r = L.parseImport(raw);
  assert.equal(r.notes.length, 1);
  assert.equal(r.skipped, 2);
  assert.equal(r.notes[0].segments.length, 1);
  assert.equal(L.parseImport('not json').error, 'invalid-json');
  assert.equal(L.parseImport('{"a":1}').error, 'no-notes');
});
test('export then import roundtrip', () => {
  const n = L.makeNote({ title: 'ع', text: 'نص', segments: [{ t: 0, text: 'نص' }], duration: 1000 });
  const r = L.parseImport(L.toJSON([n]));
  assert.deepEqual(r.notes[0], n);
});
test('merge keeps newer', () => {
  const a = L.makeNote({ id: 'x', text: 'old', updated: 1 });
  const b = L.makeNote({ id: 'x', text: 'new', updated: 2 });
  const c = L.makeNote({ id: 'y', text: 'c' });
  const m = L.mergeNotes([a], [b, c]);
  assert.equal(m.added, 1); assert.equal(m.updated, 1);
  assert.equal(m.notes.find(n => n.id === 'x').text, 'new');
});
test('autoTitle', () => {
  assert.equal(L.autoTitle('مرحبا بكم في اجتماع اليوم. تفاصيل', 'x'), 'مرحبا بكم في اجتماع اليوم');
  assert.equal(L.autoTitle('', 'fallback'), 'fallback');
  assert.equal(L.autoTitle('one two three four five six seven eight', 'x'), 'one two three four five six');
});
test('search and sort', () => {
  const a = L.makeNote({ id: 'a', title: 'Shopping', text: 'milk', updated: 1, pinned: true });
  const b = L.makeNote({ id: 'b', title: 'Work', text: 'Milk run', updated: 5 });
  assert.equal([a, b].filter(n => L.matches(n, ' MILK ')).length, 2);
  assert.equal(L.matches(a, 'zzz'), false);
  assert.deepEqual(L.sortNotes([b, a]).map(n => n.id), ['a', 'b']);
});
test('replaceAll literal and case-insensitive', () => {
  assert.deepEqual(L.replaceAll('Cat cat (CAT)', 'cat', 'dog'), { text: 'dog dog (dog)', count: 3 });
  assert.deepEqual(L.replaceAll('a.b', '.', '-'), { text: 'a-b', count: 1 });
  assert.equal(L.replaceAll('abc', '', 'x').count, 0);
});
test('support detection', () => {
  assert.equal(L.detectSupport({ webkitSpeechRecognition: function () {}, navigator: { mediaDevices: { getUserMedia() {} } }, isSecureContext: true }).recognition, true);
  assert.equal(L.detectSupport({ navigator: {} }).recognition, false);
});
