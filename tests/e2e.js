// Real Chrome click-through over the DevTools protocol.
// Speech recognition is mocked (headless Chrome has no microphone or speech service); everything else is the real app.
// Usage: node tests/e2e.js [baseUrl] [screenshotDir]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const BASE = process.argv[2] || 'http://127.0.0.1:8123/';
const SHOTS = process.argv[3] || '';
const PORT = 9333 + Math.floor(Math.random() * 400);

const FAKE_SR = `(() => {
  class FakeSR { constructor(){ window.__rec = this; this.started=false; }
    start(){ if(this.started) throw new Error('already started'); this.started=true; this.__lang=this.lang; setTimeout(()=>this.onstart&&this.onstart(),0); }
    stop(){ this.started=false; setTimeout(()=>this.onend&&this.onend(),0); }
    abort(){ this.stop(); } }
  window.SpeechRecognition = FakeSR;
  window.__idx = 0; window.__results = [];
  window.__say = (text, isFinal) => { const r=[{transcript:text}]; r.isFinal=!!isFinal; const i=window.__results.length; 
     if(window.__pending!==undefined && !isFinal){ window.__results[window.__pending]=r; } else if(window.__pending!==undefined && isFinal){ window.__results[window.__pending]=r; window.__pending=undefined; } 
     else { window.__results.push(r); if(!isFinal) window.__pending=i; }
     const ri = isFinal && window.__pending===undefined ? window.__results.length-1 : (window.__results.length-1);
     window.__rec.onresult({resultIndex: ri, results: window.__results}); };
  window.__reset = () => { window.__results=[]; window.__pending=undefined; };
  // capture downloads
  window.__downloads = [];
  const oc = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { b.text().then(t => window.__downloads.push({type:b.type, text:t})); return oc(b); };
  HTMLAnchorElement.prototype.click = function(){ window.__lastDownload = this.download; };
  window.confirm = () => true;
})();`;

let id = 0;
function cdp(ws) {
  const pending = new Map(); const listeners = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } else listeners.forEach(f => f(d)); };
  return { send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }), on: f => listeners.push(f) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
function ok(c, msg) { if (c) { pass++; console.log('  ok   ' + msg); } else { fail++; fails.push(msg); console.log('  FAIL ' + msg); } }

(async () => {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'sawt-chrome-'));
  const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + udd, '--lang=en-US', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 60; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break; } catch (e) { await sleep(250); } }
  const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
  const c = cdp(ws);
  async function newPage(opts = {}) {
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => c.send(m, p, sessionId);
    await s('Page.enable'); await s('Runtime.enable'); await s('DOM.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: opts.w || 390, height: opts.h || 844, deviceScaleFactor: 2, mobile: true });
    if (opts.dark) await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: opts.fake === false ? `Object.defineProperty(window,'webkitSpeechRecognition',{value:undefined,configurable:true});Object.defineProperty(window,'SpeechRecognition',{value:undefined,configurable:true});` : FAKE_SR });
    if (opts.seed) await s('Page.addScriptToEvaluateOnNewDocument', { source: opts.seed });
    const errors = []; c.on(d => { if (d.sessionId === sessionId && d.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || d.params.exceptionDetails.text)); });
    const P = {
      s, errors, targetId,
      eval: async (expr) => { const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; },
      goto: async (u) => { await s('Page.navigate', { url: u }); await sleep(700); },
      click: async (sel) => { const ok = await P.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2];})()`); if (!ok) throw new Error('no element ' + sel);
        await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: ok[0], y: ok[1], button: 'left', clickCount: 1 }); await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ok[0], y: ok[1], button: 'left', clickCount: 1 }); await sleep(180); },
      type: async (sel, text) => { await P.click(sel); await P.eval(`document.querySelector(${JSON.stringify(sel)}).select&&document.querySelector(${JSON.stringify(sel)}).select()`); await s('Input.insertText', { text }); await sleep(120); },
      val: (sel) => P.eval(`document.querySelector(${JSON.stringify(sel)}).value`),
      txt: (sel) => P.eval(`document.querySelector(${JSON.stringify(sel)}).textContent`),
      shot: async (name) => { if (!SHOTS) return; const r = await s('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64')); },
      close: () => c.send('Target.closeTarget', { targetId })
    };
    return P;
  }

  // ---------- main flow ----------
  console.log('Main flow on ' + BASE);
  let p = await newPage();
  await p.goto(BASE); await p.eval(`localStorage.clear()`); await p.goto(BASE);
  ok(await p.eval(`document.documentElement.dir`) === 'ltr', 'English UI by default for en-US browser (ltr)');
  await p.click('#btnUiLang');
  ok(await p.eval(`document.documentElement.dir`) === 'rtl' && (await p.txt('#recLabel')).includes('ابدأ'), 'switch to Arabic: rtl + Arabic labels');
  await p.click('#btnUiLang');
  ok(await p.eval(`document.documentElement.dir`) === 'ltr', 'switch back to English');
  ok(await p.eval(`document.getElementById('banner').hidden`), 'no unsupported banner when recognition exists');

  // record in English with spoken punctuation
  await p.eval(`document.getElementById('selLang').value='en-US'; document.getElementById('selLang').dispatchEvent(new Event('change'))`);
  await p.click('#btnRec');
  ok(await p.eval(`document.getElementById('btnRec').getAttribute('aria-pressed')`) === 'true', 'record button toggles on');
  ok(await p.eval(`window.__rec.lang`) === 'en-US', 'recognizer uses chosen language');
  await p.eval(`window.__say('hello team', false)`);
  ok((await p.txt('#liveInterim')).includes('hello team'), 'interim text shown live');
  await p.eval(`window.__say('hello team comma this is a test period', true)`);
  await sleep(100);
  ok((await p.txt('#liveFinal')) === 'hello team, this is a test.', 'final text with spoken punctuation applied: ' + (await p.txt('#liveFinal')));
  await p.eval(`window.__say('second line new line third', true)`);
  // engine ends by itself (silence) -> must auto restart
  await p.eval(`window.__rec.started=false; window.__rec.onend()`); await sleep(100);
  ok(await p.eval(`window.__rec.started`) === true, 'auto-restarts after engine ends on silence');
  await p.shot('record-live');
  await p.click('#btnRec'); await sleep(2300);
  ok((await p.eval(`location.hash`)).startsWith('#/n/'), 'stop saves and opens editor');
  let ta = await p.val('#noteText');
  ok(ta === 'hello team, this is a test. second line\nthird', 'saved text correct: ' + JSON.stringify(ta));
  ok((await p.val('#noteTitle')) === 'hello team, this is a test', 'auto title from first sentence: ' + (await p.val('#noteTitle')));

  // edit
  await p.type('#noteTitle', 'Standup notes');
  await p.type('#noteText', 'The quick brown fox. The lazy dog.');
  await sleep(500);
  await p.eval(`document.getElementById('btnBack').click()`); await sleep(200);
  ok((await p.txt('#list')).includes('Standup notes'), 'edit saved and visible in list');
  await p.goto(BASE + '#notes');
  ok((await p.txt('#list')).includes('Standup notes'), 'persists across reload (localStorage)');
  ok((await p.txt('#tabCount')) === '1', 'tab badge shows count');

  // find & replace
  await p.click('#list .item');
  await p.eval(`document.querySelector('.fr').open=true`);
  await p.type('#frFind', 'the'); await p.type('#frRepl', 'a');
  await p.click('#frGo');
  ok((await p.val('#noteText')) === 'a quick brown fox. a lazy dog.', 'find and replace all, case-insensitive: ' + (await p.val('#noteText')));

  // append
  await p.click('#btnAppend');
  ok(await p.eval(`window.__rec.lang`) === 'en-US' && !(await p.eval(`document.getElementById('editLive').hidden`)), 'append recording starts');
  await p.eval(`window.__reset(); window.__say('and then it jumped', true)`);
  await p.click('#btnAppend'); await sleep(2300);
  ok((await p.val('#noteText')) === 'a quick brown fox. a lazy dog. and then it jumped', 'append adds recorded text to the end: ' + (await p.val('#noteText')));

  // exports
  for (const [k, re] of [['txt', /Standup notes\n\na quick/], ['md', /^\uFEFF?# Standup notes/m], ['srt', /-->/], ['json', /"app": "sawt"/]]) {
    await p.eval(`window.__downloads.length=0`);
    await p.click(`[data-exp=${k}]`); await sleep(300);
    const d = await p.eval(`window.__downloads[0] ? window.__downloads[0].text : ''`);
    const name = await p.eval(`window.__lastDownload`);
    ok(re.test(d) && name.endsWith('.' + k), `export .${k} produced expected content (${name})`);
  }
  await p.shot('editor');

  // pin
  await p.click('#btnPin');
  ok(await p.eval(`document.getElementById('btnPin').getAttribute('aria-pressed')`) === 'true', 'pin toggles');

  // second note by manual typing
  await p.goto(BASE + '#record');
  await p.click('#btnManual');
  await p.type('#noteText', 'Buy milk and eggs');
  await p.type('#noteTitle', 'Shopping');
  await sleep(500);
  await p.goto(BASE + '#notes');
  const first = await p.txt('#list li:first-child h3');
  ok(first.includes('Standup notes'), 'pinned note sorts first: ' + first);
  await p.type('#search', 'milk');
  ok((await p.eval(`document.querySelectorAll('#list .item').length`)) === 1 && await p.eval(`!!document.querySelector('#list mark')`), 'search filters and highlights');
  await p.type('#search', 'zzzz');
  ok(!(await p.eval(`document.getElementById('empty').hidden`)), 'no-results state shown');
  await p.type('#search', '');
  await p.eval(`document.getElementById('search').value=''; document.getElementById('search').dispatchEvent(new Event('input'))`);

  // delete + undo
  await p.click('#list li:last-child .item');
  await p.click('#btnDelete');
  ok((await p.eval(`document.querySelectorAll('#list .item').length`)) === 1, 'delete removes note');
  await p.click('#toastAct');
  ok((await p.eval(`document.querySelectorAll('#list .item').length`)) === 2, 'undo restores note');

  // import
  const sample = path.join(udd, 'in.json');
  fs.writeFileSync(sample, JSON.stringify({ notes: [{ id: 'imp1', title: 'Imported', text: 'from file', lang: 'en-US' }, { bogus: true }] }));
  await p.click('#btnSettings');
  const { root } = await p.s('DOM.getDocument');
  const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileImport' });
  await p.s('DOM.setFileInputFiles', { nodeId, files: [sample] }); await sleep(500);
  ok((await p.txt('#toastMsg')).includes('1') && (await p.txt('#toastMsg')).includes('1 skipped'), 'import reports 1 added and 1 skipped: ' + (await p.txt('#toastMsg')));
  await p.eval(`document.querySelector('#dlgSettings').close()`);
  await p.goto(BASE + '#notes');
  ok((await p.txt('#list')).includes('Imported'), 'imported note listed');

  // theme
  await p.click('#btnSettings'); await p.click('[data-theme=dark]');
  ok(await p.eval(`document.documentElement.dataset.theme`) === 'dark', 'dark theme applies');
  await p.click('[data-theme=light]'); await p.eval(`document.querySelector('#dlgSettings').close()`);

  // wipe
  await p.click('#btnSettings'); await p.click('#btnWipe');
  ok((await p.eval(`JSON.parse(localStorage.getItem('sawt.v1')).notes.length`)) === 0, 'wipe erases all notes');
  ok(p.errors.length === 0, 'no uncaught JS errors: ' + p.errors.join('|'));
  await p.close();

  // error handling: permission denied
  console.log('Error + edge cases');
  p = await newPage(); await p.goto(BASE); await p.eval('localStorage.clear()'); await p.goto(BASE);
  await p.click('#btnRec');
  await p.eval(`window.__rec.onerror({error:'not-allowed'}); window.__rec.started=false; window.__rec.onend()`); await sleep(200);
  ok((await p.txt('#status')).length > 5 && await p.eval(`document.getElementById('btnRec').getAttribute('aria-pressed')`) === 'false', 'mic permission denied: message shown and recording stops');
  await p.click('#btnRec'); await p.click('#btnRec'); await sleep(2300);
  ok(await p.eval(`document.getElementById('list').children.length`) === 0, 'empty recording is not saved');
  ok(p.errors.length === 0, 'no uncaught JS errors');
  await p.close();

  // unsupported browser
  p = await newPage({ fake: false }); await p.goto(BASE); await p.eval('localStorage.clear()'); await p.goto(BASE);
  ok(!(await p.eval(`document.getElementById('banner').hidden`)) && await p.eval(`document.getElementById('btnRec').disabled`), 'unsupported browser: honest banner + record disabled');
  await p.shot('unsupported');
  await p.click('#btnManual'); await p.type('#noteText', 'typed note works without speech');
  await sleep(500);
  ok((await p.eval(`JSON.parse(localStorage.getItem('sawt.v1')).notes[0].text`)).includes('typed note'), 'manual notes still work when unsupported');
  await p.close();

  // Arabic RTL visual state + screenshots with clean sample data
  if (SHOTS) {
    const now = Date.now();
    const seed = [
      { id: 's1', title: 'فكرة مشروع التخرج', lang: 'ar-EG', created: now - 3600e3, updated: now - 3600e3, duration: 74000, pinned: true, text: 'عايز أعمل تطبيق يساعد الطلبة ينظموا مذاكرتهم. الفكرة إن كل مادة ليها جدول ومراجعة أسبوعية، ويفكرني قبل الامتحان بيومين.', segments: [{ t: 0, text: 'عايز أعمل تطبيق يساعد الطلبة ينظموا مذاكرتهم.' }, { t: 9000, text: 'الفكرة إن كل مادة ليها جدول ومراجعة أسبوعية، ويفكرني قبل الامتحان بيومين.' }] },
      { id: 's2', title: 'Meeting recap with Sara', lang: 'en-US', created: now - 86400e3, updated: now - 86400e3, duration: 52000, text: 'Sara will send the design files by Thursday. We agreed to ship the first version next week, then collect feedback from five users.', segments: [] },
      { id: 's3', title: 'قائمة المشتريات', lang: 'ar-SA', created: now - 2 * 86400e3, updated: now - 2 * 86400e3, duration: 21000, text: 'لبن، بيض، خبز، وزيت زيتون.', segments: [] },
      { id: 's4', title: 'Reading list', lang: 'en-GB', created: now - 4 * 86400e3, updated: now - 4 * 86400e3, duration: 30000, text: 'Finish the chapter on memory, then start the one about attention.', segments: [] }
    ];
    const seedFor = (ui, dark) => `localStorage.setItem('sawt.v1', ${JSON.stringify(JSON.stringify({ notes: seed }))}); localStorage.setItem('sawt.settings', ${JSON.stringify(JSON.stringify({ theme: dark ? 'dark' : 'light', ui, lang: ui === 'ar' ? 'ar-EG' : 'en-US', cmds: true }))});`;
    for (const [name, ui, dark] of [['ar-notes', 'ar', false], ['en-notes-dark', 'en', true]]) {
      const q = await newPage({ dark, seed: seedFor(ui, dark) }); await q.goto(BASE + '#notes'); await sleep(300); await q.shot(name);
      if (ui === 'ar') { await q.click('#list .item'); await sleep(200); await q.shot('ar-editor'); }
      if (ui === 'en') { await q.click('#list li:nth-child(2) .item'); await sleep(200); await q.shot('en-editor-dark'); }
      await q.close();
    }
    const q = await newPage({ seed: seedFor('ar', false) }); await q.goto(BASE);
    await q.click('#btnRec');
    await q.eval(`window.__say('النهارده عندي اجتماع الساعة تلاتة نقطة', true); window.__say('لازم أجهز العرض التقديمي', false)`);
    await sleep(1200); await q.shot('ar-record'); await q.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('Failures:\n - ' + fails.join('\n - '));
  ws.close(); chrome.kill(); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
