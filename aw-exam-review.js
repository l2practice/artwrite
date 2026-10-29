/* aw-exam-review.js — Test Simulation results (exam.html, student.html, teacher.html)

   A test is one saved attempt holding both parts. Its feedback JSON:
     { test:true, overall, t1, t2, scores:{TR,CC,LR,GRA}, noAI,
       task1:{ prompt, chart, essay, ...the grader's result for Part 1 },
       task2:{ prompt, essay, ...the grader's result for Part 2 },
       integrity:{ fsExits, tabSwitches, pasteBlocked, autoSubmitted } }

   AW.ieltsRound(x)              .25 → .5, .75 → next band (IELTS rounding)
   AW.examCombine(o1, o2)        Writing band: Part 2 counts twice as much as Part 1
   AW.testReviewHtml(fb, opts)   the whole review; opts.prefix keeps ids unique,
                                 opts.teacher adds the integrity line
   AW.testReviewLexis(fb, opts)  fills the vocabulary/collocation boxes afterwards */
(function (AW) {
  'use strict';

  AW.ieltsRound = function (x) {
    x = parseFloat(x);
    if (isNaN(x)) return '';
    var whole = Math.floor(x), frac = x - whole;
    return frac < 0.25 ? whole : (frac < 0.75 ? whole + 0.5 : whole + 1);
  };
  AW.examCombine = function (o1, o2) {
    var a = parseFloat(o1), b = parseFloat(o2);
    if (isNaN(a) && isNaN(b)) return '';
    return AW.ieltsRound(((isNaN(a) ? 0 : a) + 2 * (isNaN(b) ? 0 : b)) / 3);
  };

  function esc(s) { return AW.esc(s); }
  function band(v) { return (v === '' || v == null || isNaN(parseFloat(v))) ? '—' : String(v); }

  function bar(name, val) {
    var pct = val ? Math.min(100, (parseFloat(val) / 9) * 100) : 0;
    return '<div class="tsr-crit"><div><span>' + name + '</span><b>' + band(val) + '</b></div>' +
           '<i><em style="width:' + pct + '%"></em></i></div>';
  }
  function list(items) {
    if (!items) return '';
    if (typeof items === 'string') return esc(items);
    if (!Array.isArray(items)) return esc(items.message || items.text || JSON.stringify(items));
    return items.map(function (e) {
      return '• ' + esc(typeof e === 'string' ? e : (e.message || e.text || e.error || JSON.stringify(e)));
    }).join('<br>');
  }

  function part(n, t, opts) {
    t = t || {};
    var isT1 = n === 1, min = isT1 ? 150 : 250, s = t.scores || {};
    var wc = AW.wordCount(t.essay || ''), ok = wc >= min;
    var h = '<section class="tsr-part">' +
      '<header><span class="tsr-pn">Part ' + n + '</span>' +
        '<span class="tsr-pt">' + (isT1 ? 'Task 1 · report' : 'Task 2 · essay') + '</span>' +
        '<span class="tsr-pb">Band ' + band(t.overall) + '</span></header>';
    if (t.prompt || t.chart) {
      h += '<details class="tsr-q"' + (opts.openPrompt ? ' open' : '') + '><summary>Question</summary>' +
        '<div class="tsr-qt">' + esc(t.prompt || '') + '</div>' +
        (t.chart ? '<img src="' + esc(t.chart) + '" alt="Part 1 chart" loading="lazy">' : '') + '</details>';
    }
    if (t.overall !== undefined && t.overall !== '' && t.scores) {
      h += '<div class="tsr-crits">' + bar(isT1 ? 'Task Achievement' : 'Task Response', s.TR) +
        bar('Coherence &amp; Cohesion', s.CC) + bar('Lexical Resource', s.LR) + bar('Grammar', s.GRA) + '</div>';
    }
    if (t.empty) h += '<p class="tsr-warn">Không có bài làm cho phần này — Band 0.</p>';
    if (t.overall_feedback_vi) h += '<div class="tsr-blk"><h4>Overall assessment</h4><p>' + esc(AW.syncOverall(t.overall_feedback_vi, t.overall)) + '</p></div>';
    if (t.repeated_errors_vi) h += '<div class="tsr-blk tsr-amber"><h4>⚠ Repeated errors</h4><p>' + list(t.repeated_errors_vi) + '</p></div>';
    if ((t.tr_comments || []).length) h += '<div class="tsr-blk"><h4>' + (isT1 ? 'Task Achievement' : 'Task Response') + '</h4>' +
      t.tr_comments.slice(0, 5).map(function (c) {
        return '<p>' + (c.paragraph_role ? '<b>' + esc(c.paragraph_role) + ':</b> ' : '') + esc(c.assessment_vi || '') +
          (c.suggestion_en ? '<br><span class="tsr-sug">→ ' + esc(c.suggestion_en) + '</span>' : '') + '</p>';
      }).join('') + '</div>';
    if ((t.gra_errors || []).length) h += '<div class="tsr-blk"><h4>Grammar</h4>' + t.gra_errors.slice(0, 10).map(function (e) {
      return '<p><s>' + esc(e.wrong) + '</s> → <ins>' + esc(e.correct) + '</ins>' +
        (e.explanation_vi ? '<br><small>' + esc(e.explanation_vi) + '</small>' : '') + '</p>';
    }).join('') + '</div>';
    if ((t.lr_issues || []).length) h += '<div class="tsr-blk"><h4>Lexical Resource</h4>' + t.lr_issues.slice(0, 8).map(function (e) {
      return '<p><s>' + esc(e.original) + '</s> → <ins>' + esc(e.better) + '</ins>' +
        (e.explanation_vi ? '<br><small>' + esc(e.explanation_vi) + '</small>' : '') + '</p>';
    }).join('') + '</div>';
    if (t.cc_feedback && t.cc_feedback.assessment_vi) h += '<div class="tsr-blk"><h4>Coherence &amp; Cohesion</h4><p>' + esc(t.cc_feedback.assessment_vi) + '</p></div>';
    if (t.essay && AW.lexisBlock && !opts.noLexis)
      h += '<div class="tsr-blk"><h4>📚 Vocabulary level &amp; Collocations</h4><div id="' + opts.prefix + '_lx' + n + '"><span class="aw-spin aw-spin-dark"></span></div></div>';
    h += '<div class="tsr-blk"><h4>Answer <span class="tsr-wc ' + (ok ? 'ok' : wc >= min * 0.8 ? 'mid' : 'low') + '">' + wc + ' words</span>' +
      (ok ? '' : '<span class="tsr-min">minimum ' + min + '</span>') + '</h4>' +
      (t.essay ? '<div class="tsr-essay">' + esc(t.essay) + '</div>' : '<p class="tsr-dim">No answer.</p>') + '</div>';
    return h + '</section>';
  }

  AW.testReviewHtml = function (fb, opts) {
    opts = opts || {};
    opts.prefix = opts.prefix || 'tsr';
    fb = fb || {};
    var ig = fb.integrity || {};
    var head = '<div class="tsr-head">' +
      '<div class="tsr-ov"><b>' + band(fb.overall) + '</b><span>WRITING BAND</span></div>' +
      '<div class="tsr-sub"><div><span>Part 1</span><b>' + band(fb.t1) + '</b></div>' +
        '<div><span>Part 2</span><b>' + band(fb.t2) + '</b></div>' +
        '<p>Part 2 counts twice as much as Part 1.</p></div></div>';
    var note = '';
    if (fb.noAI) note = '<p class="tsr-note">Lớp của bạn không dùng AI chấm — giáo viên sẽ chấm bài này.</p>';
    if (opts.teacher) {
      var bits = [];
      if (ig.autoSubmitted) bits.push('submitted by the timer');
      bits.push('left full screen ' + (ig.fsExits || 0) + '×');
      bits.push('switched tab/window ' + (ig.tabSwitches || 0) + '×');
      if (ig.pasteBlocked) bits.push(ig.pasteBlocked + ' outside paste' + (ig.pasteBlocked > 1 ? 's' : '') + ' blocked');
      note += '<p class="tsr-integ' + ((ig.fsExits || ig.tabSwitches || ig.pasteBlocked) ? ' warn' : '') + '">' + esc(bits.join(' · ')) + '</p>';
    }
    return '<div class="tsr">' + head + note + part(1, fb.task1, opts) + part(2, fb.task2, opts) + '</div>';
  };

  AW.testReviewLexis = function (fb, opts) {
    opts = opts || {};
    var prefix = opts.prefix || 'tsr', alive = opts.alive || function () { return true; };
    if (!AW.lexisBlock || !fb) return;
    [[1, fb.task1], [2, fb.task2]].forEach(function (p) {
      var t = p[1] || {}, id = prefix + '_lx' + p[0];
      if (!t.essay) return;
      AW.lexisBlock(t.essay, { prompt: t.prompt || '', aiNote: t.lexis_vi }).then(function (h) {
        var el = document.getElementById(id);
        if (!el || !alive()) return;
        if (h) el.innerHTML = h; else el.parentNode.remove();
      });
    });
  };

  if (typeof document !== 'undefined' && !document.getElementById('tsr-style')) {
    var st = document.createElement('style'); st.id = 'tsr-style';
    st.textContent =
      '.tsr{color:var(--aw-ink)}' +
      '.tsr-head{display:flex;gap:16px;align-items:stretch;flex-wrap:wrap;margin-bottom:12px}' +
      '.tsr-ov{flex:0 0 112px;height:112px;border-radius:26px;background:linear-gradient(135deg,#5661E0,#7C84EE);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 10px 24px rgba(86,97,224,.28)}' +
      '.tsr-ov b{font-size:2.5rem;line-height:1;font-weight:800}.tsr-ov span{font-size:.58rem;letter-spacing:.12em;margin-top:6px;opacity:.9}' +
      '.tsr-sub{flex:1;min-width:200px;display:flex;flex-wrap:wrap;gap:10px;align-content:center}' +
      '.tsr-sub>div{flex:1;min-width:90px;background:var(--aw-surface-2);border-radius:16px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center}' +
      '.tsr-sub>div span{font-size:.8rem;color:var(--aw-ink-2);font-weight:600}.tsr-sub>div b{font-size:1.35rem;color:var(--aw-primary-hv)}' +
      '.tsr-sub p{flex:1 1 100%;margin:0;font-size:.76rem;color:var(--aw-ink-3)}' +
      '.tsr-note{margin:0 0 10px;padding:10px 12px;border-radius:12px;background:#FFF8EC;font-size:.85rem}' +
      '.tsr-integ{margin:0 0 10px;font-size:.8rem;color:var(--aw-ink-3)}.tsr-integ.warn{color:#9A3B0A;font-weight:600}' +
      '.tsr-part{margin-top:14px;border:1px solid var(--aw-border-2);border-radius:20px;padding:16px 18px}' +
      '.tsr-part>header{display:flex;align-items:center;gap:10px;margin-bottom:10px}' +
      '.tsr-pn{font-weight:800;font-size:1.02rem}.tsr-pt{font-size:.8rem;color:var(--aw-ink-3)}' +
      '.tsr-pb{margin-left:auto;background:var(--aw-primary-lt);color:var(--aw-primary-hv);font-weight:800;border-radius:999px;padding:4px 12px;font-size:.85rem}' +
      '.tsr-q{margin:0 0 12px;background:var(--aw-surface-2);border-radius:14px;padding:10px 14px}' +
      '.tsr-q summary{cursor:pointer;font-weight:700;font-size:.84rem;color:var(--aw-primary-hv)}' +
      '.tsr-qt{white-space:pre-wrap;font-size:.88rem;line-height:1.55;margin-top:8px}' +
      '.tsr-q img{display:block;max-width:100%;max-height:340px;margin-top:10px;border-radius:10px;background:#fff}' +
      '.tsr-crits{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 18px;margin-bottom:6px}' +
      '.tsr-crit{margin-bottom:8px}.tsr-crit>div{display:flex;justify-content:space-between;font-size:.84rem}' +
      '.tsr-crit i{display:block;height:6px;background:#E9EBFB;border-radius:4px;margin-top:3px}' +
      '.tsr-crit em{display:block;height:100%;background:linear-gradient(90deg,#5661E0,#7C84EE);border-radius:4px}' +
      '.tsr-blk{margin-top:12px;padding-top:12px;border-top:1px solid var(--aw-border-2)}' +
      '.tsr-blk .lx-h{display:none}' +
      '.tsr-blk h4{margin:0 0 6px;font-size:.88rem;color:var(--aw-primary-hv);display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.tsr-blk p{margin:0 0 6px;line-height:1.55;font-size:.88rem;color:var(--aw-ink-2)}' +
      '.tsr-blk s{color:#D2372F}.tsr-blk ins{color:#16825B;font-weight:600;text-decoration:none}.tsr-blk small{color:var(--aw-ink-3)}' +
      '.tsr-amber{background:#FFF8EC;border-radius:12px;padding:10px 12px;border-top:0}' +
      '.tsr-sug{font-size:.82rem;color:#16825B}' +
      '.tsr-wc{font-size:.72rem;font-weight:700;border-radius:999px;padding:2px 9px;border:1px solid}' +
      '.tsr-wc.ok{color:#16825B;background:#EAF6EF}.tsr-wc.mid{color:#B8860B;background:#FFF8EC}.tsr-wc.low{color:#D2372F;background:#FFF0F0}' +
      '.tsr-min{font-size:.72rem;color:var(--aw-ink-3);font-weight:500}' +
      '.tsr-essay{white-space:pre-wrap;font-size:.9rem;line-height:1.65;background:var(--aw-surface-2);border-radius:12px;padding:12px 14px}' +
      '.tsr-warn{background:#FFF0F0;color:#B42318;border-radius:12px;padding:8px 12px;font-size:.85rem}' +
      '.tsr-dim{color:var(--aw-ink-3)}';
    (document.head || document.documentElement).appendChild(st);
  }
})(window.AW = window.AW || {});
