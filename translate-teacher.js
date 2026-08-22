/*
 * ArticuWrite — Translate Practice (teacher)
 * 1. Paste translate modal HTML into teacher.html body (before </body>)
 * 2. Add <script src="translate-teacher.js"></script> before </body>
 * 3. In Results mode selector: add <option value="translate">🔄 Translate</option>
 * 4. In load() function: add translate branch (see translate-teacher-results-patch.js)
 * 5. Requires: AW, AW.geminiKey, state.classes, sess, showOverlay/hideOverlay, clsName(), fmtDeadline()
 */

/* ───────── MODAL HTML — paste into <body> ─────────
<div class="aw-modal-bg" id="translateModal">
  <div class="aw-auth-card" style="max-width:700px;width:100%;max-height:92vh;overflow-y:auto;margin:0">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h2 style="font-family:var(--aw-font-display);font-size:1.3rem;margin:0">✏️ Tạo bài Luyện Dịch</h2>
      <button onclick="closeTrModal()" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:var(--aw-ink-3)">✕</button>
    </div>

    <div style="display:flex;flex-direction:column;gap:14px">

      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="aw-field" style="flex:1;min-width:150px">
          <label class="aw-label">Lớp <span style="color:var(--aw-danger)">*</span></label>
          <select class="aw-input" id="tr-class">
            <option value="">— Chọn lớp —</option>
          </select>
        </div>
        <div class="aw-field" style="flex:1;min-width:200px">
          <label class="aw-label">Tiêu đề <span style="color:var(--aw-danger)">*</span></label>
          <input class="aw-input" id="tr-title" placeholder="VD: Dịch · Chủ đề Environment">
        </div>
      </div>
───────────────────────────────────────────────── */

// ── Translate ─────────────────────────────────────────────────────────

var _trItems = [];

function openTrModal(){
  _trItems = [];
  var trSaveBtn = document.getElementById('trSaveBtn');
  if (trSaveBtn) trSaveBtn.disabled = true;
  var pw = document.getElementById('trPreviewWrap');
  if (pw) pw.style.display = 'none';
  var gs = document.getElementById('trGenStatus');
  if (gs) gs.textContent = '';
  var rb = document.getElementById('trRegenBtn');
  if (rb) rb.style.display = 'none';

  // Populate class dropdown from state.classes
  var sel = document.getElementById('tr-class');
  if (sel) {
    sel.innerHTML = '<option value="">— Chọn lớp —</option>'+
      (state.classes||[]).map(function(c){
        return '<option value="'+AW.esc(c.classId)+'">'+AW.esc(c.className)+'</option>';
      }).join('');
    // Auto-select the class currently shown in the Results / Assignments filter if available
    var activeCls = (function(){
      var r = document.getElementById('rsCls'); if (r && r.value) return r.value;
      var a = document.getElementById('aClass'); if (a && a.value) return a.value;
      if (state.classes && state.classes.length === 1) return state.classes[0].classId;
      return '';
    })();
    if (activeCls) sel.value = activeCls;
  }
  document.getElementById('tr-target-words').value = '';
  document.getElementById('tr-title').value = '';
  var pp = parseInt(document.getElementById('tr-pass').value, 10);
  if (!pp) document.getElementById('tr-pass').value = '85';
  document.getElementById('tr-duration').value = '';

  // Default session start = now + 5 min (local time)
  var d = new Date(Date.now() + 5*60000);
  var off = d.getTimezoneOffset() * 60000;
  document.getElementById('tr-start').value = new Date(d.getTime() - off).toISOString().slice(0,16);
  document.getElementById('tr-deadline').value = '';

  document.getElementById('translateModal').classList.add('show');
}

function closeTrModal(){
  document.getElementById('translateModal').classList.remove('show');
}

function trGenItems(){
  var cls   = document.getElementById('tr-class').value;
  var words = (document.getElementById('tr-target-words').value||'').trim();
  var title = (document.getElementById('tr-title').value||'').trim();
  if (!cls)   { AW.toast('Chọn lớp.','warn'); return; }
  if (!words) { AW.toast('Nhập danh sách từ vựng trước.','warn'); return; }

  var key = AW.geminiKey.get();
  if (!key) { AW.toast('Cần Gemini API key — vào Settings để nhập.','warn'); return; }

  var statusEl = document.getElementById('trGenStatus');
  var genBtn   = document.getElementById('trGenBtn');
  var regenBtn = document.getElementById('trRegenBtn');
  genBtn.disabled = true;
  statusEl.textContent = '⏳ Đang sinh 30 câu với Gemini…';

  var wordList = words.split('\n').map(function(w){ return w.trim(); }).filter(Boolean).join(', ');
  var prompt = [
    'You are an EFL teacher creating translation exercises for Vietnamese university students.',
    '',
    'Generate EXACTLY 30 translation exercise items.',
    '',
    'STRICT RULES:',
    '- Return ONLY a JSON array, no markdown, no explanation',
    '- Exactly 30 items; odd-indexed (0,2,4...) → direction "en2vi"; even-indexed (1,3,5...) → "vi2en"',
    '- source: sentence/phrase to translate (≤25 words, 1 idea, natural academic/general English or Vietnamese)',
    '- modelAnswer: accurate, natural translation',
    '- targetWords: array of vocab words from the list below actually used (empty array if none)',
    '- isTreasure: true for ~4–5 items that demonstrate a useful grammar pattern',
    '- pattern: grammar pattern label for isTreasure items (null otherwise)',
    '- id: "t01" to "t30"',
    '',
    'TARGET VOCABULARY: ' + wordList,
    (title ? '\nTHEME / TITLE: ' + title : ''),
    '',
    'Each item MUST use at least 1 word from the vocabulary list (or paraphrase of it).',
    'Vary sentence structures. Level: B1–B2 CEFR.',
    '',
    'Return ONLY the JSON array of 30 objects.'
  ].join('\n');

  var MODELS = ['gemini-2.5-flash','gemini-2.0-flash','gemini-1.5-flash'];
  var mi = 0;

  function tryModel(){
    if (mi >= MODELS.length){ onFail('All Gemini models failed'); return; }
    var m = MODELS[mi++];
    fetch('https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent?key='+encodeURIComponent(key),{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],
        generationConfig:{maxOutputTokens:8192,temperature:0.4}})
    }).then(function(r){
      if (!r.ok) return r.json().then(function(e){ throw new Error((e.error&&e.error.message)||'HTTP '+r.status); });
      return r.json();
    }).then(function(d){
      var parts=(((d.candidates||[])[0]||{}).content||{}).parts||[];
      var text=parts.map(function(p){return p.text||'';}).join('').trim();
      if (!text) throw new Error('Empty response');
      text = text.replace(/```json[\n]?/g,'').replace(/```[\n]?/g,'').trim();
      var arr = JSON.parse(text);
      if (!Array.isArray(arr)||arr.length<10) throw new Error('Parsed only '+arr.length+' items');
      onSuccess(arr.slice(0,30));
    }).catch(function(err){
      if (mi < MODELS.length) tryModel();
      else onFail(err.message||String(err));
    });
  }

  function onSuccess(items){
    _trItems = items;
    genBtn.disabled = false; regenBtn.style.display = '';
    statusEl.textContent = '✅ Đã sinh '+items.length+' câu.';
    document.getElementById('trPreviewWrap').style.display = '';
    document.getElementById('trItemCount').textContent = '('+items.length+'/30)';
    document.getElementById('trItemsTbody').innerHTML = items.map(function(it,i){
      var tw  = (it.targetWords||[]).join(', ');
      var dir = it.direction==='en2vi'?'EN→VI':'VI→EN';
      var col = it.direction==='en2vi'?'var(--aw-primary)':'#8B5CF6';
      return '<tr>'+
        '<td style="color:var(--aw-ink-3);font-size:.75rem">'+(i+1)+'</td>'+
        '<td><span style="font-size:.7rem;font-weight:700;color:'+col+'">'+dir+'</span>'+(it.isTreasure?' 💎':'')+'</td>'+
        '<td style="max-width:200px;word-break:break-word;font-size:.8rem">'+AW.esc(it.source)+'</td>'+
        '<td style="max-width:200px;word-break:break-word;font-size:.8rem;color:var(--aw-ink-2)">'+AW.esc(it.modelAnswer)+'</td>'+
        '<td style="font-size:.7rem;color:var(--aw-writing)">'+AW.esc(tw)+'</td>'+
      '</tr>';
    }).join('');
    document.getElementById('trSaveBtn').disabled = false;
  }
  function onFail(msg){
    genBtn.disabled = false; regenBtn.style.display = '';
    statusEl.innerHTML = '<span style="color:var(--aw-danger)">❌ '+AW.esc(msg)+'</span>';
    AW.toast('Sinh câu thất bại: '+msg,'err',5000);
  }
  tryModel();
}

function saveTrSet(){
  var classId = document.getElementById('tr-class').value;
  var title   = (document.getElementById('tr-title').value||'').trim();
  var words   = (document.getElementById('tr-target-words').value||'').trim();
  var pass    = parseInt(document.getElementById('tr-pass').value,10)||85;
  var start   = document.getElementById('tr-start').value;
  var dur     = parseInt(document.getElementById('tr-duration').value,10)||0;
  var dl      = document.getElementById('tr-deadline').value;

  if (!classId)       { AW.toast('Chọn lớp.','warn'); return; }
  if (!title)         { AW.toast('Nhập tiêu đề.','warn'); return; }
  if (!start)         { AW.toast('Nhập giờ bắt đầu.','warn'); return; }
  if (!dur && !dl)    { AW.toast('Nhập thời gian (phút) hoặc Deadline.','warn'); return; }
  if (!_trItems.length){ AW.toast('Sinh câu AI trước.','warn'); return; }

  // Compute sessionEnd: prefer start+duration; fall back to deadline
  var sessionEnd = '';
  if (dur > 0 && start) {
    var startMs = new Date(start).getTime();
    if (!isNaN(startMs)) {
      var endD = new Date(startMs + dur * 60000);
      var off2 = endD.getTimezoneOffset() * 60000;
      sessionEnd = new Date(endD.getTime() - off2).toISOString().slice(0,16);
      // Also set deadline display to match if not manually set
      if (!dl) dl = sessionEnd;
    }
  } else if (dl) {
    sessionEnd = dl;
  }

  var setId = 'tr_' + Date.now().toString(36).toUpperCase();
  var payload = {
    setId:        setId,
    classId:      classId,
    title:        title,
    targetWords:  words,
    passScore:    pass,
    sessionStart: start,
    sessionEnd:   sessionEnd,
    deadline:     dl || sessionEnd,
    durationMin:  dur || '',
    items:        _trItems,
    teacherEmail: sess.email || '',
  };

  document.getElementById('trSaveBtn').disabled = true;
  showOverlay('Lưu bài dịch…');

  AW.apiLarge('translate.create', payload).then(function(res){
    hideOverlay();
    document.getElementById('trSaveBtn').disabled = false;
    if (res && res.success){
      AW.toast('Đã tạo bài Luyện Dịch!','ok');
      closeTrModal();
      renderTranslate();
    } else {
      AW.toast('Lỗi: '+(res&&res.error||'Unknown'),'err',5000);
    }
  }).catch(function(err){
    hideOverlay();
    document.getElementById('trSaveBtn').disabled = false;
    AW.toast('Lỗi kết nối: '+(err&&err.message||err),'err',5000);
  });
}

/* ── Translate list page ── */
function renderTranslate(){
  if (typeof AW !== 'undefined' && AW.setTitle) AW.setTitle('Luyện Dịch');
  else if (typeof VM !== 'undefined' && VM.setTitle) VM.setTitle('Luyện Dịch');
  hideOverlay();
  var c = document.getElementById('vmContent');
  c.innerHTML = '<div class="vm-empty"><span class="vm-spin-dark" style="width:24px;height:24px;border-width:3px"></span></div>';
  loadClasses(function(){
    // Build class filter toolbar
    var clsHtml = '<select class="vm-select" id="trClsFilter" style="min-width:160px">'+
      '<option value="">Tất cả lớp</option>'+
      (state.classes||[]).map(function(cl){
        return '<option value="'+AW.esc(cl.classId)+'">'+AW.esc(cl.className)+'</option>';
      }).join('')+
    '</select>';

    var filterCls = '';
    function loadList(){
      filterCls = (document.getElementById('trClsFilter')||{}).value || '';
      AW.api('translate.list', { classId: filterCls }).then(function(res){
        var sets = (res&&res.success) ? res.data : [];
        var tbody = sets.length ?
          sets.map(function(s){
            var active = String(s.active).toUpperCase()==='TRUE';
            var statusBadge = s.sessionStatus==='open'
              ? '<span style="color:var(--aw-writing);font-weight:700">● Đang mở</span>'
              : s.sessionStatus==='upcoming'
                ? '<span style="color:#A66B00;font-weight:700">⏳ Chưa mở</span>'
                : '<span style="color:var(--aw-ink-3)">✓ Đã đóng</span>';
            return '<tr>'+
              '<td><b>'+AW.esc(s.title)+'</b></td>'+
              '<td style="font-size:.8rem">'+AW.esc(clsName(s.classId))+'</td>'+
              '<td style="font-size:.8rem">'+s.passScore+'%</td>'+
              '<td style="font-size:.78rem">'+fmtDeadline(s.sessionStart)+'</td>'+
              '<td style="font-size:.78rem">'+fmtDeadline(s.deadline)+'</td>'+
              '<td>'+statusBadge+'</td>'+
              '<td>'+
                '<button class="aw-btn aw-btn-ghost" style="padding:4px 10px;font-size:.76rem" data-tr-stats="'+AW.esc(s.setId)+'">Stats</button>'+
                ' <button class="aw-btn" style="padding:4px 10px;font-size:.76rem;color:'+(active?'var(--aw-danger)':'var(--aw-writing)')+'" '+
                  'data-tr-toggle="'+AW.esc(s.setId)+'" data-tr-active="'+(active?'1':'0')+'">'+
                  (active?'Đóng':'Mở lại')+'</button>'+
              '</td>'+
            '</tr>';
          }).join('')
          : '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--aw-ink-3)">Chưa có bài dịch cho lớp này.</td></tr>';

        c.innerHTML =
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">'+
            clsHtml+
            '<button class="aw-btn aw-btn-primary" onclick="openTrModal()">+ Tạo bài dịch</button>'+
            '<span style="font-size:.78rem;color:var(--aw-ink-3)">'+sets.length+' bài</span>'+
          '</div>'+
          '<div style="overflow-x:auto;border:1px solid var(--aw-border-2);border-radius:var(--aw-r)">'+
            '<table style="width:100%;border-collapse:collapse;font-size:.85rem">'+
              '<thead style="background:var(--aw-surface-2)"><tr>'+
                '<th style="padding:8px 12px;text-align:left">Tiêu đề</th>'+
                '<th style="padding:8px 12px;text-align:left">Lớp</th>'+
                '<th style="padding:8px 12px">Pass</th>'+
                '<th style="padding:8px 12px">Session Start</th>'+
                '<th style="padding:8px 12px">Deadline</th>'+
                '<th style="padding:8px 12px">Status</th>'+
                '<th style="padding:8px 12px">Actions</th>'+
              '</tr></thead>'+
              '<tbody>'+tbody+'</tbody>'+
            '</table>'+
          '</div>'+
          '<div id="trStatsWrap" style="margin-top:20px"></div>';

        // Wire class filter
        var cf = document.getElementById('trClsFilter');
        if (cf) cf.onchange = loadList;

        // Wire stats buttons
        AW.els('[data-tr-stats]').forEach(function(btn){
          btn.onclick = function(){ loadTrStats(btn.getAttribute('data-tr-stats')); };
        });
        // Wire toggle buttons
        AW.els('[data-tr-toggle]').forEach(function(btn){
          btn.onclick = function(){
            var sid = btn.getAttribute('data-tr-toggle');
            var cur = btn.getAttribute('data-tr-active') === '1';
            AW.api('translate.update', { setId:sid, active:!cur }).then(function(r){
              if (r&&r.success){ AW.toast('Đã cập nhật.','ok'); loadList(); }
              else AW.toast('Lỗi.','err');
            });
          };
        });
      }).catch(function(){ hideOverlay(); AW.toast('Lỗi kết nối.','err'); });
    }
    loadList();
  });
}

function loadTrStats(setId){
  var wrap = document.getElementById('trStatsWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--aw-ink-3)">⏳ Loading stats…</div>';
  AW.api('translate.stats', { setId:setId }).then(function(res){
    if (!res||!res.success){ wrap.innerHTML='<p style="color:var(--aw-danger);text-align:center">Lỗi tải stats.</p>'; return; }
    var d = res.data;
    var allStudents = d.students.slice();
    var sortCol='lastTimestamp', sortDir='desc', searchQ='';

    function sorted(){
      var list = allStudents.filter(function(s){
        if (!searchQ) return true;
        var q = searchQ.toLowerCase();
        return (s.studentId||'').toLowerCase().indexOf(q)>=0 || (s.name||'').toLowerCase().indexOf(q)>=0;
      });
      list.sort(function(a,b){
        var av=a[sortCol]||'', bv=b[sortCol]||'';
        if (typeof av==='number'&&typeof bv==='number') return sortDir==='asc'?av-bv:bv-av;
        return sortDir==='asc'?String(av).localeCompare(String(bv)):String(bv).localeCompare(String(av));
      });
      return list;
    }

    function thSort(col,label){
      return '<th style="padding:7px 10px;cursor:pointer;white-space:nowrap" data-trs-sort="'+col+'">'+label+
        (sortCol===col?('<span style="font-size:.65rem;margin-left:3px">'+(sortDir==='asc'?'↑':'↓')+'</span>'):'')+'</th>';
    }

    function renderTable(){
      var rows = sorted();
      document.getElementById('trStatsTbl').innerHTML = rows.length ? rows.map(function(s){
        var cc=s.clearedCount, total=30;
        var pct=Math.round(cc/total*100);
        var col=cc>=total?'var(--aw-writing)':(cc>=20?'#A66B00':'var(--aw-ink)');
        var scCol=s.bestScore>=85?'var(--aw-writing)':(s.bestScore>=60?'#A66B00':'var(--aw-danger)');
        return '<tr>'+
          '<td style="padding:7px 10px"><b>'+AW.esc(s.studentId)+'</b></td>'+
          '<td style="padding:7px 10px">'+AW.esc(s.name)+'</td>'+
          '<td style="padding:7px 10px;text-align:center">'+s.runs+'</td>'+
          '<td style="padding:7px 10px;text-align:center"><b style="color:'+scCol+'">'+s.bestScore+'%</b></td>'+
          '<td style="padding:7px 10px;text-align:center">'+s.lastScore+'%</td>'+
          '<td style="padding:7px 10px">'+
            '<div style="display:flex;align-items:center;gap:6px">'+
              '<b style="color:'+col+'">'+cc+'/'+total+'</b>'+
              '<div style="flex:1;height:5px;background:var(--aw-border-2);border-radius:3px;min-width:50px">'+
                '<div style="width:'+pct+'%;height:100%;background:'+col+';border-radius:3px"></div>'+
              '</div>'+
            '</div>'+
          '</td>'+
          '<td style="padding:7px 10px;font-size:.75rem;color:var(--aw-ink-3)">'+AW.fmtDate(s.lastTimestamp)+'</td>'+
        '</tr>';
      }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--aw-ink-3)">Chưa có kết quả.</td></tr>';
      // re-wire sort
      wrap.querySelectorAll('[data-trs-sort]').forEach(function(th){
        th.onclick=function(){
          var col=th.getAttribute('data-trs-sort');
          if(sortCol===col) sortDir=sortDir==='asc'?'desc':'asc'; else{sortCol=col;sortDir='asc';}
          renderHeader(); renderTable();
        };
      });
    }

    function renderHeader(){
      document.getElementById('trStatsThead').innerHTML='<tr>'+
        thSort('studentId','Student ID')+thSort('name','Tên')+thSort('runs','Runs')+
        thSort('bestScore','Best %')+thSort('lastScore','Last %')+
        thSort('clearedCount','Cleared')+thSort('lastTimestamp','Last active')+
      '</tr>';
      wrap.querySelectorAll('[data-trs-sort]').forEach(function(th){
        th.onclick=function(){
          var col=th.getAttribute('data-trs-sort');
          if(sortCol===col) sortDir=sortDir==='asc'?'desc':'asc'; else{sortCol=col;sortDir='asc';}
          renderHeader(); renderTable();
        };
      });
    }

    wrap.innerHTML =
      // KPI strip
      '<div style="display:flex;gap:16px;margin-bottom:14px;flex-wrap:wrap;padding:14px 16px;'+
        'background:var(--aw-surface-2);border:1px solid var(--aw-border-2);border-radius:var(--aw-r)">'+
        '<div><div style="font-size:1.5rem;font-weight:700">'+d.studentCount+'</div>'+
          '<div style="font-size:.7rem;color:var(--aw-ink-3);text-transform:uppercase">SV đã làm</div></div>'+
        '<div><div style="font-size:1.5rem;font-weight:700">'+d.runsCount+'</div>'+
          '<div style="font-size:.7rem;color:var(--aw-ink-3);text-transform:uppercase">Lượt làm</div></div>'+
        '<div><div style="font-size:1.5rem;font-weight:700;color:var(--aw-writing)">'+d.avgScore+'%</div>'+
          '<div style="font-size:.7rem;color:var(--aw-ink-3);text-transform:uppercase">Avg score</div></div>'+
        '<div><div style="font-size:1.5rem;font-weight:700">'+d.avgCleared+'/30</div>'+
          '<div style="font-size:.7rem;color:var(--aw-ink-3);text-transform:uppercase">Avg cleared</div></div>'+
      '</div>'+
      // Search
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">'+
        '<input id="trStatsSearch" class="aw-input" style="max-width:280px;padding:7px 11px" placeholder="Tìm Student ID hoặc tên…">'+
        '<span style="font-size:.78rem;color:var(--aw-ink-3)" id="trStatsCnt">'+d.students.length+' SV</span>'+
      '</div>'+
      // Table
      '<div style="overflow-x:auto;border:1px solid var(--aw-border-2);border-radius:var(--aw-r)">'+
        '<table style="width:100%;border-collapse:collapse;font-size:.85rem">'+
          '<thead id="trStatsThead" style="background:var(--aw-surface-2)"></thead>'+
          '<tbody id="trStatsTbl"></tbody>'+
        '</table>'+
      '</div>';

    renderHeader(); renderTable();

    var si = document.getElementById('trStatsSearch');
    if (si) si.oninput = function(){
      searchQ = si.value.trim();
      renderTable();
      var cnt = document.getElementById('trStatsCnt');
      if (cnt) cnt.textContent = sorted().length + ' SV';
    };
  });
}

