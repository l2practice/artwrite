// node tests/grader.check.js — self-check for aw-grader.js: model skipping, bad key, network, fallback, parse
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'aw-grader.js'), 'utf8');
const GOOD = JSON.stringify({ scores:{TR:6,CC:6,LR:6,GRA:5}, gra_errors:[{wrong:'a',correct:'b'}] });
function run(handler, groqKey) {
  const calls = [];
  const win = { AW: { syncOverall:(t)=>t, wordCount:(t)=>t.split(/\s+/).length, toast(){}, groqKey:{ get:()=>groqKey||'' } } };
  const ctx = { window: win, document: { createElement:()=>({ set innerHTML(v){ this.textContent=v; } }) , getElementById:()=>null },
    AbortController, setTimeout:(f,ms)=>setTimeout(f, Math.min(ms,5)), clearTimeout, console,
    fetch: async (url, opt) => { calls.push(url); return handler(url, opt, calls.length); } };
  ctx.window.window = win; vm.createContext(ctx); vm.runInContext(src, ctx);
  return { grade: () => win.AW.grade({ writing:'one two three', question:'q', attempt:1, taskType:'task2' }, 'KEY'), calls };
}
const ok = (text) => ({ ok:true, status:200, json: async () => ({ candidates:[{ content:{ parts:[{ text }] } }] }) });
const bad = (status, message) => ({ ok:false, status, json: async () => ({ error:{ message } }) });
(async () => {
  // 503 on the first model → the second answers, no Groq
  let t = run((u, o, n) => n === 1 ? bad(503, 'overloaded') : ok(GOOD));
  let r = await t.grade(); assert.equal(r.overall, 6); assert.equal(t.calls.length, 2); assert(/flash-lite/.test(t.calls[1]));
  // 429 then empty then good
  t = run((u, o, n) => n === 1 ? bad(429, 'quota') : n === 2 ? ok('') : ok('```json\n' + GOOD + '\n```'));
  r = await t.grade(); assert.equal(t.calls.length, 3); assert.equal(r.scores.GRA, 5);
  // invalid key (400) → error at once, not the Groq popup
  t = run(() => bad(400, 'API key not valid. Please pass a valid API key.'));
  await assert.rejects(t.grade(), /API key/); assert.equal(t.calls.length, 1);
  // no network → error at once
  t = run(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(t.grade(), /network/); assert.equal(t.calls.length, 1);
  // all Gemini busy → Groq (stored key) answers
  t = run((u) => /groq/.test(u) ? { ok:true, status:200, json: async () => ({ choices:[{ message:{ content: GOOD } }] }) } : bad(503, 'x'), 'gsk_x');
  r = await t.grade(); assert.equal(t.calls.length, 4); assert.equal(r.overall, 6);
  // Gemini busy, Groq 429 → second Gemini pass succeeds
  t = run((u, o, n) => /groq/.test(u) ? bad(429, 'rate') : (n <= 3 ? bad(503, 'x') : ok(GOOD)), 'gsk_x');
  r = await t.grade(); assert.equal(r.overall, 6);
  // everything down → the "ngẽn" message
  t = run((u) => /groq/.test(u) ? bad(429, 'rate') : bad(503, 'x'), 'gsk_x');
  await assert.rejects(t.grade(), /ngẽn/);
  // request asks for JSON and enough room
  t = run((u, o) => { const c = JSON.parse(o.body).generationConfig; assert.equal(c.responseMimeType, 'application/json'); assert(c.maxOutputTokens >= 16000); return ok(GOOD); });
  await t.grade();
  console.log('grader self-check: all passed');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
