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
  return { grade: () => win.AW.grade({ writing:'one two three', question:'q', attempt:1, taskType:'task2' }, 'KEY'), gradeWith: (p) => win.AW.grade(p, 'KEY'), calls };
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
  // task formats + post-processing: paragraph drops TR, sentences get no score, duplicates go, quotes are checked
  const essay = 'This trend have more disadvantages. In recent years smartphones become popular.';
  t = run(() => ok(JSON.stringify({ scores:{TR:7,CC:6,LR:6,GRA:5},
    gra_errors:[{wrong:'trend have',correct:'trend has'},{wrong:'trend  have',correct:'trend has'},{wrong:'not in text',correct:'x'}], lr_issues:[] })));
  let fin = await (async () => { const g = run(() => ok(JSON.stringify({ scores:{TR:7,CC:6,LR:6,GRA:5}, gra_errors:[{wrong:'trend have',correct:'trend has'},{wrong:'Trend  have',correct:'trend has'},{wrong:'not in text',correct:'x'}] })));
    return g.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType:'paragraph' }); })();
  assert.equal(fin.scores.TR, undefined); assert.equal(fin.overall, 5.5);          // (6+6+5)/3 = 5.67 → 5.5
  assert.equal(fin.gra_errors.length, 2); assert.equal(fin.gra_errors[0].unlocated, false); assert.equal(fin.gra_errors[1].unlocated, true);
  fin = await run(() => ok(JSON.stringify({ scores:{TR:7,CC:6,LR:6,GRA:5}, gra_errors:[] }))).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  assert.equal(fin.overall, 'Done'); assert.equal(fin.scores, null);
  fin = await run(() => ok(JSON.stringify({ scores:{TR:7,CC:6,LR:6,GRA:5} }))).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' });
  assert.equal(fin.overall, 6); assert.equal(fin.writing_type, 'full_essay');
  // the prompt names the format
  t = run((u, o) => { const txt = JSON.parse(o.body).contents[0].parts[0].text; assert(/SENTENCE PRACTICE/.test(txt) && !/WORD COUNT: This response/.test(txt)); return ok(GOOD); });
  await t.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  // mode-specific prompt: TR / CC rule blocks only for full essays; the always-kept parts survive
  const seen = {};
  for (const wt of ['full_essay','paragraph','sentences']) {
    await run((u, o) => { seen[wt] = JSON.parse(o.body).contents[0].parts[0].text; return ok(GOOD); }).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType: wt });
  }
  assert(/2\) TASK RESPONSE/.test(seen.full_essay) && /3\) COHERENCE & COHESION:/.test(seen.full_essay));
  assert(!/2\) TASK RESPONSE/.test(seen.paragraph) && /3\) COHERENCE & COHESION:/.test(seen.paragraph));
  assert(!/2\) TASK RESPONSE/.test(seen.sentences) && !/3\) COHERENCE & COHESION:/.test(seen.sentences));
  assert(/ANTI-OVER-CORRECTION/.test(seen.sentences) && /1\) LEXICAL RESOURCE & GRAMMAR/.test(seen.sentences) && /OUTPUT BUDGET/.test(seen.sentences));
  assert(seen.sentences.length < seen.paragraph.length && seen.paragraph.length < seen.full_essay.length);
  // typing slips are never listed; an item needs a real replacement; spacing-only items are dropped
  fin = await run(() => ok(JSON.stringify({ scores:{TR:6,CC:6,LR:6,GRA:6}, gra_errors:[
    {wrong:'trend have',correct:'trend has',type:'subject_verb_agreement'}, {wrong:'online meeting',correct:'online meetings',type:'spelling'},
    {wrong:'this trend',correct:'',type:'article'}, {wrong:'meetingshave',correct:'meetings have',type:'word_order'} ],
    lr_issues:[{original:'a lot of',better:'',type:'register'}] }))).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' });
  assert.equal(fin.gra_errors.length, 1); assert.equal(fin.lr_issues.length, 0);
  console.log('grader self-check: all passed');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
