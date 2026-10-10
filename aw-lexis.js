/*───────────────────────────────────────────────────────────────
  ArticuWrite — vocabulary level & collocation feedback (aw-lexis.js)

  Runs in the browser on top of aw-cefr.js and two data files in the
  repo, at no AI cost:
    collocations.json  headword → {c:[{e: collocation, v: Vietnamese}], …}
    ielts-vocab.json   IELTS word/phrase → {band, cefr, vi, use, topics,
                       writing_example, …}

  Exposes on window.AW:
    AW.lexisLoad()                 → Promise (fetches the data once)
    AW.lexisReady()                → true once the data is in memory
    AW.lexisAnalyse(text, opts)    → result object (call after lexisLoad)
    AW.lexisSummary(result)        → short English text for the grader
    AW.lexisHtml(result, aiNote)   → Vietnamese feedback block (HTML)
    AW.lexisBlock(text, opts)      → Promise<HTML> (load + analyse + html)
───────────────────────────────────────────────────────────────*/
(function (AW) {
  'use strict';

  var COLL = null, IELTS = null, _loading = null;

  AW.lexisLoad = function () {
    if (_loading) return _loading;
    function get(f) {
      return fetch(f, { cache: 'force-cache' }).then(function (r) { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); });
    }
    _loading = Promise.all([get('collocations.json'), get('ielts-vocab.json')])
      .then(function (d) { COLL = d[0] || {}; IELTS = d[1] || {}; return true; })
      .catch(function (e) { _loading = null; throw e; });
    return _loading;
  };
  AW.lexisReady = function () { return !!(COLL && IELTS); };

  var STOP = toSet('a an the and or but so of to in on at by for from with about into over after before than then that this these those it its is are was were be been being am do does did done have has had having will would can could should may might must shall not no yes as if when while which who whom whose what where why how all any each every some such very more most much many few less least own same other another there here their them they we our us you your he him his she her i me my mine one ones someone something sb sth');
  // regular forms are generated; these cover the common irregular verbs
  var IRREG = {
    be: ['is','are','was','were','been','being','am'], have: ['has','had','having'], do: ['does','did','done','doing'],
    make: ['made','making'], take: ['took','taken','taking'], give: ['gave','given','giving'], go: ['went','gone','goes','going'],
    get: ['got','gotten','getting'], pay: ['paid'], meet: ['met'], find: ['found'], run: ['ran','running'], bring: ['brought'],
    keep: ['kept'], hold: ['held'], lead: ['led'], spend: ['spent'], set: ['sets','setting'], put: ['puts','putting'],
    come: ['came'], see: ['saw','seen'], know: ['knew','known'], think: ['thought'], buy: ['bought'], build: ['built'],
    lose: ['lost'], leave: ['left'], feel: ['felt'], grow: ['grew','grown'], rise: ['rose','risen'], fall: ['fell','fallen'],
    draw: ['drew','drawn'], break: ['broke','broken'], choose: ['chose','chosen'], speak: ['spoke','spoken'], teach: ['taught'],
    catch: ['caught'], seek: ['sought'], win: ['won','winning'], begin: ['began','begun','beginning'], write: ['wrote','written'],
    drive: ['drove','driven'], bear: ['bore','borne'], deal: ['dealt'], mean: ['meant'], strike: ['struck'], sell: ['sold'], tell: ['told'],
    stand: ['stood'], understand: ['understood'], fight: ['fought'], hit: ['hits','hitting'], cut: ['cuts','cutting'], shut: ['shuts','shutting'],
    say: ['said'], lay: ['laid'], pose: ['posed','posing'], play: ['played','plays','playing']
  };
  // frequent basic words in IELTS essays → more precise options (checked against the CEFR list when shown)
  var UPGRADE = {
    good: ['beneficial', 'advantageous', 'favourable'], bad: ['detrimental', 'harmful', 'adverse'],
    big: ['substantial', 'considerable', 'significant'], small: ['minor', 'marginal', 'modest'],
    important: ['essential', 'vital', 'fundamental'], very: ['highly', 'extremely', 'remarkably'],
    many: ['numerous', 'a wide range of', 'countless'], 'a lot of': ['a great deal of', 'a large number of', 'considerable'],
    think: ['believe', 'argue', 'maintain'], get: ['obtain', 'acquire', 'gain'], show: ['demonstrate', 'illustrate', 'indicate'],
    help: ['assist', 'facilitate', 'support'], use: ['utilise', 'employ', 'make use of'], make: ['create', 'generate', 'produce'],
    give: ['provide', 'offer', 'grant'], need: ['require', 'demand', 'call for'], thing: ['aspect', 'factor', 'issue'],
    problem: ['issue', 'challenge', 'drawback'], people: ['individuals', 'citizens', 'the public'], change: ['transform', 'alter', 'shift'],
    increase: ['rise', 'surge', 'grow'], decrease: ['decline', 'drop', 'fall'], really: ['genuinely', 'truly'],
    easy: ['straightforward', 'effortless'], hard: ['challenging', 'demanding'], happy: ['content', 'satisfied'], start: ['initiate', 'launch'],
    try: ['attempt', 'strive', 'endeavour'], keep: ['maintain', 'retain', 'preserve'], stop: ['prevent', 'halt', 'curb'],
    find: ['discover', 'identify'], buy: ['purchase', 'acquire'], also: ['additionally', 'in addition'], so: ['therefore', 'consequently'],
    but: ['however', 'nevertheless'], nice: ['pleasant', 'appealing'], great: ['remarkable', 'outstanding'], job: ['occupation', 'profession', 'career']
  };
  var UPGRADE_MIN = { people: 4, also: 3, so: 3, but: 4, many: 3, very: 3, important: 3, think: 3, help: 3, get: 3, make: 3, use: 3,
                      give: 3, need: 3, show: 3, change: 3, keep: 3, start: 3, find: 3, job: 3 };

  // essay-structure words: their collocations ("draw a conclusion") are not useful advice
  var NO_SUGGEST = toSet('conclusion addition example instance hand fact firstly secondly nowadays today people thing way time year opinion view reason point');
  function toSet(s) { var o = {}; s.split(/\s+/).forEach(function (w) { if (w) o[w] = 1; }); return o; }
  function esc(s) { return AW.esc ? AW.esc(s) : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lemmaOf(w) { var c = AW.cefrOf ? AW.cefrOf(w) : null; return c ? c.lemma : w; }
  function levelOf(w) {
    if (!AW.cefrOf) return '';
    if (/\s/.test(w)) { // a phrase: its hardest listed word
      var best = 0, lv = ''; w.split(/\s+/).forEach(function (x) { var c = AW.cefrOf(x); if (c && c.levelNum > best) { best = c.levelNum; lv = c.level; } });
      return lv;
    }
    var c = AW.cefrOf(w); return c ? c.level : '';
  }

  // one word of a pattern → regex part that also matches its inflected forms
  function wordRe(w) {
    if (w === "one's" || w === "someone's" || w === "sb's") return "(?:my|your|his|her|its|our|their|one's|someone's|[a-z]+'s)";
    if (w === 'someone' || w === 'something' || w === 'sb' || w === 'sth') return "[a-z']+(?:\\s+[a-z']+)?";
    if (w === 'a' || w === 'an') return '(?:a|an)';
    var e = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), alt = [];
    if (IRREG[w]) alt = alt.concat(IRREG[w]);
    if (!/[a-z]$/.test(w) || w.length < 3) return '(?:' + [e].concat(alt).join('|') + ')';
    if (/e$/.test(w)) alt.push(e.slice(0, -1) + '(?:es|ed|ing)', e + 's', e + 'd');
    else if (/[^aeiou]y$/.test(w)) alt.push(e.slice(0, -1) + '(?:ies|ied)', e + 'ing');
    else {
      alt.push(e + '(?:s|es|ed|ing)');
      if (/[^aeiou][aeiou][bdgmnprt]$/.test(w)) alt.push(e + e.slice(-1) + '(?:ed|ing)');
    }
    return '(?:' + [e].concat(alt).join('|') + ')';
  }
  // a whole phrase; phrases of 3+ words let one extra word in between
  // ("have an impact on" ⇢ "has a significant impact on")
  function phraseRe(p) {
    var ws = p.toLowerCase().replace(/[^a-z' ]/g, ' ').trim().split(/\s+/);
    if (!ws.length || !ws[0]) return null;
    var gap = ws.length >= 3 ? "(?:\\s+[a-z'-]+)?\\s+" : '\\s+';
    return new RegExp("(?:^|[^a-z'])(" + ws.map(wordRe).join(gap) + ")(?=$|[^a-z'])", 'i');
  }
  function contentWords(p) { return p.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(function (w) { return w && !STOP[w]; }); }
  // a pattern with only one real word ("ability to", "impacted by") is grammar, not a collocation to praise
  function isRealCollocation(p) { return contentWords(p).length >= 2 || p.trim().split(/\s+/).length >= 3; }

  AW.lexisAnalyse = function (text, opts) {
    opts = opts || {};
    var src = String(text || ''), low = ' ' + src.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ') + ' ';
    var tokens = low.match(/[a-z][a-z'-]*/g) || [];
    var profile = AW.analyseVocabulary ? AW.analyseVocabulary(src) : null;

    // lemma counts of the essay
    var lemmaCount = {}, lemmaLevel = {};
    tokens.forEach(function (t) {
      var c = AW.cefrOf ? AW.cefrOf(t) : null, l = c ? c.lemma : t;
      lemmaCount[l] = (lemmaCount[l] || 0) + 1;
      if (c) lemmaLevel[l] = c;
    });

    // 1. collocations from collocations.json used in the essay
    var used = [], usedSeen = {}, headHit = {};
    Object.keys(lemmaCount).forEach(function (l) {
      var entry = COLL && COLL[l]; if (!entry) return;
      (entry.c || []).forEach(function (c) {
        if (!c || !c.e || usedSeen[c.e] || !isRealCollocation(c.e)) return;
        var re = phraseRe(c.e), m = re && low.match(re);
        if (m) { usedSeen[c.e] = 1; headHit[l] = 1; used.push({ head: l, phrase: c.e, vi: c.v || '', text: m[1] }); }
      });
    });

    // 2. IELTS words/phrases used (band 6.5–7.5+)
    var ielts = [], ieltsSeen = {};
    Object.keys(IELTS || {}).forEach(function (k) {
      var it = IELTS[k]; if (!it) return;
      var single = !/\s/.test(k.trim());
      if (single) {
        var l = lemmaOf(k.toLowerCase());
        if (!lemmaCount[l] && !lemmaCount[k.toLowerCase()]) return;
        var lv = (it.cefr || '').toUpperCase(); if (lv !== 'B2' && lv !== 'C1' && lv !== 'C2') return;
      } else {
        var re = phraseRe(k.replace(/^(a|an|the)\s+/i, '')); if (!re || !re.test(low)) return;
      }
      if (ieltsSeen[k]) return; ieltsSeen[k] = 1;
      ielts.push({ phrase: k, band: it.band || '', cefr: it.cefr || '', vi: it.vi || '' });
    });
    ielts.sort(function (a, b) { return String(b.band).localeCompare(String(a.band)) || (/\s/.test(b.phrase) - /\s/.test(a.phrase)); });

    // 3. basic words repeated → more precise options
    var basic = [];
    Object.keys(UPGRADE).forEach(function (w) {
      var n = / /.test(w) ? (low.match(new RegExp('[^a-z]' + w + '[^a-z]', 'g')) || []).length : (lemmaCount[w] || 0);
      if (n < (UPGRADE_MIN[w] || 2)) return;
      var options = UPGRADE[w].map(function (o) { return { w: o, level: /\s/.test(o) ? '' : levelOf(o) }; })
        .filter(function (o) { return /\s/.test(o.w) || !o.level || o.level >= 'B1'; });
      if (options.length) basic.push({ word: w, count: n, options: options });
    });
    basic.sort(function (a, b) { return b.count - a.count; });

    // words of the essay and of the task prompt (the prompt names the topic, so it weighs more)
    var ctx = {}, ctxPrompt = {};
    function addCtx(set, txt) { (String(txt || '').toLowerCase().match(/[a-z][a-z'-]*/g) || []).forEach(function (t) {
      if (!STOP[t] && t.length > 3) { set[t] = 1; set[lemmaOf(t)] = 1; } }); }
    addCtx(ctx, src); addCtx(ctx, opts.prompt); addCtx(ctxPrompt, opts.prompt);

    // 4. words the student used that have a well-known collocation they did not use
    //    (a word already inside a collocation or IELTS phrase they used is covered)
    used.forEach(function (c) { contentWords(c.text).forEach(function (w) { headHit[lemmaOf(w)] = 1; }); });
    ielts.forEach(function (x) { contentWords(x.phrase).forEach(function (w) { headHit[lemmaOf(w)] = 1; }); });
    var suggest = [];
    Object.keys(lemmaCount).filter(function (l) {
      var c = lemmaLevel[l]; return COLL && COLL[l] && !headHit[l] && !STOP[l] && !NO_SUGGEST[l] && l.length > 3 && c && /[nvj]/.test(c.pos || 'n') && c.levelNum >= 2;
    }).sort(function (a, b) { return (lemmaCount[b] - lemmaCount[a]) || (lemmaLevel[b].levelNum - lemmaLevel[a].levelNum); })
      .forEach(function (l) {
        if (suggest.length >= 6) return;
        // the most useful options first: words that fit this essay, general academic words; no chatty "leave me alone"
        var items = (COLL[l].c || []).filter(function (c) { return c && c.e && isRealCollocation(c.e) && !/\b(me|you|my|your|it)\b/i.test(c.e); })
          .map(function (c, i) {
            var other = contentWords(c.e).filter(function (w) { return lemmaOf(w) !== l; }), sc = 0;
            other.forEach(function (w) { if (ctx[w] || ctx[lemmaOf(w)]) sc += 3; var lv = AW.cefrOf && AW.cefrOf(w); if (lv && lv.levelNum >= 3) sc += 1; });
            return { c: c, sc: sc - i * 0.1 };
          }).sort(function (a, b) { return b.sc - a.sc; }).slice(0, 3).map(function (x) { return x.c; });
        if (items.length >= 2) suggest.push({ word: l, count: lemmaCount[l], level: lemmaLevel[l].level, items: items, example: COLL[l].e || '', exampleVi: COLL[l].v || '' });
      });

    // 5. the essay's topic → IELTS phrases of that topic the student could use
    var topicScore = {};
    var entryHits = {};
    Object.keys(IELTS || {}).forEach(function (k) {
      var it = IELTS[k]; if (!it || !it.topics) return;
      var ws = {}; contentWords(k + ' ' + (it.collocations || []).join(' ')).forEach(function (w) { if (w.length > 3) ws[lemmaOf(w)] = 1; });
      var hit = Object.keys(ws).reduce(function (n, w) { return n + (ctxPrompt[w] ? 3 : ctx[w] ? 1 : 0); }, 0);
      entryHits[k] = hit;
      if (hit) it.topics.forEach(function (tp) { if (!/Speaking Parts/.test(tp)) topicScore[tp] = (topicScore[tp] || 0) + hit; });
    });
    var ranked = Object.keys(topicScore).sort(function (a, b) { return topicScore[b] - topicScore[a]; });
    var topic = ranked[0] || '', topicPhrases = [];
    // only when the topic is clear: a real score and well ahead of the runner-up
    if (topic && topicScore[topic] >= 5 && topicScore[topic] >= 1.4 * (topicScore[ranked[1]] || 0)) {
      Object.keys(IELTS).filter(function (k) {
        var it = IELTS[k]; return it.topics && it.topics.indexOf(topic) >= 0 && it.use !== 'speaking' && !ieltsSeen[k];
      }).sort(function (a, b) {
        return (entryHits[b] - entryHits[a]) || String(IELTS[b].band).localeCompare(String(IELTS[a].band)) || (/\s/.test(b) - /\s/.test(a));
      }).slice(0, 4).forEach(function (k) {
        var it = IELTS[k]; topicPhrases.push({ phrase: k, band: it.band || '', cefr: it.cefr || '', vi: it.vi || '', example: it.writing_example || '', tip: it.tip || '' });
      });
    } else topic = '';

    return { profile: profile, collocations: used, ielts: ielts.slice(0, 12), basic: basic.slice(0, 6), suggest: suggest,
             topic: topic, topicPhrases: topicPhrases, words: tokens.length };
  };

  /* Short English text for the grader, next to AW.cefrSummary. */
  AW.lexisSummary = function (r) {
    if (!r) return '';
    var out = [];
    out.push('Dictionary-matched collocations used (' + r.collocations.length + '): ' +
      (r.collocations.length ? r.collocations.slice(0, 10).map(function (c) { return '"' + c.text + '"'; }).join(', ') : 'none') + '.');
    if (r.ielts.length) out.push('IELTS band 6.5+ vocabulary used: ' + r.ielts.slice(0, 8).map(function (x) { return x.phrase + ' (' + x.cefr + ')'; }).join(', ') + '.');
    if (r.basic.length) out.push('Basic words repeated: ' + r.basic.map(function (b) { return b.word + ' x' + b.count; }).join(', ') + '.');
    if (r.suggest.length) out.push('Content words used without a typical collocation: ' + r.suggest.map(function (s) { return s.word; }).join(', ') + '.');
    out.push('Use these measurements as evidence when you write "lexis_vi" and the Lexical Resource feedback; verify each item against the essay yourself.');
    return out.join(' ');
  };

  var LV_COL = { A1: '#888', A2: '#16825B', B1: '#5661E0', B2: '#B7791F', C1: '#E8730C', C2: '#D93025' };
  function lvTag(lv) { return lv ? '<span class="lx-lv" style="color:' + (LV_COL[lv] || '#667') + ';border-color:' + (LV_COL[lv] || '#667') + '55">' + lv + '</span>' : ''; }

  function levelComment(p) {
    if (!p || !p.totalWords) return '';
    var up = p.pctUpperMid || 0, adv = p.pctAdvanced || 0, msg;
    if (up < 8) msg = 'Từ vựng của bài phần lớn ở mức A1–B1 (chỉ ' + up + '% từ ở mức B2 trở lên). Bài đọc dễ hiểu nhưng còn đơn giản: hãy thay dần các từ cơ bản lặp lại bằng từ B2–C1 đúng ngữ cảnh và dùng collocation tự nhiên (xem gợi ý bên dưới).';
    else if (up < 15) msg = 'Bài đã có một số từ ở mức B2 trở lên (' + up + '%, trong đó C1–C2: ' + adv + '%). Để nâng điểm Lexical Resource, hãy dùng thêm từ chính xác hơn cho các ý chính và kết hợp chúng thành collocation, thay vì chỉ thêm từ khó đơn lẻ.';
    else if (up < 22) msg = 'Mật độ từ vựng B2 trở lên khá tốt (' + up + '%, C1–C2: ' + adv + '%). Điều quan trọng lúc này là độ chính xác: từ nâng cao phải đi đúng collocation và đúng sắc thái, nếu không sẽ bị trừ điểm.';
    else msg = 'Bài dùng nhiều từ vựng nâng cao (' + up + '% từ ở mức B2 trở lên, C1–C2: ' + adv + '%). Hãy chắc chắn mỗi từ khó đều dùng đúng nghĩa và đúng collocation — từ khó dùng sai bị trừ điểm nặng hơn từ đơn giản dùng đúng.';
    if (p.diversity && p.diversity < 40) msg += ' Độ đa dạng từ vựng còn thấp (' + p.diversity + '%): một số từ bị lặp lại nhiều lần.';
    return msg;
  }

  AW.lexisHtml = function (r, aiNote) {
    if (!r) return '';
    var h = '<div class="lx">';
    h += '<h4 class="lx-h">📚 Vocabulary level &amp; Collocations</h4>';
    if (aiNote) h += '<p class="lx-ai">' + esc(aiNote) + '</p>';
    var lc = levelComment(r.profile);
    if (lc) h += '<p class="lx-p">' + esc(lc) + '</p>';

    if (r.collocations.length) {
      h += '<div class="lx-sec"><b>✅ Collocation bạn đã dùng (' + r.collocations.length + ')</b><div class="lx-chips">' +
        r.collocations.slice(0, 12).map(function (c) { return '<span class="lx-chip lx-ok" title="' + esc(c.vi) + '">' + esc(c.text) + '</span>'; }).join('') + '</div></div>';
    } else {
      h += '<div class="lx-sec"><b>⚠ Chưa nhận diện được collocation quen thuộc nào.</b> <span class="lx-note">Giám khảo IELTS chấm Lexical Resource dựa nhiều vào việc kết hợp từ tự nhiên (vd. <i>have a significant impact on</i>, <i>pose a threat to</i>), không chỉ từ khó đơn lẻ.</span></div>';
    }
    if (r.ielts.length) {
      h += '<div class="lx-sec"><b>⭐ Từ/cụm từ IELTS band 6.5+ bạn đã dùng</b><div class="lx-chips">' +
        r.ielts.map(function (x) { return '<span class="lx-chip" title="' + esc(x.vi) + '">' + esc(x.phrase) + ' ' + lvTag((x.cefr || '').toUpperCase()) + '</span>'; }).join('') + '</div></div>';
    }
    if (r.basic.length) {
      h += '<div class="lx-sec"><b>🔁 Từ cơ bản lặp lại — thử thay bằng</b><ul class="lx-list">' +
        r.basic.map(function (b) {
          return '<li><span class="lx-base">' + esc(b.word) + '</span> <span class="lx-note">×' + b.count + '</span> → ' +
            b.options.map(function (o) { return '<span class="lx-up">' + esc(o.w) + '</span>' + lvTag(o.level); }).join(', ') + '</li>';
        }).join('') + '</ul><div class="lx-note">Chỉ thay khi từ mới đúng nghĩa trong câu — không thay máy móc tất cả.</div></div>';
    }
    if (r.suggest.length) {
      h += '<div class="lx-sec"><b>💡 Collocation cho những từ bạn đã dùng</b><ul class="lx-list">' +
        r.suggest.map(function (s) {
          return '<li><span class="lx-base">' + esc(s.word) + '</span>' + lvTag(s.level) + ' → ' +
            s.items.map(function (c) { return '<span class="lx-up">' + esc(c.e) + '</span> <span class="lx-note">(' + esc(c.v || '') + ')</span>'; }).join('; ') + '</li>';
        }).join('') + '</ul></div>';
    }
    if (r.topicPhrases.length) {
      h += '<div class="lx-sec"><b>📌 Cụm từ chủ đề “' + esc(r.topic) + '” nên dùng</b><ul class="lx-list">' +
        r.topicPhrases.map(function (t) {
          return '<li><span class="lx-up">' + esc(t.phrase) + '</span>' + lvTag((t.cefr || '').toUpperCase()) +
            (t.band ? '<span class="lx-band">band ' + esc(t.band) + '</span>' : '') + ' — ' + esc(t.vi) +
            (t.example ? '<div class="lx-ex">“' + esc(t.example) + '”</div>' : '') + '</li>';
        }).join('') + '</ul></div>';
    }
    h += '<div class="lx-note" style="margin-top:8px">Phân tích tự động theo từ điển CEFR và collocation của lớp — dùng để tham khảo cùng nhận xét của AI và giáo viên.</div>';
    return h + '</div>';
  };

  AW.lexisBlock = function (text, opts) {
    if (!text || !String(text).trim()) return Promise.resolve('');
    return AW.lexisLoad().then(function () {
      return AW.lexisHtml(AW.lexisAnalyse(text, opts), opts && opts.aiNote);
    }).catch(function (e) { console.warn('[lexis]', e); return ''; });
  };

  // shared look, injected once so every page that loads this file has it
  if (typeof document !== 'undefined' && !document.getElementById('lx-style')) {
    var st = document.createElement('style'); st.id = 'lx-style';
    st.textContent =
      '.lx{font-size:.88rem;line-height:1.55;color:var(--aw-ink,#1E2142)}' +
      '.lx-h{margin:0 0 8px;color:var(--aw-primary,#5661E0);font-size:.95rem}' +
      '.lx-ai{margin:0 0 8px;padding:10px 12px;border-radius:12px;background:var(--aw-surface-2,#F3F4FE)}' +
      '.lx-p{margin:0 0 10px}' +
      '.lx-sec{margin:10px 0 0}.lx-sec>b{display:block;margin-bottom:5px;font-size:.84rem}' +
      '.lx-chips{display:flex;flex-wrap:wrap;gap:6px}' +
      '.lx-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;background:var(--aw-surface-2,#F3F4FE);font-size:.8rem;cursor:help}' +
      '.lx-chip.lx-ok{background:#EAF6EF;color:#14633F}' +
      '.lx-lv{display:inline-block;margin-left:4px;padding:0 5px;border:1px solid;border-radius:6px;font-size:.66rem;font-weight:700;line-height:1.5;vertical-align:1px}' +
      '.lx-band{margin-left:4px;font-size:.7rem;color:var(--aw-ink-3,#5F6485)}' +
      '.lx-list{margin:0;padding-left:18px}.lx-list li{margin:3px 0}' +
      '.lx-base{font-weight:700}.lx-up{font-weight:600;color:#14633F}' +
      '.lx-note{font-size:.76rem;color:var(--aw-ink-3,#5F6485)}' +
      '.lx-ex{font-size:.78rem;color:var(--aw-ink-2,#3D4266);font-style:italic;margin-top:1px}';
    (document.head || document.documentElement).appendChild(st);
  }
})(window.AW = window.AW || {});
