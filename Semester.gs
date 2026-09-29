/*───────────────────────────────────────────────────────────────
  ArticuWrite — End-of-semester tools (Semester.gs)
  Add as a SECOND script file in the same Apps Script project
  (Editor ▸ Files ▸ + ▸ Script ▸ name it "Semester"). It shares
  constants/helpers with Code.gs (T, sheet, readAll, samePassword…).

  Actions (routed from dispatch() in Code.gs):
    class.endSemester   report sheet → back up + clear class data
                        → (optional) archive class → email teacher
    class.listArchived  archived classes of a teacher
    class.restore       unarchive; students log in again with a clean slate

  Safety order for clearing, per tab:
    read tab → copy matching rows into the report file → flush + verify
    the copy's row count → only then rewrite the source tab without them.
  A mismatch throws before anything is removed from that tab.
───────────────────────────────────────────────────────────────*/

// Tabs whose rows belong to a class and are cleared at semester end.
//   match 'class'   → row Class = classId (or unknown class + student in class)
//   match 'student' → tab has no Class column; row Student ID in class roster
// Teacher content (Assignments, Boards, TranslateSets, Library) is kept.
// A function, not a top-level var: T is a const in Code.gs and this file may
// be evaluated before it depending on file order in the editor.
function _semPurgeList() { return [
  { tab:T.HOMEWORK,   label:'Homework',     match:'class',   backup:true  },
  { tab:T.INCLASS,    label:'In-class',     match:'class',   backup:true  },
  { tab:T.FREE,       label:'Free-writing', match:'class',   backup:true  },
  { tab:T.TR_RESULTS, label:'Translate',    match:'class',   backup:true  },
  { tab:T.QUERIES,    label:'Queries',      match:'class',   backup:true  },
  { tab:T.ANNOT,      label:'Annotations',  match:'student', backup:true  },
  { tab:T.HISTORY,    label:'History',      match:'student', backup:true  },
  { tab:T.LIVE,       label:'Live',         match:'class',   backup:false }  // transient
]; }
var SEM_BLUE = '#0A6EBD';

// ── Small helpers ──────────────────────────────────────────────
function _semTrue(v)  { return v === true || String(v).toLowerCase() === 'true'; }
function _semLow(v)   { return String(v == null ? '' : v).trim().toLowerCase(); }
function _semNum(v)   { if (v === '' || v == null) return null; var n = parseFloat(v); return isNaN(n) ? null : n; }
function _semTime(v)  { if (v instanceof Date) return v.getTime(); var t = new Date(v).getTime(); return isNaN(t) ? 0 : t; }
function _semMean(a)  { return a.length ? a.reduce(function(s, x){ return s + x; }, 0) / a.length : null; }
function _semR1(v)    { return v == null ? '' : Math.round(v * 10) / 10; }
function _semEsc(s)   { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function _semDate(t, f) { return t ? Utilities.formatDate(new Date(t), Session.getScriptTimeZone(), f || 'dd/MM/yyyy') : ''; }

function _semRead(tab) {
  var sh = sheet(tab), lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sh:sh, head:[], rows:[] };
  var v = sh.getRange(1, 1, lastRow, lastCol).getValues();
  return { sh:sh, head:v[0], rows:v.slice(1) };
}
function _semObj(head, arr) { var o = {}; for (var c = 0; c < head.length; c++) o[head[c]] = arr[c]; return o; }

/*  Re-authenticate the teacher (password) and check class ownership.
    The API has no server-side session, so a destructive action must not
    trust a bare teacherEmail from the client.                           */
function _semGuard(p) {
  var email = _semLow(p.teacherEmail);
  if (!email || !p.password) return { error:'Nhập mật khẩu giảng viên để xác nhận.' };
  var teacher = readAll(T.TEACHERS).filter(function(r){
    return _semLow(r['Email']) === email && samePassword(r['Password'], p.password);
  })[0];
  if (!teacher) return { error:'Mật khẩu không đúng.' };
  var classId = String(p.classId || '').trim();
  var cls = readAll(T.CLASSES).filter(function(r){ return String(r['Class ID']).trim() === classId; })[0];
  if (!cls) return { error:'Không tìm thấy lớp ' + classId + '.' };
  if (_semLow(cls['Teacher Email']) !== email) return { error:'Lớp này không thuộc tài khoản của bạn.' };
  return { email:email, teacherName:teacher['Name'] || '', cls:cls, classId:classId };
}

/*  Which rows belong to the class. Mirrors getResults(): a submission whose
    Class is empty/unknown still counts if the student is on this roster.   */
function _semScope(classId) {
  var known = {};
  readAll(T.CLASSES).forEach(function(c){ known[String(c['Class ID']).trim()] = true; });
  var students = readAll(T.STUDENTS).filter(function(s){ return String(s['Class']).trim() === classId; });
  var sids = {};
  students.forEach(function(s){ sids[String(s['Student ID']).trim()] = true; });
  return {
    students: students,
    byClass: function(o) {
      var rc = String(o['Class'] || '').trim();
      if (rc === classId) return true;
      return !known[rc] && !!sids[String(o['Student ID'] || '').trim()];
    },
    byStudent: function(o) { return !!sids[String(o['Student ID'] || '').trim()]; }
  };
}

function _semSetClass(classId, fields) {
  var sh = sheet(T.CLASSES), idx = headerIndex(T.CLASSES);
  Object.keys(fields).forEach(function(k){
    if (idx[k] == null) { sh.getRange(1, sh.getLastColumn() + 1).setValue(k); idx = headerIndex(T.CLASSES); }
  });
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idx['Class ID']]).trim() === classId) {
      Object.keys(fields).forEach(function(k){ sh.getRange(i + 1, idx[k] + 1).setValue(fields[k]); });
      return true;
    }
  }
  return false;
}

// ── Actions ────────────────────────────────────────────────────
function classEndSemester(p) {
  var g = _semGuard(p);
  if (g.error) return { success:false, error:g.error };
  var clear   = p.clear !== false;
  var archive = clear && p.archive !== false;   // never archive a class that still holds data

  var run = _semRun(g, clear);
  if (!run.ok) return { success:false, error:run.error, data:run.data };

  var fields = { 'Last Report': run.url };
  if (archive) { fields['Archived'] = 'true'; fields['Archived At'] = nowIso(); }
  _semSetClass(g.classId, fields);

  var emailed = _semMail(g, run, { cleared:clear, archived:archive });
  return { success:true, data:{ url:run.url, counts:run.counts, removed:run.removed,
                                cleared:clear, archived:archive, emailed:emailed } };
}

function classListArchived(p) {
  var email = _semLow(p.teacherEmail);
  if (!email) return { success:false, error:'Missing teacherEmail.' };
  var counts = {};
  readAll(T.STUDENTS).forEach(function(s){
    if (_semTrue(s['Archived'])) return;
    var c = String(s['Class']).trim(); counts[c] = (counts[c] || 0) + 1;
  });
  var rows = readAll(T.CLASSES).filter(function(r){
    return _semTrue(r['Archived']) && _semLow(r['Teacher Email']) === email;
  });
  return { success:true, data: rows.map(function(r){
    var id = String(r['Class ID']).trim();
    return { classId:id, className:r['Class Name'], year:r['Academic Year'], semester:r['Semester'],
             archivedAt:r['Archived At'] || '', reportUrl:r['Last Report'] || '', students:counts[id] || 0 };
  }) };
}

/*  Reactivate: students of the class can log in again, with no scores.
    A class archived by the old plain "Archive" button may still hold data;
    that data is backed up + cleared first so the promise "như mới" holds.  */
function classRestore(p) {
  var g = _semGuard(p);
  if (g.error) return { success:false, error:g.error };
  if (!_semTrue(g.cls['Archived'])) return { success:false, error:'Lớp này đang hoạt động.' };

  var scope = _semScope(g.classId), leftover = 0;
  _semPurgeList().forEach(function(t){
    if (!t.backup) return;
    var d = _semRead(t.tab), fn = t.match === 'class' ? scope.byClass : scope.byStudent;
    d.rows.forEach(function(r){ if (fn(_semObj(d.head, r))) leftover++; });
  });

  var run = null;
  if (leftover) {
    run = _semRun(g, true);
    if (!run.ok) return { success:false, error:run.error, data:run.data };
    _semMail(g, run, { cleared:true, archived:false, restored:true });
  }
  var fields = { 'Archived':'', 'Archived At':'' };
  if (run) fields['Last Report'] = run.url;
  _semSetClass(g.classId, fields);

  var active = scope.students.filter(function(s){ return !_semTrue(s['Archived']); }).length;
  return { success:true, data:{ classId:g.classId, students:active, leftoverCleared:leftover,
                                url: run ? run.url : '' } };
}

// ── Pipeline ───────────────────────────────────────────────────
function _semRun(g, clear) {
  var scope = _semScope(g.classId);
  var snap = {};
  [T.HOMEWORK, T.INCLASS, T.FREE].forEach(function(tab){
    var d = _semRead(tab);
    snap[tab] = d.rows.map(function(r){ return _semObj(d.head, r); }).filter(scope.byClass);
  });
  var assigns = readAll(T.ASSIGN).filter(function(a){ return String(a['Class']).trim() === g.classId; });

  var stats = _semStats(scope, snap, assigns);
  var book  = _semReport(g, stats);
  var url   = book.getUrl();
  _semShare(book, g.email);

  var counts = {}, removed = 0;
  if (clear) {
    // Same script lock as saveResult(): no submission can land mid-rewrite.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000))
      return { ok:false, error:'Server đang bận (sinh viên đang nộp bài). Báo cáo đã tạo nhưng CHƯA xoá dữ liệu — thử lại sau ít phút.', data:{ url:url } };
    try {
      _semPurgeList().forEach(function(t){
        var n = _semPurge(t.tab, t.match === 'class' ? scope.byClass : scope.byStudent, t.backup ? book : null, t.label);
        counts[t.label] = n; removed += n;
      });
    } catch (err) {
      return { ok:false, error:'Dừng giữa chừng: ' + err.message + ' Phần đã xoá đều có bản sao trong file báo cáo.',
               data:{ url:url, counts:counts } };
    } finally { try { lock.releaseLock(); } catch (e) {} }
  }
  return { ok:true, url:url, stats:stats, counts:counts, removed:removed };
}

/*  Remove matching rows from one tab. Rows above the first match are left
    untouched; from there down the block is rewritten without the matches
    and the emptied tail is deleted in ONE call (deleting rows one by one
    would blow the 6-minute limit on a few thousand interleaved rows).    */
function _semPurge(tab, matchFn, book, label) {
  var d = _semRead(tab), keep = [], gone = [], first = -1;
  d.rows.forEach(function(r, i){
    if (matchFn(_semObj(d.head, r))) { gone.push(r); if (first < 0) first = i; }
    else if (first >= 0) keep.push(r);
  });
  if (!gone.length) return 0;
  var width = d.head.length;

  if (book) {
    var bsh = book.insertSheet('🗄 ' + label, book.getNumSheets());
    ['Student ID', 'Phone'].forEach(function(c){
      var ci = d.head.indexOf(c);
      if (ci > -1) bsh.getRange(1, ci + 1, gone.length + 1, 1).setNumberFormat('@');
    });
    bsh.getRange(1, 1, 1, width).setValues([d.head]);
    bsh.getRange(2, 1, gone.length, width).setValues(gone);
    bsh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground(SEM_BLUE).setFontColor('#FFFFFF');
    bsh.setFrozenRows(1);
    SpreadsheetApp.flush();
    if (bsh.getLastRow() - 1 !== gone.length)
      throw new Error('Bản sao "' + label + '" không khớp số dòng (' + (bsh.getLastRow() - 1) + '/' + gone.length + '), tab này chưa bị xoá.');
  }

  var sh = d.sh, startRow = first + 2;
  sh.getRange(startRow, 1, keep.length + gone.length, width).clearContent();
  if (keep.length) sh.getRange(startRow, 1, keep.length, width).setValues(keep);
  // Sheets refuses to delete every non-frozen row; keep one spare if needed.
  if (sh.getMaxRows() - gone.length <= sh.getFrozenRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
  sh.deleteRows(startRow + keep.length, gone.length);
  SpreadsheetApp.flush();
  return gone.length;
}

// ── Statistics ─────────────────────────────────────────────────
function _semStats(scope, snap, assigns) {
  var S = {}, topics = {};
  function stu(sid, name) {
    if (!S[sid]) S[sid] = { sid:sid, name:'', hw:{}, ic:{}, free:0, total:0, scores:[], teacher:[], topics:{}, last:0 };
    if (!S[sid].name && name) S[sid].name = String(name);
    return S[sid];
  }
  scope.students.forEach(function(s){
    if (!_semTrue(s['Archived'])) stu(String(s['Student ID']).trim(), s['Name']);
  });

  var hwAssigned = 0, icAssigned = 0;
  assigns.forEach(function(a){
    if (a['Active'] === false || _semLow(a['Active']) === 'false') return;
    var mode = a['Mode'] === 'inclass' ? 'inclass' : 'homework';
    if (mode === 'homework') hwAssigned++; else icAssigned++;
    var key = mode + '||' + String(a['Topic ID']).trim();
    topics[key] = { mode:mode, topic:a['Topic'] || '', taskType:a['Task Type'] || 'task2',
                    t:_semTime(a['CreatedAt']), deadline:a['Deadline'] || '', assigned:true,
                    students:{}, subs:0, firsts:[], bests:[] };
  });

  var modeOf = {}; modeOf[T.HOMEWORK] = 'homework'; modeOf[T.INCLASS] = 'inclass'; modeOf[T.FREE] = 'free';
  var modeTotals = { homework:0, inclass:0, free:0 };
  Object.keys(snap).forEach(function(tab){
    var mode = modeOf[tab];
    snap[tab].forEach(function(r){
      var sid = String(r['Student ID'] || '').trim();
      if (!sid) return;
      var st = stu(sid, r['Name']), t = _semTime(r['Timestamp']), ai = _semNum(r['AI Grading']);
      var tg = _semNum(r['Teacher Grading']);
      if (tg === null && r['Teacher Score']) { try { tg = _semNum(JSON.parse(r['Teacher Score']).overall); } catch (e) {} }
      st.total++; modeTotals[mode]++;
      if (t > st.last) st.last = t;
      if (ai !== null) st.scores.push(ai);
      if (tg !== null) st.teacher.push(tg);
      if (mode === 'free') { st.free++; return; }

      var tid = String(r['Topic ID'] || '').trim(), key = mode + '||' + tid;
      (mode === 'homework' ? st.hw : st.ic)[tid] = true;
      var tp = st.topics[key] || (st.topics[key] = { t:t, attempts:[] });
      if (t && (!tp.t || t < tp.t)) tp.t = t;
      tp.attempts.push({ t:t, ai:ai });
      var ti = topics[key] || (topics[key] = { mode:mode, topic:r['Topic'] || '', taskType:r['Task Type'] || 'task2',
                                               t:t, deadline:'', assigned:false, students:{}, subs:0, firsts:[], bests:[] });
      if (!ti.assigned && t && (!ti.t || t < ti.t)) ti.t = t;
      ti.subs++; ti.students[sid] = true;
    });
  });

  var list = Object.keys(S).map(function(sid){
    var st = S[sid];
    var per = Object.keys(st.topics).map(function(key){
      var a = st.topics[key].attempts.filter(function(x){ return x.ai !== null; })
                                     .sort(function(x, y){ return x.t - y.t; });
      if (!a.length) return null;
      var best = Math.max.apply(null, a.map(function(x){ return x.ai; }));
      topics[key].firsts.push(a[0].ai); topics[key].bests.push(best);
      return { t:st.topics[key].t, first:a[0].ai, last:a[a.length - 1].ai, best:best, n:a.length };
    }).filter(Boolean).sort(function(x, y){ return x.t - y.t; });

    var bests = per.map(function(x){ return x.best; });
    var h = Math.floor(bests.length / 2);
    var early = h ? _semMean(bests.slice(0, h)) : null;
    var late  = h ? _semMean(bests.slice(bests.length - h)) : null;
    var gains = per.filter(function(x){ return x.n >= 2; }).map(function(x){ return x.last - x.first; });
    var hwDone = Object.keys(st.hw).length;
    return {
      sid:sid, name:st.name, hwDone:hwDone, hwAssigned:hwAssigned,
      completion: hwAssigned ? Math.min(1, hwDone / hwAssigned) : null,
      icDone:Object.keys(st.ic).length, free:st.free, total:st.total,
      avg:_semMean(bests), best: st.scores.length ? Math.max.apply(null, st.scores) : null,
      teacherAvg:_semMean(st.teacher), early:early, late:late,
      progress: h ? late - early : null, revision:_semMean(gains), last:st.last
    };
  });

  // Diligence = total submissions, tie → HW completion. Competition ranking.
  list.sort(function(a, b){
    return (b.total - a.total) || ((b.completion || 0) - (a.completion || 0)) || String(a.name).localeCompare(String(b.name));
  });
  list.forEach(function(s, i){
    var prev = list[i - 1];
    s.dRank = (prev && prev.total === s.total && (prev.completion || 0) === (s.completion || 0)) ? prev.dRank : i + 1;
  });
  var prog = list.filter(function(s){ return s.progress !== null; })
                 .sort(function(a, b){ return b.progress - a.progress; });
  prog.forEach(function(s, i){
    var prev = prog[i - 1];
    s.pRank = (prev && Math.abs(prev.progress - s.progress) < 0.005) ? prev.pRank : i + 1;
  });
  list.forEach(function(s){ s.comment = _semComment(s); });

  var topicList = Object.keys(topics).map(function(k){
    var ti = topics[k];
    return { t:ti.t, topic:ti.topic, mode:ti.mode, taskType:ti.taskType, deadline:ti.deadline,
             students:Object.keys(ti.students).length, subs:ti.subs,
             avgFirst:_semMean(ti.firsts), avgBest:_semMean(ti.bests) };
  }).sort(function(a, b){ return a.t - b.t; });

  var active = list.filter(function(s){ return s.total > 0; });
  return {
    list:list, prog:prog, topics:topicList, hwAssigned:hwAssigned, icAssigned:icAssigned,
    nStudents:list.length, nActive:active.length, modeTotals:modeTotals,
    totalSubs: modeTotals.homework + modeTotals.inclass + modeTotals.free,
    classAvg:_semMean(list.filter(function(s){ return s.avg !== null; }).map(function(s){ return s.avg; })),
    completionAvg:_semMean(list.filter(function(s){ return s.completion !== null; }).map(function(s){ return s.completion; })),
    progressAvg:_semMean(prog.map(function(s){ return s.progress; })),
    watch: list.filter(function(s){ return s.total === 0 || (s.completion !== null && s.completion < 0.5); })
  };
}

function _semComment(s) {
  if (!s.total) return '❌ Chưa nộp bài nào trong học kỳ.';
  var parts = [];
  if (s.completion !== null) {
    if (s.completion >= 0.9)      parts.push('🌟 Hoàn thành gần như toàn bộ Homework');
    else if (s.completion >= 0.6) parts.push('👍 Hoàn thành phần lớn Homework');
    else                          parts.push('⚠️ Còn thiếu nhiều Homework (' + s.hwDone + '/' + s.hwAssigned + ')');
  }
  if (s.progress === null)        parts.push('ℹ️ Chưa đủ bài có điểm để đánh giá tiến bộ');
  else if (s.progress >= 0.5)     parts.push('📈 Tiến bộ rõ rệt (+' + s.progress.toFixed(1) + ' band)');
  else if (s.progress >= 0.2)     parts.push('↗️ Có tiến bộ (+' + s.progress.toFixed(1) + ' band)');
  else if (s.progress <= -0.5)    parts.push('📉 Điểm giảm ở nửa cuối học kỳ (' + s.progress.toFixed(1) + ' band)');
  else                            parts.push('➡️ Điểm ổn định');
  if (s.revision !== null && s.revision >= 0.5) parts.push('✍️ Viết lại hiệu quả (+' + s.revision.toFixed(1) + '/đề)');
  if (s.free >= 3) parts.push('💪 Chủ động luyện Free writing (' + s.free + ' bài)');
  return parts.join(' · ');
}

// ── Report spreadsheet ─────────────────────────────────────────
function _semReport(g, st) {
  var c = g.cls;
  var name = 'ArticuWrite_TongKet_' + String(c['Class Name'] || g.classId).replace(/[\\\/:*?"<>|]/g, '-') +
             '_' + g.classId + '_' + _semDate(Date.now(), 'yyyy-MM-dd');
  var book = SpreadsheetApp.create(name);
  try { DriveApp.getFileById(book.getId()).moveTo(DriveApp.getFolderById(FEEDBACK_FOLDER_ID)); } catch (e) {}

  _semOverviewSheet(book.getSheets()[0], g, st);
  _semStudentSheet(book.insertSheet('👩‍🎓 Sinh viên', book.getNumSheets()), st);
  _semTopicSheet(book.insertSheet('📝 Theo bài', book.getNumSheets()), st);
  _semChartSheet(book.insertSheet('📈 Biểu đồ', book.getNumSheets()), st);
  SpreadsheetApp.flush();
  return book;
}

function _semOverviewSheet(sh, g, st) {
  sh.setName('📊 Tổng quan');
  var c = g.cls, W = 5, rows = [], marks = [];
  function add(r, type) { while (r.length < W) r.push(''); rows.push(r); if (type) marks.push({ i:rows.length, type:type }); }
  function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }
  function sign(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1); }

  add(['📘 ArticuWrite — Báo cáo tổng kết học kỳ'], 'title');
  add(['🏫 Lớp ' + (c['Class Name'] || '') + ' (' + g.classId + ')' +
       (c['Academic Year'] ? ' · Năm học ' + c['Academic Year'] : '') +
       (c['Semester'] ? ' · HK' + c['Semester'] : '')], 'sub');
  add(['🗓 Xuất ngày ' + _semDate(Date.now(), 'dd/MM/yyyy HH:mm') + ' · GV: ' + (g.teacherName || g.email)], 'sub');
  add([]);
  add(['📌 Chỉ số chính'], 'section');
  add(['👩‍🎓 Số sinh viên', st.nStudents]);
  add(['✅ SV có nộp bài', st.nActive + ' (' + pct(st.nStudents ? st.nActive / st.nStudents : null) + ')']);
  add(['📋 Homework đã giao', st.hwAssigned]);
  add(['🏫 In-class đã giao', st.icAssigned]);
  add(['📝 Tổng lượt nộp', st.totalSubs + '  (HW ' + st.modeTotals.homework + ' · In-class ' +
       st.modeTotals.inclass + ' · Free ' + st.modeTotals.free + ')']);
  add(['⭐ Điểm TB cả lớp (band)', st.classAvg == null ? '—' : st.classAvg.toFixed(1)]);
  add(['🎯 Hoàn thành Homework TB', pct(st.completionAvg)]);
  add(['📈 Tiến bộ TB cả lớp', sign(st.progressAvg)]);
  add([]);

  add(['🏆 Top 5 siêng năng'], 'section');
  add(['Hạng', 'Họ tên', 'MSSV', 'Lượt nộp', '% HW'], 'thead');
  st.list.slice(0, 5).forEach(function(s){ add([s.dRank, s.name, s.sid, s.total, pct(s.completion)]); });
  add([]);

  add(['🚀 Top 5 tiến bộ'], 'section');
  add(['Hạng', 'Họ tên', 'MSSV', 'Tiến bộ', 'Điểm cuối HK'], 'thead');
  if (!st.prog.length) add(['—', 'Chưa đủ dữ liệu (cần ≥2 đề có điểm)']);
  st.prog.slice(0, 5).forEach(function(s){ add([s.pRank, s.name, s.sid, sign(s.progress), _semR1(s.late)]); });
  add([]);

  add(['🔔 Cần quan tâm (chưa nộp bài hoặc HW < 50%)'], 'section');
  add(['', 'Họ tên', 'MSSV', 'Lượt nộp', '% HW'], 'thead');
  if (!st.watch.length) add(['🎉', 'Không có sinh viên nào']);
  st.watch.slice(0, 20).forEach(function(s){ add(['•', s.name, s.sid, s.total, pct(s.completion)]); });
  add([]);

  add(['ℹ️ Cách tính'], 'section');
  add(['• Điểm = AI Grading (band 0–9). Điểm TB của SV = trung bình bài tốt nhất mỗi đề (Homework + In-class).'], 'note');
  add(['• Siêng năng = tổng lượt nộp (Homework + In-class + Free writing); bằng nhau thì xét % hoàn thành Homework.'], 'note');
  add(['• Tiến bộ HK = điểm TB nửa cuối học kỳ − nửa đầu học kỳ (theo thứ tự thời gian các đề). Cần ≥2 đề có điểm.'], 'note');
  add(['• Viết lại hiệu quả = trung bình (lần cuối − lần đầu) trong cùng một đề.'], 'note');
  add(['• Các tab 🗄 là bản sao nguyên gốc toàn bộ dữ liệu đã xoá khỏi ArticuWrite (kể cả bài viết).'], 'note');

  sh.getRange(1, 1, rows.length, W).setValues(rows).setVerticalAlignment('middle');
  sh.setColumnWidth(1, 230); sh.setColumnWidth(2, 260);
  sh.setColumnWidths(3, 3, 120);
  marks.forEach(function(m){
    var r = sh.getRange(m.i, 1, 1, W);
    if (m.type === 'title')   { r.merge().setFontSize(16).setFontWeight('bold').setBackground(SEM_BLUE).setFontColor('#FFFFFF'); sh.setRowHeight(m.i, 42); }
    if (m.type === 'sub')     { r.merge().setFontColor('#475467').setBackground('#EAF4FC'); }
    if (m.type === 'section') { r.merge().setFontSize(12).setFontWeight('bold').setFontColor(SEM_BLUE); sh.setRowHeight(m.i, 28); }
    if (m.type === 'thead')   { r.setFontWeight('bold').setBackground('#EAF4FC'); }
    if (m.type === 'note')    { r.merge().setWrap(true).setFontColor('#475467').setFontSize(9); }
  });
  sh.getRange(6, 1, 8, 1).setFontWeight('bold');
  sh.setHiddenGridlines(true);
}

function _semStudentSheet(sh, st) {
  var head = ['Hạng siêng năng', 'MSSV', 'Họ tên', 'HW đã làm', 'HW được giao', '% hoàn thành HW',
              'In-class đã làm', 'Free writing', 'Tổng lượt nộp', 'Điểm TB', 'Điểm cao nhất', 'Điểm GV TB',
              'Điểm nửa đầu HK', 'Điểm nửa cuối HK', 'Tiến bộ HK', 'Hạng tiến bộ', 'Viết lại hiệu quả',
              'Lần nộp cuối', 'Nhận xét'];
  var data = st.list.map(function(s){
    return [s.dRank, s.sid, s.name, s.hwDone, s.hwAssigned, s.completion == null ? '' : s.completion,
            s.icDone, s.free, s.total, _semR1(s.avg), _semR1(s.best), _semR1(s.teacherAvg),
            _semR1(s.early), _semR1(s.late), s.progress == null ? '' : Math.round(s.progress * 100) / 100,
            s.pRank || '', s.revision == null ? '' : Math.round(s.revision * 100) / 100,
            _semDate(s.last, 'dd/MM/yyyy'), s.comment];
  });
  var n = data.length, W = head.length;
  sh.getRange(1, 2, Math.max(n, 1) + 1, 1).setNumberFormat('@');
  sh.getRange(1, 1, 1, W).setValues([head]);
  _semHead(sh.getRange(1, 1, 1, W));
  sh.setRowHeight(1, 40);
  sh.setFrozenRows(1); sh.setFrozenColumns(3);
  if (!n) return;
  sh.getRange(2, 1, n, W).setValues(data).setVerticalAlignment('middle');
  sh.getRange(2, 6, n, 1).setNumberFormat('0%');
  sh.getRange(2, 10, n, 5).setNumberFormat('0.0');
  sh.getRange(2, 15, n, 1).setNumberFormat('+0.0;-0.0;0.0');
  sh.getRange(2, 17, n, 1).setNumberFormat('+0.0;-0.0;0.0');
  sh.getRange(2, 19, n, 1).setWrap(true);
  sh.getRange(1, 1, n + 1, W).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  sh.setConditionalFormatRules([
    _semScale(sh.getRange(2, 6, n, 1), '#FDE2E1', '#FFFFFF', '#D1FADF', 0.5),
    _semScale(sh.getRange(2, 9, n, 1), '#FFFFFF', null, '#CFE6F8', null),
    _semScale(sh.getRange(2, 15, n, 1), '#FDE2E1', '#FFFFFF', '#D1FADF', 0)
  ]);
  sh.setColumnWidth(1, 80); sh.setColumnWidth(2, 110); sh.setColumnWidth(3, 190);
  sh.setColumnWidths(4, 15, 92); sh.setColumnWidth(19, 460);
  sh.getRange(1, 1, n + 1, 18).setHorizontalAlignment('center');
  sh.getRange(2, 3, n, 1).setHorizontalAlignment('left');
}

function _semTopicSheet(sh, st) {
  var head = ['Ngày giao', 'Đề bài', 'Loại', 'Task', 'Hạn nộp', 'SV đã nộp', '% lớp',
              'Tổng lượt nộp', 'Điểm TB lần 1', 'Điểm TB tốt nhất', 'Cải thiện TB'];
  var data = st.topics.map(function(t){
    return [_semDate(t.t), t.topic, t.mode === 'homework' ? '📋 Homework' : '🏫 In-class',
            t.taskType === 'task1' ? 'Task 1' : 'Task 2',
            t.deadline instanceof Date ? _semDate(t.deadline.getTime()) : String(t.deadline || ''),
            t.students, st.nStudents ? t.students / st.nStudents : '', t.subs,
            _semR1(t.avgFirst), _semR1(t.avgBest),
            (t.avgFirst == null || t.avgBest == null) ? '' : Math.round((t.avgBest - t.avgFirst) * 100) / 100];
  });
  var n = data.length, W = head.length;
  sh.getRange(1, 1, 1, W).setValues([head]);
  _semHead(sh.getRange(1, 1, 1, W));
  sh.setFrozenRows(1);
  if (!n) return;
  sh.getRange(2, 1, n, W).setValues(data);
  sh.getRange(2, 7, n, 1).setNumberFormat('0%');
  sh.getRange(2, 9, n, 2).setNumberFormat('0.0');
  sh.getRange(2, 11, n, 1).setNumberFormat('+0.0;-0.0;0.0');
  sh.getRange(2, 2, n, 1).setWrap(true);
  sh.getRange(1, 1, n + 1, W).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  sh.setConditionalFormatRules([_semScale(sh.getRange(2, 7, n, 1), '#FDE2E1', '#FFFFFF', '#D1FADF', 0.5)]);
  sh.setColumnWidth(1, 90); sh.setColumnWidth(2, 380); sh.setColumnWidths(3, 9, 100);
}

/*  Chart data lives on this sheet (sorted copies) so each chart is a plain
    contiguous range; charts sit to the right, stacked.                     */
function _semChartSheet(sh, st) {
  var nextRow = 1, CH_COL = 10;
  function place(chartRange, title, type, count, color, vTitle) {
    var height = type === Charts.ChartType.BAR ? Math.max(320, count * 24 + 90) : 380;
    var chart = sh.newChart().setChartType(type).addRange(chartRange).setNumHeaders(1)
      .setPosition(nextRow, CH_COL, 0, 0)
      .setOption('title', title).setOption('legend', { position:'none' })
      .setOption('colors', [color]).setOption('width', 720).setOption('height', height)
      .setOption(type === Charts.ChartType.BAR ? 'hAxis' : 'vAxis', { title:vTitle })
      .build();
    sh.insertChart(chart);
    nextRow += Math.ceil(height / 21) + 2;
  }

  var dil = st.list.map(function(s){ return [s.name || s.sid, s.total]; });
  sh.getRange(1, 1, 1, 2).setValues([['Sinh viên', 'Tổng lượt nộp']]);
  if (dil.length) sh.getRange(2, 1, dil.length, 2).setValues(dil);

  var prog = st.prog.map(function(s){ return [s.name || s.sid, Math.round(s.progress * 100) / 100]; });
  sh.getRange(1, 4, 1, 2).setValues([['Sinh viên', 'Tiến bộ HK (band)']]);
  if (prog.length) sh.getRange(2, 4, prog.length, 2).setValues(prog);

  var trend = st.topics.filter(function(t){ return t.avgBest != null; })
                       .map(function(t){ return [t.topic, Math.round(t.avgBest * 100) / 100]; });
  sh.getRange(1, 7, 1, 2).setValues([['Đề (theo thời gian)', 'Điểm TB tốt nhất']]);
  if (trend.length) sh.getRange(2, 7, trend.length, 2).setValues(trend);

  _semHead(sh.getRange(1, 1, 1, 8));
  sh.setColumnWidths(1, 8, 120);
  sh.setFrozenRows(1);

  if (dil.length)   place(sh.getRange(1, 1, dil.length + 1, 2),  '🏆 Xếp hạng siêng năng (tổng lượt nộp)', Charts.ChartType.BAR, dil.length, SEM_BLUE, 'Lượt nộp');
  if (prog.length)  place(sh.getRange(1, 4, prog.length + 1, 2), '🚀 Xếp hạng tiến bộ (nửa cuối − nửa đầu HK)', Charts.ChartType.BAR, prog.length, '#12B76A', 'Band');
  if (trend.length) place(sh.getRange(1, 7, trend.length + 1, 2), '📈 Tiến trình cả lớp qua các đề', Charts.ChartType.LINE, trend.length, '#F79009', 'Band');
}

function _semHead(r) {
  r.setFontWeight('bold').setBackground(SEM_BLUE).setFontColor('#FFFFFF')
   .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
}
function _semScale(range, lo, mid, hi, midVal) {
  var b = SpreadsheetApp.newConditionalFormatRule().setRanges([range]).setGradientMinpoint(lo).setGradientMaxpoint(hi);
  if (mid) b.setGradientMidpointWithValue(mid, SpreadsheetApp.InterpolationType.NUMBER, String(midVal));
  return b.build();
}

/*  The script runs as the deploying account, which owns the file. Another
    teacher gets edit access by email; only if that fails (non-Google
    address) fall back to view-by-link, same as exportResultsSheet().     */
function _semShare(book, email) {
  var file = DriveApp.getFileById(book.getId()), me = '';
  try { me = _semLow(Session.getEffectiveUser().getEmail()); } catch (e) {}
  if (!email || email === me) return;
  try { file.addEditor(email); }
  catch (e) { try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e2) {} }
}

// ── Email ──────────────────────────────────────────────────────
function _semMail(g, run, o) {
  var st = run.stats, c = g.cls, cname = c['Class Name'] || g.classId;
  function kpi(icon, label, val) {
    return '<td style="padding:10px;border:1px solid #E4E7EC;border-radius:10px;text-align:center;width:33%">' +
           '<div style="font-size:20px">' + icon + '</div><div style="font-size:20px;font-weight:bold;color:' + SEM_BLUE + '">' +
           _semEsc(val) + '</div><div style="font-size:12px;color:#667085">' + label + '</div></td>';
  }
  function top(arr, fmt) {
    if (!arr.length) return '<i style="color:#667085">Chưa đủ dữ liệu</i>';
    return arr.slice(0, 3).map(function(s, i){
      return ['🥇', '🥈', '🥉'][i] + ' ' + _semEsc(s.name || s.sid) + ' <span style="color:#667085">(' + fmt(s) + ')</span>';
    }).join('<br>');
  }
  var removedLine = Object.keys(run.counts).filter(function(k){ return run.counts[k]; })
                      .map(function(k){ return k + ' ' + run.counts[k]; }).join(' · ');
  var status = '';
  if (o.cleared) status += '<p>🧹 Đã dọn <b>' + run.removed + '</b> dòng dữ liệu của lớp' +
                           (removedLine ? ' (' + _semEsc(removedLine) + ')' : '') +
                           '. Bản sao đầy đủ, kể cả bài viết, nằm trong các tab 🗄 của file báo cáo.</p>';
  if (o.archived) status += '<p>🗃 Lớp đã được <b>lưu trữ</b>: sinh viên không đăng nhập được nữa. Khi dạy lại lớp này, vào ' +
                            '<i>Settings ▸ Lớp đã lưu trữ ▸ Kích hoạt lại</i>, tài khoản sinh viên sẽ hoạt động lại như mới.</p>';
  if (o.restored) status += '<p>♻️ Lớp đã được <b>kích hoạt lại</b>. Dữ liệu cũ còn sót đã được sao lưu vào báo cáo này rồi xoá.</p>';

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;border:1px solid #E4E7EC;border-radius:14px;overflow:hidden;color:#10222E">' +
      '<div style="background:' + SEM_BLUE + ';color:#fff;padding:20px 24px">' +
        '<div style="font-size:20px;font-weight:bold">🎓 Tổng kết học kỳ — ' + _semEsc(cname) + '</div>' +
        '<div style="font-size:13px;opacity:.85;margin-top:4px">Mã lớp ' + _semEsc(g.classId) +
          (c['Academic Year'] ? ' · Năm học ' + _semEsc(c['Academic Year']) : '') + (c['Semester'] ? ' · HK' + _semEsc(c['Semester']) : '') + '</div>' +
      '</div>' +
      '<div style="padding:20px 24px;font-size:14px;line-height:1.6">' +
        '<p>Chào thầy/cô ' + _semEsc(g.teacherName) + ' 👋</p>' +
        '<p>ArticuWrite đã tạo xong bảng tổng kết học kỳ cho lớp <b>' + _semEsc(cname) + '</b>.</p>' +
        '<table style="width:100%;border-collapse:separate;border-spacing:6px;margin:8px 0"><tr>' +
          kpi('👩‍🎓', 'Sinh viên', st.nStudents) + kpi('📝', 'Lượt nộp bài', st.totalSubs) +
          kpi('⭐', 'Điểm TB (band)', st.classAvg == null ? '—' : st.classAvg.toFixed(1)) +
        '</tr></table>' +
        '<table style="width:100%;margin:8px 0"><tr>' +
          '<td style="vertical-align:top;width:50%;padding-right:8px"><b>🏆 Siêng năng nhất</b><br>' +
            top(st.list.filter(function(s){ return s.total > 0; }), function(s){ return s.total + ' lượt'; }) + '</td>' +
          '<td style="vertical-align:top;width:50%"><b>🚀 Tiến bộ nhất</b><br>' +
            top(st.prog, function(s){ return (s.progress >= 0 ? '+' : '') + s.progress.toFixed(1) + ' band'; }) + '</td>' +
        '</tr></table>' +
        (st.watch.length ? '<p>🔔 <b>' + st.watch.length + '</b> sinh viên cần quan tâm (chưa nộp bài hoặc Homework dưới 50%). Xem chi tiết trong báo cáo.</p>' : '') +
        status +
        '<p style="text-align:center;margin:22px 0">' +
          '<a href="' + run.url + '" style="background:' + SEM_BLUE + ';color:#fff;text-decoration:none;padding:12px 26px;border-radius:10px;font-weight:bold;display:inline-block">📊 Mở bảng tổng kết</a></p>' +
        '<p style="font-size:12px;color:#667085">Báo cáo gồm: 📊 Tổng quan · 👩‍🎓 Sinh viên (xếp hạng + nhận xét) · 📝 Theo bài · 📈 Biểu đồ · 🗄 Dữ liệu gốc.</p>' +
      '</div>' +
      '<div style="background:#F9FAFB;padding:12px 24px;font-size:12px;color:#98A2B3">— ArticuWrite ✍️</div>' +
    '</div>';
  try {
    MailApp.sendEmail({ to:g.email, name:'ArticuWrite',
      subject:'🎓 [ArticuWrite] Tổng kết học kỳ — ' + cname + ' (' + g.classId + ')',
      htmlBody:html, body:'Bảng tổng kết học kỳ lớp ' + cname + ': ' + run.url });
    return true;
  } catch (e) { return false; }
}
