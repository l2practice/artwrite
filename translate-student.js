/*
 * ArticuWrite — Translate Practice (student)
 * Add to student.html: <script src="translate-student.js"></script>
 * Requires: AW (aw-common.js), AW.geminiKey, sess, showOverlay/hideOverlay
 * In switchTab/routing: add case for id==="translate" → renderTranslateList()
 */

/* ── Translate (Luyện Dịch) ──────────────────────────────────────── */

var _trSet = null;        // current set data (with items)
var _trProgress = null;   // {clearedItemIds, runs, bestScore, nextRunIndex}
var _trBatch = [];        // current 7-item batch
var _trBatchResults = []; // scored items this run
var _trBatchIdx = 0;      // which item in batch we're on
var _trRunStart = 0;      // epoch ms at start of run (for duration)

function fmtTrTime(str){
  if(!str) return '—';
  var d = new Date(str);
  if(isNaN(d)) return str;
  return d.toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}

/* ── List screen ── */
function renderTranslateList(){
  var c = document.getElementById('vmContent');
  showOverlay('Đang tải…');
  AW.api('translate.forStudent', { classId: sess.class || '' }).then(function(res){
    hideOverlay();
    var sets = (res && res.success) ? res.data : [];
    if(!sets.length){
      c.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--aw-ink-3)">'+
        '<div style="font-size:2rem;margin-bottom:10px">🔄</div>'+
        '<p style="font-size:.92rem">Chưa có bài Luyện Dịch. Giáo viên sẽ tạo bài cho lớp.</p></div>';
      return;
    }
    c.innerHTML = '<div class="aw-card-grid">'+sets.map(function(s){
      var st = s.sessionStatus;
      var statusBadge, btnLabel, btnDis = false;
      if(st==='upcoming'){
        statusBadge='<span style="color:#A66B00;font-weight:700;font-size:.75rem">⏳ Chưa mở</span>';
        btnLabel='Chưa mở'; btnDis=true;
      } else if(st==='closed'){
        statusBadge='<span style="color:var(--aw-ink-3);font-weight:700;font-size:.75rem">✓ Đã đóng</span>';
        btnLabel='Xem kết quả';
      } else {
        statusBadge='<span style="color:var(--aw-writing);font-weight:700;font-size:.75rem">● Đang mở</span>';
        btnLabel='Bắt đầu →';
      }
      return '<div class="aw-assign-card" data-tr-sid="'+AW.esc(s.setId)+'" data-tr-status="'+AW.esc(st)+'">'+
        '<div style="font-weight:700;font-size:.95rem;margin-bottom:6px">🔄 '+AW.esc(s.title)+'</div>'+
        statusBadge+
        '<div style="font-size:.76rem;color:var(--aw-ink-2);margin:6px 0">'+
          '🎯 Pass: <b>'+s.passScore+'%</b> · 📅 '+fmtTrTime(s.sessionStart)+
          (s.deadline?'<br>⏰ Deadline: '+fmtTrTime(s.deadline):'')+
        '</div>'+
        '<button class="aw-btn '+(btnDis?'aw-btn-ghost':'aw-btn-primary')+' aw-btn-block" '+
          (btnDis?'disabled style="opacity:.5;cursor:not-allowed"':'')+
          ' style="padding:10px;font-size:.88rem;margin-top:8px">'+btnLabel+'</button>'+
      '</div>';
    }).join('')+'</div>';

    AW.els('[data-tr-sid]').forEach(function(card){
      card.onclick = function(e){
        if(e.target.tagName==='BUTTON'&&e.target.disabled) return;
        var sid = card.getAttribute('data-tr-sid');
        var st2 = card.getAttribute('data-tr-status');
        var s = sets.find(function(x){ return x.setId===sid; });
        if(!s) return;
        if(st2==='upcoming'){ AW.toast('Chưa đến giờ làm bài.','warn'); return; }
        openTrSet(sid, s, st2);
      };
    });
  }).catch(function(){ hideOverlay(); AW.toast('Lỗi kết nối.','err'); });
}

/* ── Open set ── */
function openTrSet(setId, preview, status){
  showOverlay('Đang tải bài…');
  AW.api('translate.get',{setId:setId}).then(function(r1){
    AW.api('translate.myProgress',{setId:setId,studentId:sess.studentId}).then(function(r2){
      hideOverlay();
      _trSet = r1.data;
      _trProgress = r2.success ? r2.data : {runs:0,clearedItemIds:[],bestScore:0,nextRunIndex:1};
      renderTrIntro(status);
    }).catch(function(){ hideOverlay(); AW.toast('Lỗi tải tiến độ.','err'); });
  }).catch(function(){ hideOverlay(); AW.toast('Lỗi tải bài dịch.','err'); });
}

/* ── Intro screen ── */
function renderTrIntro(status){
  var c = document.getElementById('vmContent');
  var cleared = _trProgress.clearedItemIds.length;
  var total   = (_trSet.items||[]).length;
  var pct     = total ? Math.round(cleared/total*100) : 0;
  var isClosed = (status || _trSet.sessionStatus) === 'closed';

  c.innerHTML =
    '<button class="aw-btn aw-btn-ghost" id="trBack" style="margin-bottom:14px;padding:6px 14px">← Danh sách</button>'+
    '<div style="max-width:520px;margin:0 auto;background:var(--aw-surface);border:1px solid var(--aw-border-2);'+
      'border-radius:var(--aw-r);padding:26px 28px">'+
      '<h3 style="font-family:var(--aw-font-display);font-size:1.1rem;margin:0 0 10px">🔄 '+AW.esc(_trSet.title)+'</h3>'+
      (isClosed ?
        '<div style="background:#FFF3CD;border:1px solid #F0D060;border-radius:8px;padding:8px 12px;'+
          'font-size:.82rem;color:#7A5000;margin:10px 0 14px">⏰ Bài này đã đóng. Bạn có thể xem lại kết quả.</div>'
        : '<ul style="font-size:.88rem;color:var(--aw-ink-2);line-height:1.8;padding-left:18px;margin:10px 0 14px">'+
          '<li>Mỗi lượt dịch <b>7 câu</b> xen kẽ EN↔VI</li>'+
          '<li>Đạt ≥ <b>'+_trSet.passScore+'%</b> mới mở lượt tiếp</li>'+
          '<li>AI chấm theo ý nghĩa — không cần dịch y chang</li>'+
          '<li>Câu 💎 là "báu vật" — học kỹ pattern!</li>'+
        '</ul>')+
      '<div style="margin-bottom:16px">'+
        '<div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:4px">'+
          '<span style="color:var(--aw-ink-2)">Tiến độ</span><b>'+cleared+'/'+total+' câu clear</b>'+
        '</div>'+
        '<div style="height:8px;background:var(--aw-border-2);border-radius:4px">'+
          '<div style="width:'+pct+'%;height:100%;background:var(--aw-writing);border-radius:4px;transition:width .4s"></div>'+
        '</div>'+
      '</div>'+
      (cleared>=total&&!isClosed ? '<div style="color:var(--aw-writing);font-weight:700;margin-bottom:12px">🎉 Bạn đã hoàn thành tất cả câu!</div>' : '')+
      '<div style="display:flex;gap:10px;flex-wrap:wrap">'+
        (!isClosed ?
          '<button class="aw-btn aw-btn-primary" id="trStartRun" style="padding:11px 28px">'+
            (cleared>=total ? 'Làm lại từ đầu' : 'Bắt đầu lượt '+(_trProgress.nextRunIndex||1))+
          '</button>' : '')+
        (_trProgress.runs>0 ?
          '<button class="aw-btn aw-btn-ghost" id="trViewHistory" style="padding:11px 18px">Xem lịch sử</button>' : '')+
      '</div>'+
    '</div>';

  document.getElementById('trBack').onclick = function(){ renderTranslateList(); };
  var startBtn = document.getElementById('trStartRun');
  if(startBtn) startBtn.onclick = function(){ startTrRun(); };
  var histBtn = document.getElementById('trViewHistory');
  if(histBtn) histBtn.onclick = function(){ renderTrHistory(); };
}

/* ── Batch picker ── */
function pickTrBatch(items, clearedIds, n){
  var clearedSet = {};
  clearedIds.forEach(function(id){ clearedSet[id]=true; });
  var pending = items.filter(function(it){ return !clearedSet[it.id]; });
  function shuffle(arr){
    for(var i=arr.length-1;i>0;i--){
      var j=Math.floor(Math.random()*(i+1)); var t=arr[i]; arr[i]=arr[j]; arr[j]=t;
    }
    return arr;
  }
  pending = shuffle(pending.slice());
  var batch = pending.slice(0,n);
  if(batch.length < n){
    var rest = shuffle(items.filter(function(it){ return !pending.some(function(p){ return p.id===it.id; }); }));
    batch = batch.concat(rest.slice(0, n-batch.length));
  }
  return batch;
}

function startTrRun(){
  _trBatch = pickTrBatch(_trSet.items||[], _trProgress.clearedItemIds||[], 7);
  _trBatchResults = [];
  _trBatchIdx = 0;
  _trRunStart = Date.now();
  renderTrQuestion();
}

/* ── Question screen ── */
function renderTrQuestion(){
  var c = document.getElementById('vmContent');
  var q = _trBatch[_trBatchIdx];
  if(!q){ renderTrRunResult(); return; }
  var total    = _trBatch.length;
  var dirLabel = q.direction==='en2vi' ? 'Dịch sang Tiếng Việt' : 'Dịch sang Tiếng Anh';
  var dirBadge = q.direction==='en2vi' ? 'EN → VI' : 'VI → EN';
  var dirColor = q.direction==='en2vi' ? 'var(--aw-primary)' : '#8B5CF6';

  c.innerHTML =
    '<button class="aw-btn aw-btn-ghost" id="trQBack" style="margin-bottom:10px;padding:6px 14px">← Danh sách</button>'+
    '<div style="max-width:600px;margin:0 auto">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'+
        '<div style="display:flex;align-items:center;gap:8px">'+
          '<span style="font-size:.82rem;font-weight:700;padding:3px 9px;border-radius:12px;'+
            'background:'+dirColor+'22;color:'+dirColor+'">'+dirBadge+'</span>'+
          '<span style="font-size:.8rem;color:var(--aw-ink-3)">Câu '+(_trBatchIdx+1)+'/'+total+'</span>'+
          (q.isTreasure ? '<span>💎</span>' : '')+
        '</div>'+
        '<span style="font-size:.78rem;color:var(--aw-ink-3)">Lượt '+(_trProgress.nextRunIndex||1)+'</span>'+
      '</div>'+
      '<div style="background:var(--aw-surface-2);border:1px solid var(--aw-border-2);border-radius:var(--aw-r);'+
        'padding:18px 20px;font-size:1.12rem;line-height:1.6;margin-bottom:12px">'+
        AW.esc(q.source)+
      '</div>'+
      '<p style="font-size:.8rem;color:var(--aw-ink-3);text-align:center;margin:0 0 10px">'+dirLabel+'</p>'+
      '<textarea class="aw-input" id="trAnswer" rows="3" autocomplete="off" '+
        'placeholder="Nhập bản dịch của bạn…" style="resize:vertical;font-size:.95rem;line-height:1.6;width:100%;box-sizing:border-box"></textarea>'+
      '<div id="trGradeStatus" style="font-size:.8rem;color:var(--aw-ink-3);min-height:16px;margin-top:6px"></div>'+
      '<div style="display:flex;gap:10px;margin-top:12px">'+
        '<button class="aw-btn aw-btn-primary" id="trSubmitBtn" style="flex:1;padding:12px">Nộp câu này</button>'+
      '</div>'+
      '<div id="trFeedbackWrap" style="display:none;margin-top:16px;padding:16px 18px;'+
        'background:var(--aw-surface-2);border-radius:var(--aw-r);border:1px solid var(--aw-border-2)">'+
        '<div id="trFeedbackContent"></div>'+
        '<div id="trChestBtn" style="margin-top:10px;display:none">'+
          '<button class="aw-btn aw-btn-ghost" id="addChestBtn" style="padding:7px 14px;font-size:.82rem">💎 Lưu vào rương</button>'+
        '</div>'+
        '<div style="margin-top:12px">'+
          '<button class="aw-btn aw-btn-primary" id="trNextBtn" style="width:100%;padding:11px">Câu tiếp →</button>'+
        '</div>'+
      '</div>'+
    '</div>';

  document.getElementById('trQBack').onclick = function(){ renderTranslateList(); };
  var ansEl = document.getElementById('trAnswer');
  ansEl.focus();
  ansEl.addEventListener('keydown', function(e){
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); document.getElementById('trSubmitBtn').click(); }
  });

  document.getElementById('trSubmitBtn').onclick = function(){
    var answer = (ansEl.value||'').trim();
    if(!answer){ AW.toast('Nhập bản dịch trước.','warn'); return; }
    var btn = document.getElementById('trSubmitBtn');
    btn.disabled = true;
    document.getElementById('trGradeStatus').textContent = '⏳ AI đang chấm…';
    gradeTrItem(q, answer, function(result){
      document.getElementById('trGradeStatus').textContent = '';
      ansEl.disabled = true;
      _trBatchResults.push({ itemId:q.id, score:result.score, feedback:result.feedback,
        answer:answer, modelAnswer:q.modelAnswer });
      showTrFeedback(q, answer, result);
    });
  };
}

/* ── AI grading ── */
function gradeTrItem(item, answer, cb){
  var key  = AW.geminiKey.get();
  var groq = AW.groqKey && AW.groqKey.get ? AW.groqKey.get() : '';

  var prompt = [
    'You are an EFL translation grader. Evaluate semantic meaning accuracy.',
    'Direction: '+(item.direction==='en2vi'?'English → Vietnamese':'Vietnamese → English'),
    'Source: '+item.source,
    'Model answer: '+item.modelAnswer,
    'Student answer: '+answer,
    'Target words: '+(item.targetWords||[]).join(', '),
    '',
    'Return ONLY valid JSON, no markdown:',
    '{"score":0-100,"feedback":"1 sentence in Vietnamese","usedTargets":[],"missedTargets":[]}'
  ].join('\n');

  function parseResult(text){
    text = text.replace(/```json[\n]?/g,'').replace(/```[\n]?/g,'').trim();
    var obj = JSON.parse(text);
    return { score:Math.max(0,Math.min(100,parseInt(obj.score,10)||0)),
             feedback:obj.feedback||'', usedTargets:obj.usedTargets||[], missedTargets:obj.missedTargets||[] };
  }

  if(key){
    var MODELS = ['gemini-2.0-flash','gemini-1.5-flash','gemini-2.5-flash'];
    var mi = 0;
    function tryGemini(){
      if(mi>=MODELS.length){ tryGroq(); return; }
      var m = MODELS[mi++];
      fetch('https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent?key='+encodeURIComponent(key),{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],
          generationConfig:{maxOutputTokens:256,temperature:0.1}})
      }).then(function(r){ return r.json(); }).then(function(d){
        var text=((((d.candidates||[])[0]||{}).content||{}).parts||[]).map(function(p){return p.text||'';}).join('');
        if(!text) throw new Error('empty');
        cb(parseResult(text));
      }).catch(function(){ tryGemini(); });
    }
    tryGemini(); return;
  }

  function tryGroq(){
    if(!groq){ cb(offlineTrGrade(item,answer)); return; }
    fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+groq},
      body:JSON.stringify({model:'llama3-8b-8192',messages:[{role:'user',content:prompt}],
        max_tokens:256,temperature:0.1})
    }).then(function(r){ return r.json(); }).then(function(d){
      var text = ((d.choices||[])[0]||{}).message&&d.choices[0].message.content||'';
      if(!text) throw new Error('empty');
      cb(parseResult(text));
    }).catch(function(){ cb(offlineTrGrade(item,answer)); });
  }
  if(!key) tryGroq();
}

function offlineTrGrade(item, answer){
  function tokens(s){ return (s||'').toLowerCase().replace(/[^a-záàảãạăắặẳẵâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ\s]/g,'').split(/\s+/).filter(Boolean); }
  var ref=tokens(item.modelAnswer), ans=tokens(answer);
  var matches=ans.filter(function(t){ return ref.indexOf(t)>=0; }).length;
  var score = ref.length ? Math.round(Math.min(100, matches/ref.length*100)) : 0;
  return { score:score, feedback:'(Chấm offline — không có API key)', usedTargets:[], missedTargets:[] };
}

/* ── Feedback panel ── */
function showTrFeedback(item, answer, result){
  var sc = result.score;
  var passScore = (_trSet&&_trSet.passScore)||85;
  var col = sc>=passScore ? 'var(--aw-writing)' : (sc>=60 ? '#A66B00' : 'var(--aw-danger)');
  var passed = sc >= passScore;

  document.getElementById('trFeedbackContent').innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">'+
      '<div style="font-size:1.6rem;font-weight:800;color:'+col+'">'+sc+'%</div>'+
      '<div>'+
        '<div style="font-size:.82rem;font-weight:700;color:'+col+';margin-bottom:2px">'+
          (passed ? '✅ Đạt — qua câu tiếp' : '❌ Chưa đạt — dịch lại')+
        '</div>'+
        '<div style="font-size:.82rem;color:var(--aw-ink-2)">'+AW.esc(result.feedback)+'</div>'+
      '</div>'+
    '</div>'+
    '<div style="font-size:.82rem;background:var(--aw-surface);border-radius:8px;padding:10px 12px;'+
      'border-left:3px solid var(--aw-writing);margin-bottom:4px">'+
      '<b style="font-size:.72rem;color:var(--aw-ink-3);display:block;margin-bottom:3px">ĐÁP ÁN MẪU</b>'+
      AW.esc(item.modelAnswer)+
    '</div>'+
    (item.pattern ? '<div style="font-size:.78rem;color:#8B5CF6;margin-top:8px">💡 Pattern: <b>'+AW.esc(item.pattern)+'</b></div>' : '')+
    (result.missedTargets&&result.missedTargets.length ?
      '<div style="font-size:.76rem;color:var(--aw-danger);margin-top:6px">Từ chưa dùng: '+AW.esc(result.missedTargets.join(', '))+'</div>' : '');

  document.getElementById('trFeedbackWrap').style.display = '';

  if(item.isTreasure){
    document.getElementById('trChestBtn').style.display = '';
    document.getElementById('addChestBtn').onclick = function(){
      AW.toast('💎 Đã lưu vào rương!','ok');
      _trBatch[_trBatchIdx]._savedToChest = true;
      this.disabled = true; this.textContent = '✓ Đã lưu';
    };
  }

  var nextBtn = document.getElementById('trNextBtn');
  if(!passed){
    nextBtn.textContent = '🔄 Dịch lại câu này';
    nextBtn.style.background = 'var(--aw-danger)';
    nextBtn.onclick = function(){
      _trBatchResults = _trBatchResults.filter(function(r){ return r.itemId !== item.id; });
      document.getElementById('trFeedbackWrap').style.display = 'none';
      var sb = document.getElementById('trSubmitBtn');
      if(sb){ sb.style.display=''; sb.disabled=false; }
      var ans2 = document.getElementById('trAnswer');
      if(ans2){ ans2.disabled=false; ans2.value=''; ans2.focus(); }
      document.getElementById('trGradeStatus').textContent = '';
    };
  } else {
    nextBtn.textContent = 'Câu tiếp →';
    nextBtn.style.background = '';
    nextBtn.onclick = function(){
      _trBatchIdx++;
      if(_trBatchIdx >= _trBatch.length) renderTrRunResult();
      else renderTrQuestion();
    };
  }
  document.getElementById('trSubmitBtn').style.display = 'none';
}

/* ── Run result screen ── */
function renderTrRunResult(){
  var c = document.getElementById('vmContent');
  var total      = _trBatchResults.length || 1;
  var runScore   = Math.round(_trBatchResults.reduce(function(a,r){ return a+(r.score||0); },0)/total);
  var passed     = runScore >= (_trSet.passScore||85);
  var durationSec = Math.round((Date.now()-_trRunStart)/1000);

  var prevCleared = {};
  (_trProgress.clearedItemIds||[]).forEach(function(id){ prevCleared[id]=true; });
  _trBatchResults.forEach(function(r){ if((r.score||0)>=(_trSet.passScore||85)) prevCleared[r.itemId]=true; });
  var newClearedIds = Object.keys(prevCleared);

  var chest = _trBatch.filter(function(it){ return it._savedToChest; }).map(function(it){
    return { itemId:it.id, source:it.source, modelAnswer:it.modelAnswer, pattern:it.pattern||null };
  });

  var runIdx = _trProgress.nextRunIndex||1;
  var sessionOpen = (_trSet.sessionStatus||'open') === 'open';

  if(sessionOpen){
    AW.api('translate.saveResult',{
      studentId:sess.studentId, name:sess.name||'', class:sess.class||'',
      setId:_trSet.setId, title:_trSet.title,
      runIndex:runIdx, score:runScore, passed:passed,
      durationSec:durationSec,
      itemScores:_trBatchResults, clearedItemIds:newClearedIds, chest:chest
    }).then(function(r){
      if(r&&r.success){
        _trProgress.clearedItemIds = newClearedIds;
        _trProgress.nextRunIndex   = runIdx+1;
        _trProgress.runs = (_trProgress.runs||0)+1;
      } else if(r&&r.error) {
        AW.toast(r.error,'err',4000);
      }
    }).catch(function(){ AW.toast('Lỗi lưu kết quả.','err'); });
  }

  var cleared  = newClearedIds.length;
  var total30  = (_trSet.items||[]).length;
  var pct      = total30 ? Math.round(cleared/total30*100) : 0;
  var scCol    = runScore>=85 ? 'var(--aw-writing)' : (runScore>=60 ? '#A66B00' : 'var(--aw-danger)');

  c.innerHTML =
    '<div style="max-width:520px;margin:16px auto;text-align:center;background:var(--aw-surface);'+
      'border:1px solid var(--aw-border-2);border-radius:var(--aw-r);padding:28px 24px">'+
      '<div style="font-size:2.8rem;font-weight:800;color:'+scCol+'">'+runScore+'%</div>'+
      '<div style="font-size:.95rem;font-weight:700;margin:6px 0 16px;color:'+scCol+'">'+
        (passed ? '✅ Đạt lượt này!' : '❌ Chưa đạt — thử lại nhé')+
        ' · '+cleared+'/'+total30+' câu clear</div>'+
      '<div style="height:8px;background:var(--aw-border-2);border-radius:4px;margin-bottom:16px">'+
        '<div style="width:'+pct+'%;height:100%;background:var(--aw-writing);border-radius:4px;transition:width .5s"></div>'+
      '</div>'+
      (passed&&cleared<total30 ?
        '<p style="font-size:.86rem;color:var(--aw-ink-2);margin-bottom:16px">Còn '+(total30-cleared)+' câu nữa. Tiếp tục để clear hết!</p>' : '')+
      (passed&&cleared>=total30 ?
        '<p style="font-size:.9rem;color:var(--aw-writing);font-weight:700;margin-bottom:16px">🎉 Bạn đã hoàn thành tất cả '+total30+' câu!</p>' : '')+
      (!passed ?
        '<p style="font-size:.86rem;color:var(--aw-ink-3);margin-bottom:16px">Cần ≥ '+(_trSet.passScore||85)+'% để mở lượt tiếp.</p>' : '')+
      '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">'+
        (passed&&cleared<total30 ?
          '<button class="aw-btn aw-btn-primary" id="trContinue" style="padding:11px 24px">Làm tiếp 7 câu →</button>' : '')+
        (!passed ?
          '<button class="aw-btn aw-btn-primary" id="trRetry" style="padding:11px 22px">Làm lại lượt này</button>' : '')+
        '<button class="aw-btn aw-btn-ghost" id="trBackList" style="padding:11px 18px">← Danh sách</button>'+
      '</div>'+
    '</div>';

  var cb = document.getElementById('trContinue');
  if(cb) cb.onclick = function(){
    _trProgress.clearedItemIds = newClearedIds;
    _trProgress.nextRunIndex   = runIdx+1;
    startTrRun();
  };
  var rb = document.getElementById('trRetry');
  if(rb) rb.onclick = function(){
    _trBatchResults = []; _trBatchIdx = 0; _trRunStart = Date.now();
    renderTrQuestion();
  };
  document.getElementById('trBackList').onclick = function(){ renderTranslateList(); };
}

/* ── History (closed set) ── */
function renderTrHistory(){
  AW.api('translate.myProgress',{setId:_trSet.setId,studentId:sess.studentId}).then(function(r){
    var p = r.success ? r.data : _trProgress;
    var c = document.getElementById('vmContent');
    var cleared = (p.clearedItemIds||[]).length;
    var total   = (_trSet.items||[]).length;
    var pct     = total ? Math.round(cleared/total*100) : 0;
    c.innerHTML =
      '<button class="aw-btn aw-btn-ghost" id="trHistBack" style="margin-bottom:14px;padding:6px 14px">← Giới thiệu</button>'+
      '<div style="max-width:520px;margin:0 auto;background:var(--aw-surface);border:1px solid var(--aw-border-2);border-radius:var(--aw-r);padding:22px 24px">'+
        '<h4 style="font-family:var(--aw-font-display);margin:0 0 14px">📊 Kết quả của bạn</h4>'+
        '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px">'+
          '<div style="text-align:center"><b style="font-size:1.3rem">'+p.runs+'</b><br><span style="font-size:.72rem;color:var(--aw-ink-3)">Lượt làm</span></div>'+
          '<div style="text-align:center"><b style="font-size:1.3rem;color:var(--aw-writing)">'+p.bestScore+'%</b><br><span style="font-size:.72rem;color:var(--aw-ink-3)">Best score</span></div>'+
          '<div style="text-align:center"><b style="font-size:1.3rem">'+cleared+'/'+total+'</b><br><span style="font-size:.72rem;color:var(--aw-ink-3)">Câu cleared</span></div>'+
        '</div>'+
        '<div style="height:8px;background:var(--aw-border-2);border-radius:4px;margin-bottom:14px">'+
          '<div style="width:'+pct+'%;height:100%;background:var(--aw-writing);border-radius:4px"></div>'+
        '</div>'+
        (pct===100 ? '<p style="color:var(--aw-writing);font-weight:700;margin:0">🎉 Đã hoàn thành 100%!</p>' :
          '<p style="font-size:.85rem;color:var(--aw-ink-3);margin:0">Còn '+(total-cleared)+' câu chưa clear.</p>')+
      '</div>';
    document.getElementById('trHistBack').onclick = function(){ renderTrIntro('closed'); };
  });
}


