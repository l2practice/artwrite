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
  return { grade: () => win.AW.grade({ writing:'one two three', question:'q', attempt:1, taskType:'task2' }, 'KEY'), gradeWith: (p) => win.AW.grade(p, 'KEY'), calls, win };
}
const ok = (text) => ({ ok:true, status:200, json: async () => ({ candidates:[{ content:{ parts:[{ text }] } }] }) });
const bad = (status, message) => ({ ok:false, status, json: async () => ({ error:{ message } }) });
(async () => {
  // 503 on the first model → the second answers, no Groq
  let t = run((u, o, n) => n === 1 ? bad(503, 'overloaded') : ok(GOOD));
  let r = await t.grade(); assert.equal(r.overall, 6); assert.equal(t.calls.length, 3); assert(/flash-lite/.test(t.calls[1]));   // step 1: 503 then flash-lite; step 2: first model
  // 429 then empty then good
  t = run((u, o, n) => n === 1 ? bad(429, 'quota') : n === 2 ? ok('') : ok('```json\n' + GOOD + '\n```'));
  r = await t.grade(); assert.equal(t.calls.length, 4); assert.equal(r.scores.GRA, 5);   // step 1 takes 3 calls, step 2 one
  // invalid key (400) → error at once, not the Groq popup
  t = run(() => bad(400, 'API key not valid. Please pass a valid API key.'));
  await assert.rejects(t.grade(), /API key/); assert.equal(t.calls.length, 1);
  // no network → error at once
  t = run(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(t.grade(), /network/); assert.equal(t.calls.length, 1);
  // all Gemini busy → Groq (stored key) answers
  t = run((u) => /groq/.test(u) ? { ok:true, status:200, json: async () => ({ choices:[{ message:{ content: GOOD } }] }) } : bad(503, 'x'), 'gsk_x');
  r = await t.grade(); assert.equal(t.calls.length, 20); assert.equal(r.overall, 6);   // each step: 3 sweeps x 3 busy Gemini models, then Groq
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
  assert.equal(fin.scores, null); assert.equal(fin.overall, 'Done');          // paragraph practice: comments only, no band
  assert.equal(fin.gra_errors.length, 1); assert.equal(fin.gra_errors[0].unlocated, false);   // the quote that is not in the text is dropped
  fin = await run(() => ok(JSON.stringify({ scores:{TR:7,CC:6,LR:6,GRA:5}, gra_errors:[], tr_comments:[{paragraph_role:'1a',quote:'This trend have more disadvantages.',assessment_vi:'Sai chia động từ.',suggestion_en:'This trend has more disadvantages.'},{paragraph_role:'1b',quote:'',assessment_vi:'x'}] }))).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  assert.equal(fin.overall, 'Done'); assert.equal(fin.scores, null);
  assert.equal(fin.tr_comments.length, 1); assert.equal(fin.tr_comments[0].paragraph_role, '1a');   // per-sentence comments kept, empty entry dropped
  fin = await run(() => ok(JSON.stringify({ scores:{TR:7,CC:6,LR:6,GRA:5} }))).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' });
  assert.equal(fin.overall, 6); assert.equal(fin.writing_type, 'full_essay');
  // the prompt names the format
  t = run((u, o) => { const txt = JSON.parse(o.body).contents[0].parts[0].text; assert(/SEPARATE practice sentences/.test(txt) && /at most ONE upgrade per sentence/.test(txt) && !/WORD COUNT: This response/.test(txt)); return ok(GOOD); });
  await t.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  assert.equal(t.calls.length, 1);   // sentence practice has no scoring step
  // mode-specific prompt: TR / CC rule blocks only for full essays; the always-kept parts survive
  const seen = {};
  for (const wt of ['full_essay','paragraph','sentences']) {
    await run((u, o) => { (seen[wt] = seen[wt] || []).push(JSON.parse(o.body).contents[0].parts[0].text); return ok(GOOD); }).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType: wt });
  }
  assert.equal(seen.full_essay.length, 2); assert.equal(seen.paragraph.length, 2); assert.equal(seen.sentences.length, 1);
  const B = (wt) => seen[wt][1];
  assert(/ONLY find the grammar errors/.test(seen.full_essay[0]) && !/ERROR REPORT \(step 1/.test(seen.full_essay[0]));   // step 1 sees no scoring rules
  assert(/ERROR REPORT \(step 1/.test(B('full_essay')) && /Grammar errors: 1/.test(B('full_essay')) && /Typing slips: 0/.test(B('full_essay')));
  assert(/2\) TASK RESPONSE/.test(B('full_essay')) && /3\) COHERENCE & COHESION:/.test(B('full_essay')));
  assert(!/2\) TASK RESPONSE/.test(B('paragraph')) && /3\) COHERENCE & COHESION:/.test(B('paragraph')));
  { const spec = B('full_essay').split('Return ONLY a JSON object')[1].split('OUTPUT BUDGET')[0]; assert(spec.length > 50 && !/gra_errors|lr_issues/.test(spec) && /lexis_vi/.test(spec)); }   // step 2 returns no error lists
  assert(/OFFICIAL IELTS BAND DESCRIPTORS/.test(B('full_essay')) && /BAND 7/.test(B('full_essay')) && /DESCRIPTOR RULE/.test(B('full_essay')) && !/__DESCRIPTORS__/.test(B('full_essay')));
  assert(/Task Response: /.test(B('full_essay')) && !/Task Response: /.test(B('paragraph').split('OFFICIAL IELTS BAND DESCRIPTORS')[1].split('DESCRIPTOR RULE')[0]));   // paragraph practice has no TR descriptors
  assert(B('paragraph').length < B('full_essay').length);
  // the same text twice: step 1 is reused (same error list, no second call)
  t = run(() => ok(GOOD));
  await t.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' }); assert.equal(t.calls.length, 2);
  await t.gradeWith({ writing: essay, question:'q', attempt:2, taskType:'task2' }); assert.equal(t.calls.length, 3);
  // typing slips are never listed; an item needs a real replacement; spacing-only items are dropped
  fin = await run(() => ok(JSON.stringify({ scores:{TR:6,CC:6,LR:6,GRA:6}, gra_errors:[
    {wrong:'trend have',correct:'trend has',type:'subject_verb_agreement'}, {wrong:'online meeting',correct:'online meetings',type:'spelling'},
    {wrong:'this trend',correct:'',type:'article'}, {wrong:'meetingshave',correct:'meetings have',type:'word_order'} ],
    lr_issues:[{original:'a lot of',better:'',type:'register'}] }))).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' });
  assert.equal(fin.gra_errors.length, 1); assert.equal(fin.lr_issues.length, 0);
  // garbled replies: a cut-off reply is repaired, a trailing comma is forgiven, a hopeless one is retried once
  const cut = '{"typo_count":1,"gra_errors":[{"wrong":"trend have","correct":"trend has","type":"verb_form","explanation_vi":"x"},{"wrong":"smartphones become","correct":"smartph';
  t = run((u, o, n) => n === 1 ? ok(cut) : ok(GOOD));
  fin = await t.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  assert.equal(t.calls.length, 1); assert.equal(fin.gra_errors.length, 1); assert.equal(fin.gra_errors[0].wrong, 'trend have');
  t = run((u, o, n) => ok(n === 1 ? 'no json here' : GOOD));
  fin = await t.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  assert.equal(t.calls.length, 2); assert.equal(fin.overall, 'Done');
  t = run(() => ok('{"scores":{"TR":6,"CC":6,"LR":6,"GRA":6,},"gra_errors":[],}'));
  fin = await t.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' }); assert.equal(fin.overall, 6);
  // all three models overloaded once, fine on the second sweep: the student never meets Groq or an error
  t = run((u, o, n) => n <= 3 ? bad(503, 'overloaded') : ok(GOOD));
  r = await t.grade(); assert.equal(r.overall, 6); assert.equal(t.calls.length, 5); assert(!t.calls.some(u => /groq/.test(u)));
  // the same wrong→correct pair in two places is two mistakes; a third copy is the AI repeating itself
  t = run(() => ok(JSON.stringify({ gra_errors:[{wrong:'which lead',correct:'which leads',type:'subject_verb_agreement'},{wrong:'which lead',correct:'which leads',type:'subject_verb_agreement'},{wrong:'which lead',correct:'which leads',type:'subject_verb_agreement'}] })));
  fin = await t.gradeWith({ writing: 'It rains, which lead to floods. It snows, which lead to cold.', question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  assert.equal(fin.gra_errors.length, 2);
  // sentences cut by the app: list labels, e.g., decimals and paragraphs
  {
    const probe = run(() => ok(GOOD));
    const sp = probe.win.AW.splitSentences('3. As cities grow, traffic rises (e.g., smog and noise). For example, jams get worse.\n\n4. Band 6.5 is common. Is it? Yes!');
    assert.deepEqual(sp.map(x => x.text), ['3. As cities grow, traffic rises (e.g., smog and noise).', 'For example, jams get worse.', '4. Band 6.5 is common.', 'Is it?', 'Yes!']);
    assert.deepEqual(sp.map(x => x.para), [0, 0, 1, 1, 1]);
  }
  // errors are tied to sentences (a wrong index is corrected); error-free share and types are measured
  t = run(() => ok(JSON.stringify({ gra_errors:[{sentenceIndex:0,wrong:'which lead',correct:'which leads',severity:'error',type:'subject_verb_agreement'},{sentenceIndex:1,wrong:'which lead',correct:'which leads',severity:'error',type:'subject_verb_agreement'},{sentenceIndex:2,wrong:'which lead',correct:'which leads',severity:'error',type:'subject_verb_agreement'}],
    sentences:[{index:0,type:'complex'},{index:1,type:'complex'},{index:2,type:'simple'},{index:3,type:'simple'},{index:3,type:'fragment'}] })));
  fin = await t.gradeWith({ writing: 'It rains, which lead to floods. It snows, which lead to cold. The end is near. All is fine.', question:'q', attempt:1, taskType:'task2', writingType:'sentences' });
  assert.deepEqual(fin.gra_errors.map(e => e.sentenceIndex), [0, 1]);           // the third copy and the wrong index 2 are dealt with
  assert.equal(fin.sentence_stats.total, 4); assert.equal(fin.sentence_stats.errorFree, 2);
  assert.equal(fin.sentence_stats.types.complex, 2); assert.equal(fin.sentence_stats.typed, 4); assert.equal(fin.sentences, undefined);
  // structured output: both steps carry a response schema (step 1: errors + sentences, step 2: scores)
  { const cfgs = [];
    await run((u, o) => { cfgs.push(JSON.parse(o.body).generationConfig); return ok(GOOD); }).gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' });
    assert.equal(cfgs.length, 2);
    assert(cfgs[0].responseSchema && cfgs[0].responseSchema.properties.gra_errors && cfgs[0].responseSchema.properties.sentences);
    assert(cfgs[1].responseSchema && cfgs[1].responseSchema.properties.scores && !cfgs[1].responseSchema.properties.gra_errors);
    assert.deepEqual(cfgs[0].responseSchema.properties.gra_errors.items.properties.severity.enum, ['error', 'upgrade']); }
  // a model that rejects the schema is asked again, in plain JSON mode, and the schema stays off afterwards
  { const sent = [];
    t = run((u, o) => { const c = JSON.parse(o.body).generationConfig; sent.push(!!c.responseSchema); return c.responseSchema ? bad(400, 'Invalid JSON payload received. Unknown name "responseSchema"') : ok(GOOD); });
    r = await t.gradeWith({ writing: essay, question:'q', attempt:1, taskType:'task2' });
    assert.equal(r.overall, 6); assert.deepEqual(sent, [true, false, false]); assert(!/groq/.test(t.calls.join(''))); }
  console.log('grader self-check: all passed');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
