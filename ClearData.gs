/*───────────────────────────────────────────────────────────────
  ArticuWrite — Clear assignment data (ClearData.gs)
  Add as a script file in the same Apps Script project as Code.gs
  and Semester.gs (uses their helpers: T, sheet, readAll, readColumns,
  exportFeedbackDoc, _semEsc, _semShare, _semHead, _semScale …).

  Purpose: keep the Homework / In-class tabs light during the semester.
  Scores stay in the sheet (Results keeps working for teacher + students);
  the heavy Essay + Feedback text moves into each student's Google Doc.

  Flow
    assign.clearData  → mark assignment 'clearing' (no more submissions),
                        queue it, schedule clearDataWorker in 1 minute.
    clearDataWorker   → time-driven, ~4.5 min per run, re-schedules itself:
                        per student: exportFeedbackDoc() → verify the Doc
                        holds every attempt → blank Essay/Feedback, mark
                        rows 'Data Cleared' = 1, store the Doc URL.
                        When every student is done: summary sheet → email
                        teacher → assignment 'cleared'.
  A student's text is blanked only after their Doc is verified; a student
  whose Doc fails 3 times keeps their text and is flagged in the report.

  Needs scope https://www.googleapis.com/auth/script.scriptapp (triggers).
───────────────────────────────────────────────────────────────*/

var CD_QUEUE_KEY  = 'AW_CLEAR_QUEUE';
var CD_RUN_KEY    = 'AW_CLEAR_RUNNING';
var CD_BUDGET_MS  = 4.5 * 60 * 1000;   // Apps Script hard limit is 6 min
var CD_FINISH_MS  = 90 * 1000;         // time kept back for building the report
var CD_MAX_FAILS  = 3;

function _cdTab(mode) { return mode === 'homework' ? T.HOMEWORK : (mode === 'inclass' ? T.INCLASS : null); }
function _cdCleared(v) { return String(v == null ? '' : v) === '1'; }
function _cdDocUrl(r) {
  if (r['Feedback Doc URL']) return String(r['Feedback Doc URL']);
  return r['Feedback Doc ID'] ? 'https://docs.google.com/document/d/' + r['Feedback Doc ID'] + '/edit' : '';
}

// ── Action ─────────────────────────────────────────────────────
function assignClearData(p) {
  var topicId = String(p.topicId || '').trim(), email = _semLow(p.teacherEmail);
  if (!topicId || !email) return { success:false, error:'Missing topicId / teacherEmail.' };
  var a = readAll(T.ASSIGN).filter(function(r){ return String(r['Topic ID']).trim() === topicId; })[0];
  if (!a) return { success:false, error:'Không tìm thấy bài tập.' };
  var mode = String(a['Mode'] || 'homework');
  var tab = _cdTab(mode);
  if (!tab) return { success:false, error:'Clear Data chỉ áp dụng cho Homework / In-class.' };
  var cls = readAll(T.CLASSES).filter(function(c){ return String(c['Class ID']).trim() === String(a['Class']).trim(); })[0];
  if (!cls || _semLow(cls['Teacher Email']) !== email) return { success:false, error:'Bài tập này không thuộc lớp của bạn.' };
  if (String(a['Data Status'] || '') === 'clearing')
    return { success:true, data:{ status:'clearing', already:true } };

  var sids = {};
  readColumns(tab, ['Student ID', 'Topic ID']).forEach(function(r){
    if (String(r['Topic ID']).trim() === topicId && r['Student ID']) sids[String(r['Student ID']).trim()] = true;
  });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success:false, error:'Server đang bận, thử lại sau vài giây.' };
  try {
    _cdSetAssign(topicId, { 'Data Status':'clearing', 'Data Clear Requested':nowIso() });
    var q = _cdQueue().filter(function(j){ return j.topicId !== topicId; });
    q.push({ topicId:topicId, mode:mode, email:email, at:nowIso(), fails:{} });
    _cdSaveQueue(q);
  } finally { try { lock.releaseLock(); } catch (e) {} }

  _cdSchedule(1);
  return { success:true, data:{ status:'clearing', students:Object.keys(sids).length } };
}

// ── Queue + trigger plumbing ───────────────────────────────────
function _cdQueue() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(CD_QUEUE_KEY) || '[]'); }
  catch (e) { return []; }
}
function _cdSaveQueue(q) { PropertiesService.getScriptProperties().setProperty(CD_QUEUE_KEY, JSON.stringify(q)); }
function _cdUpdateJob(job, remove) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var q = _cdQueue().filter(function(j){ return j.topicId !== job.topicId; });
    if (!remove) q.unshift(job);
    _cdSaveQueue(q);
  } finally { lock.releaseLock(); }
}
function _cdClearTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'clearDataWorker') ScriptApp.deleteTrigger(t);
  });
}
function _cdSchedule(minutes) {
  _cdClearTriggers();
  ScriptApp.newTrigger('clearDataWorker').timeBased().after(minutes * 60 * 1000).create();
}

function _cdSetAssign(topicId, fields) {
  var sh = sheet(T.ASSIGN), idx = headerIndex(T.ASSIGN);
  Object.keys(fields).forEach(function(k){
    if (idx[k] == null) { sh.getRange(1, sh.getLastColumn() + 1).setValue(k); idx = headerIndex(T.ASSIGN); }
  });
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idx['Topic ID']]).trim() === topicId) {
      Object.keys(fields).forEach(function(k){ sh.getRange(i + 1, idx[k] + 1).setValue(fields[k]); });
      return true;
    }
  }
  return false;
}

// ── Worker (time-driven trigger) ───────────────────────────────
function clearDataWorker() {
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var running = parseInt(props.getProperty(CD_RUN_KEY) || '0', 10);
  if (running && t0 - running < 6.5 * 60 * 1000) { _cdSchedule(5); return; }  // another run is alive
  props.setProperty(CD_RUN_KEY, String(t0));
  try {
    while (true) {
      var q = _cdQueue();
      if (!q.length) { _cdClearTriggers(); return; }
      var job = q[0];
      job.fails = job.fails || {};
      var finished = _cdWork(job, t0);
      if (!finished) { _cdUpdateJob(job, false); _cdSchedule(1); return; }
      if (Date.now() - t0 > CD_BUDGET_MS - CD_FINISH_MS) { _cdUpdateJob(job, false); _cdSchedule(1); return; }
      try { _cdFinish(job); }
      catch (err) {
        job.finishErrors = (job.finishErrors || 0) + 1;
        if (job.finishErrors < CD_MAX_FAILS) { _cdUpdateJob(job, false); _cdSchedule(2); return; }
        _cdSetAssign(job.topicId, { 'Data Status':'cleared', 'Data Cleared At':nowIso(), 'Data Report':'(report failed: ' + err.message + ')' });
      }
      _cdUpdateJob(job, true);
    }
  } finally { props.deleteProperty(CD_RUN_KEY); }
}

/*  Process pending students of one job. Returns true when nothing is left
    to try (all cleared, or failed CD_MAX_FAILS times).                     */
function _cdWork(job, t0) {
  var tab = _cdTab(job.mode);
  var pending = function(){
    var s = {};
    readColumns(tab, ['Student ID', 'Topic ID', 'Data Cleared']).forEach(function(r){
      if (String(r['Topic ID']).trim() !== job.topicId || _cdCleared(r['Data Cleared'])) return;
      var sid = String(r['Student ID'] || '').trim();
      if (sid && (job.fails[sid] || 0) < CD_MAX_FAILS) s[sid] = true;
    });
    return Object.keys(s);
  };
  var list = pending();
  for (var i = 0; i < list.length; i++) {
    if (Date.now() - t0 > CD_BUDGET_MS - 40 * 1000) return false;   // ~1 Doc worth of time left
    if (!_cdOne(job, tab, list[i])) job.fails[list[i]] = (job.fails[list[i]] || 0) + 1;
  }
  return pending().length === 0;
}

function _cdOne(job, tab, sid) {
  var res;
  try { res = exportFeedbackDoc({ studentId:sid, topicId:job.topicId, mode:job.mode }); }
  catch (e) { res = { success:false, error:e.message }; }
  if (!res || !res.success || !res.data || !res.data.url) return false;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return false;
  try {
    var sh = sheet(tab), idx = headerIndex(tab);
    ['Data Cleared', 'Feedback Doc URL'].forEach(function(k){
      if (idx[k] == null) { sh.getRange(1, sh.getLastColumn() + 1).setValue(k); idx = headerIndex(tab); }
    });
    var mine = readColumns(tab, ['Student ID', 'Topic ID', 'Feedback Doc ID', 'Feedback Doc Attempts']).filter(function(r){
      return String(r['Student ID']).trim() === sid && String(r['Topic ID']).trim() === job.topicId;
    });
    if (!mine.length) return true;
    // Verify: every attempt row points at the same Doc, and the Doc covers all of them.
    var docId = String(mine[0]['Feedback Doc ID'] || '');
    if (!docId) return false;
    if (mine.some(function(r){ return String(r['Feedback Doc ID']) !== docId; })) return false;
    if ((parseInt(mine[0]['Feedback Doc Attempts'], 10) || 0) < mine.length) return false;
    try { DriveApp.getFileById(docId); } catch (e) { return false; }

    mine.forEach(function(r){
      sh.getRange(r._row, idx['Essay'] + 1).setValue('');
      sh.getRange(r._row, idx['Feedback'] + 1).setValue('');
      sh.getRange(r._row, idx['Data Cleared'] + 1).setValue('1');
      sh.getRange(r._row, idx['Feedback Doc URL'] + 1).setValue(res.data.url);
    });
    return true;
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ── Report + email ─────────────────────────────────────────────
function _cdFinish(job) {
  var tab = _cdTab(job.mode);
  var a = readAll(T.ASSIGN).filter(function(r){ return String(r['Topic ID']).trim() === job.topicId; })[0] || {};
  var classId = String(a['Class'] || '').trim();
  var cls = readAll(T.CLASSES).filter(function(c){ return String(c['Class ID']).trim() === classId; })[0] || {};
  var teacher = readAll(T.TEACHERS).filter(function(t){ return _semLow(t['Email']) === job.email; })[0] || {};
  var sum = _cdSummarize(job, a, cls, readAll(T.STUDENTS), readAll(tab));
  var book = _cdReport(sum.info, sum.list, teacher, job);
  _semShare(book, job.email);
  var url = book.getUrl();
  _cdSetAssign(job.topicId, { 'Data Status':'cleared', 'Data Cleared At':nowIso(), 'Data Report':url });
  _cdMail(sum.info, sum.list, teacher, job, url);
}

/*  Numbers for the report. Rows are keyed like the Sheet tabs; the Firebase
    edition (Firebase.gs) builds the same shapes from Firestore.            */
function _cdSummarize(job, a, cls, studentRows, subRows) {
  var classId = String(a['Class'] || '').trim();
  var req = parseInt(a['Required Attempts'], 10) || 3;
  var S = {};
  studentRows.forEach(function(s){
    if (String(s['Class']).trim() !== classId || _semTrue(s['Archived'])) return;
    var sid = String(s['Student ID']).trim();
    S[sid] = { sid:sid, name:s['Name'] || '', rows:[] };
  });
  subRows.forEach(function(r){
    if (String(r['Topic ID']).trim() !== job.topicId) return;
    var sid = String(r['Student ID'] || '').trim();
    if (!sid) return;
    if (!S[sid]) S[sid] = { sid:sid, name:r['Name'] || '', rows:[] };
    S[sid].rows.push(r);
  });

  var list = Object.keys(S).map(function(sid){
    var s = S[sid];
    s.rows.sort(function(x, y){ return _semTime(x['Timestamp']) - _semTime(y['Timestamp']); });
    var sc = s.rows.map(function(r){ return _semNum(r['AI Grading']); });
    var scored = sc.filter(function(v){ return v !== null; });
    var ts = {};
    s.rows.forEach(function(r){ if (r['Teacher Score']) { try { ts = JSON.parse(r['Teacher Score']) || ts; } catch (e) {} } });
    var last = s.rows[s.rows.length - 1] || {};
    var durs = s.rows.map(function(r){ return _semNum(r['Duration']); }).filter(function(v){ return v !== null; });
    return {
      sid:sid, name:s.name, n:s.rows.length, scores:sc,
      best: scored.length ? Math.max.apply(null, scored) : null,
      gain: scored.length >= 2 ? scored[scored.length - 1] - scored[0] : null,
      teacher: _semNum(last['Teacher Grading']) !== null ? _semNum(last['Teacher Grading']) : _semNum(ts.overall),
      note: ts.note || '', last: s.rows.length ? _semTime(last['Timestamp']) : 0,
      mins: durs.length ? Math.round(_semMean(durs) / 60) : null,
      docUrl: s.rows.length ? _cdDocUrl(last) : '',
      cleared: s.rows.length ? s.rows.every(function(r){ return _cdCleared(r['Data Cleared']); }) : true,
      status: !s.rows.length ? 0 : (s.rows.length >= req ? 2 : 1)
    };
  });
  list.sort(function(x, y){
    return (y.status - x.status) || ((y.best || 0) - (x.best || 0)) || String(x.name).localeCompare(String(y.name));
  });

  var done = list.filter(function(s){ return s.n > 0; });
  var info = {
    topic:a['Topic'] || job.topicId, mode:job.mode, taskType:a['Task Type'] || 'task2', req:req,
    className:cls['Class Name'] || classId, classId:classId, created:_semTime(a['CreatedAt']),
    deadline:a['Deadline'] ? _semTime(a['Deadline']) : 0,
    nStudents:list.length, nDone:done.length,
    nFull:list.filter(function(s){ return s.status === 2; }).length,
    subs:done.reduce(function(t, s){ return t + s.n; }, 0),
    avgFirst:_semMean(done.map(function(s){ return s.scores[0]; }).filter(function(v){ return v !== null; })),
    avgBest:_semMean(done.map(function(s){ return s.best; }).filter(function(v){ return v !== null; })),
    avgGain:_semMean(done.map(function(s){ return s.gain; }).filter(function(v){ return v !== null; })),
    notCleared:done.filter(function(s){ return !s.cleared; })
  };
  return { info: info, list: list };
}

function _cdReport(info, list, teacher, job) {
  var dateStr = _semDate(Date.now(), 'yyyy-MM-dd');
  var name = 'ArticuWrite_' + (info.mode === 'homework' ? 'HW' : 'IC') + '_' +
             String(info.className).replace(/[\\\/:*?"<>|]/g, '-') + '_' +
             String(info.topic).replace(/[\\\/:*?"<>|]/g, '').slice(0, 40) + '_' + dateStr;
  var book = SpreadsheetApp.create(name);
  try { DriveApp.getFileById(book.getId()).moveTo(DriveApp.getFolderById(FEEDBACK_FOLDER_ID)); } catch (e) {}

  // ── Sheet 1: summary ──
  var sh = book.getSheets()[0];
  sh.setName('📋 Tổng kết');
  var W = 4, rows = [], marks = [];
  function add(r, type) { while (r.length < W) r.push(''); rows.push(r); if (type) marks.push({ i:rows.length, type:type }); }
  function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; }
  function f1(v) { return v == null ? '—' : v.toFixed(1); }
  function sign(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1); }

  add(['📘 ArticuWrite — Tổng kết bài ' + (info.mode === 'homework' ? 'Homework' : 'In-class')], 'title');
  add(['📝 ' + info.topic], 'topic');
  add(['🏫 Lớp ' + info.className + ' (' + info.classId + ') · ' + (info.taskType === 'task1' ? 'Task 1' : 'Task 2') +
       ' · Yêu cầu ' + info.req + ' lần viết'], 'sub');
  add(['🗓 Giao ' + (_semDate(info.created) || '—') + ' · Hạn nộp ' + (_semDate(info.deadline) || '—') +
       ' · Lưu trữ ' + _semDate(Date.now(), 'dd/MM/yyyy HH:mm')], 'sub');
  add([]);
  add(['📌 Chỉ số'], 'section');
  add(['👩‍🎓 Sinh viên trong lớp', info.nStudents]);
  add(['✅ Đã nộp bài', info.nDone + ' (' + pct(info.nDone, info.nStudents) + ')']);
  add(['🏁 Viết đủ ' + info.req + ' lần', info.nFull + ' (' + pct(info.nFull, info.nStudents) + ')']);
  add(['❌ Chưa nộp', info.nStudents - info.nDone]);
  add(['📝 Tổng lượt nộp', info.subs]);
  add(['1️⃣ Điểm TB lần 1', f1(info.avgFirst)]);
  add(['⭐ Điểm TB tốt nhất', f1(info.avgBest)]);
  add(['📈 Cải thiện TB (lần cuối − lần đầu)', sign(info.avgGain)]);
  add([]);

  var scored = list.filter(function(s){ return s.best !== null; });
  add(['🏆 Điểm cao nhất'], 'section');
  add(['', 'Họ tên', 'MSSV', 'Band'], 'thead');
  if (!scored.length) add(['—', 'Chưa có điểm']);
  scored.slice().sort(function(x, y){ return y.best - x.best; }).slice(0, 5)
        .forEach(function(s, i){ add([['🥇','🥈','🥉','4','5'][i], s.name, s.sid, s.best]); });
  add([]);
  var gains = list.filter(function(s){ return s.gain !== null; }).sort(function(x, y){ return y.gain - x.gain; });
  add(['📈 Cải thiện nhiều nhất qua các lần viết'], 'section');
  add(['', 'Họ tên', 'MSSV', 'Cải thiện'], 'thead');
  if (!gains.length) add(['—', 'Chưa có SV viết từ 2 lần']);
  gains.slice(0, 5).forEach(function(s, i){ add([['🥇','🥈','🥉','4','5'][i], s.name, s.sid, sign(s.gain)]); });
  add([]);
  var missing = list.filter(function(s){ return s.n === 0; });
  add(['❌ Chưa nộp bài (' + missing.length + ')'], 'section');
  if (!missing.length) add(['🎉', 'Tất cả sinh viên đã nộp bài']);
  missing.forEach(function(s){ add(['•', s.name, s.sid]); });
  if (info.notCleared.length) {
    add([]);
    add(['⚠️ Chưa chuyển được sang Google Docs (bài viết vẫn giữ trong ArticuWrite)'], 'section');
    info.notCleared.forEach(function(s){ add(['•', s.name, s.sid]); });
  }
  add([]);
  add(['ℹ️ Bài viết & feedback AI của từng sinh viên đã được chuyển sang Google Docs (link ở tab 👩‍🎓 Sinh viên). ' +
       'Điểm vẫn hiển thị trong Results; bấm vào điểm sẽ mở Doc.'], 'note');

  sh.getRange(1, 1, rows.length, W).setValues(rows).setVerticalAlignment('middle');
  sh.setColumnWidth(1, 270); sh.setColumnWidth(2, 240); sh.setColumnWidth(3, 120); sh.setColumnWidth(4, 90);
  marks.forEach(function(m){
    var r = sh.getRange(m.i, 1, 1, W);
    if (m.type === 'title')   { r.merge().setFontSize(16).setFontWeight('bold').setBackground(SEM_BLUE).setFontColor('#FFFFFF'); sh.setRowHeight(m.i, 42); }
    if (m.type === 'topic')   { r.merge().setFontSize(13).setFontWeight('bold').setBackground('#EAF4FC').setFontColor('#0A3D62').setWrap(true); sh.setRowHeight(m.i, 34); }
    if (m.type === 'sub')     { r.merge().setFontColor('#475467').setBackground('#F5FAFE'); }
    if (m.type === 'section') { r.merge().setFontSize(12).setFontWeight('bold').setFontColor(SEM_BLUE); sh.setRowHeight(m.i, 28); }
    if (m.type === 'thead')   { r.setFontWeight('bold').setBackground('#EAF4FC'); }
    if (m.type === 'note')    { r.merge().setWrap(true).setFontColor('#475467').setFontSize(9); sh.setRowHeight(m.i, 36); }
  });
  sh.getRange(7, 1, 8, 1).setFontWeight('bold');
  sh.getRange(7, 2, 8, 1).setHorizontalAlignment('left');
  sh.setHiddenGridlines(true);

  // ── Sheet 2: students ──
  var st = book.insertSheet('👩‍🎓 Sinh viên', 1);
  var head = ['#', 'MSSV', 'Họ tên', 'Trạng thái', 'Số lần', 'Lần 1', 'Lần 2', 'Lần 3', 'Tốt nhất',
              'Cải thiện', 'Điểm GV', 'Nhận xét GV', 'Nộp lần cuối', 'TB phút/lần', '📄 Google Doc'];
  var Wd = head.length, n = list.length;
  var statusLabel = ['❌ Chưa nộp', '🟡 Chưa đủ', '✅ Hoàn thành'];
  var data = list.map(function(s, i){
    return [i + 1, s.sid, s.name,
            s.status === 1 ? statusLabel[1] + ' (' + s.n + '/' + info.req + ')' : statusLabel[s.status],
            s.n,
            s.scores[0] == null ? '' : s.scores[0], s.scores[1] == null ? '' : s.scores[1], s.scores[2] == null ? '' : s.scores[2],
            s.best == null ? '' : s.best, s.gain == null ? '' : Math.round(s.gain * 100) / 100,
            s.teacher == null ? '' : s.teacher, s.note, _semDate(s.last, 'dd/MM/yyyy HH:mm'),
            s.mins == null ? '' : s.mins, ''];
  });
  st.getRange(1, 2, Math.max(n, 1) + 1, 1).setNumberFormat('@');
  st.getRange(1, 1, 1, Wd).setValues([head]);
  _semHead(st.getRange(1, 1, 1, Wd));
  st.setRowHeight(1, 36);
  st.setFrozenRows(1); st.setFrozenColumns(3);
  if (n) {
    st.getRange(2, 1, n, Wd).setValues(data).setVerticalAlignment('middle');
    // Doc links as rich text so one click opens the student's Doc
    st.getRange(2, 15, n, 1).setRichTextValues(list.map(function(s){
      var b = SpreadsheetApp.newRichTextValue();
      if (!s.n) return [b.setText('—').build()];
      if (!s.docUrl) return [b.setText('⚠️ Chưa có Doc').build()];
      return [b.setText(s.cleared ? '📄 Mở Doc' : '📄 Mở Doc ⚠️').setLinkUrl(s.docUrl).build()];
    }));
    st.getRange(2, 6, n, 4).setNumberFormat('0.0');
    st.getRange(2, 10, n, 1).setNumberFormat('+0.0;-0.0;0.0');
    st.getRange(2, 11, n, 1).setNumberFormat('0.0');
    st.getRange(2, 12, n, 1).setWrap(true);
    st.getRange(1, 1, n + 1, Wd).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
    var colors = ['#FEE4E2', '#FEF0C7', '#D1FADF'];
    st.getRange(2, 4, n, 1).setBackgrounds(list.map(function(s){ return [colors[s.status]]; })).setFontWeight('bold');
    st.setConditionalFormatRules([
      _semScale(st.getRange(2, 9, n, 1), '#FFFFFF', null, '#CFE6F8', null),
      _semScale(st.getRange(2, 10, n, 1), '#FDE2E1', '#FFFFFF', '#D1FADF', 0)
    ]);
    st.getRange(2, 1, n, Wd).setHorizontalAlignment('center');
    st.getRange(2, 3, n, 1).setHorizontalAlignment('left');
    st.getRange(2, 12, n, 1).setHorizontalAlignment('left');
  }
  st.setColumnWidth(1, 40); st.setColumnWidth(2, 110); st.setColumnWidth(3, 190); st.setColumnWidth(4, 150);
  st.setColumnWidths(5, 7, 72); st.setColumnWidth(12, 260); st.setColumnWidth(13, 130);
  st.setColumnWidth(14, 90); st.setColumnWidth(15, 120);
  SpreadsheetApp.flush();
  return book;
}

function _cdMail(info, list, teacher, job, url) {
  var modeLabel = info.mode === 'homework' ? 'Homework' : 'In-class';
  function kpi(icon, label, val) {
    return '<td style="padding:10px;border:1px solid #E4E7EC;border-radius:10px;text-align:center;width:25%">' +
           '<div style="font-size:18px">' + icon + '</div><div style="font-size:19px;font-weight:bold;color:' + SEM_BLUE + '">' +
           _semEsc(val) + '</div><div style="font-size:11px;color:#667085">' + label + '</div></td>';
  }
  var top = list.filter(function(s){ return s.best !== null; }).sort(function(x, y){ return y.best - x.best; }).slice(0, 3)
    .map(function(s, i){ return ['🥇', '🥈', '🥉'][i] + ' ' + _semEsc(s.name || s.sid) + ' <span style="color:#667085">(' + s.best + ')</span>'; })
    .join('<br>') || '<i style="color:#667085">Chưa có điểm</i>';
  var missing = info.nStudents - info.nDone;
  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;border:1px solid #E4E7EC;border-radius:14px;overflow:hidden;color:#10222E">' +
      '<div style="background:' + SEM_BLUE + ';color:#fff;padding:20px 24px">' +
        '<div style="font-size:13px;opacity:.85">🧹 Clear Data · ' + modeLabel + ' · ' + _semEsc(info.className) + '</div>' +
        '<div style="font-size:19px;font-weight:bold;margin-top:4px">📝 ' + _semEsc(info.topic) + '</div>' +
      '</div>' +
      '<div style="padding:20px 24px;font-size:14px;line-height:1.6">' +
        '<p>Chào thầy/cô ' + _semEsc(teacher['Name'] || '') + ' 👋</p>' +
        '<p>Bài viết &amp; feedback của bài này đã được chuyển sang Google Docs để ArticuWrite luôn nhẹ và nhanh. ' +
        'Điểm vẫn hiển thị trong <b>Results</b>; bấm vào điểm sẽ mở Doc của sinh viên.</p>' +
        '<table style="width:100%;border-collapse:separate;border-spacing:6px;margin:8px 0"><tr>' +
          kpi('✅', 'Đã nộp', info.nDone + '/' + info.nStudents) + kpi('📝', 'Lượt nộp', info.subs) +
          kpi('⭐', 'TB tốt nhất', info.avgBest == null ? '—' : info.avgBest.toFixed(1)) +
          kpi('📈', 'Cải thiện TB', info.avgGain == null ? '—' : (info.avgGain >= 0 ? '+' : '') + info.avgGain.toFixed(1)) +
        '</tr></table>' +
        '<p><b>🏆 Điểm cao nhất</b><br>' + top + '</p>' +
        (missing ? '<p>❌ <b>' + missing + '</b> sinh viên chưa nộp bài (danh sách trong báo cáo).</p>' : '<p>🎉 Tất cả sinh viên đã nộp bài.</p>') +
        (info.notCleared.length ? '<p>⚠️ ' + info.notCleared.length + ' sinh viên chưa tạo được Doc nên bài viết vẫn được giữ trong ArticuWrite.</p>' : '') +
        '<p style="text-align:center;margin:22px 0">' +
          '<a href="' + url + '" style="background:' + SEM_BLUE + ';color:#fff;text-decoration:none;padding:12px 26px;border-radius:10px;font-weight:bold;display:inline-block">📊 Mở bảng tổng kết</a></p>' +
        '<p style="font-size:12px;color:#667085">Bảng tổng kết có link 📄 Google Doc của từng sinh viên để truy cập nhanh.</p>' +
      '</div>' +
      '<div style="background:#F9FAFB;padding:12px 24px;font-size:12px;color:#98A2B3">— ArticuWrite ✍️</div>' +
    '</div>';
  try {
    MailApp.sendEmail({ to:job.email, name:'ArticuWrite',
      subject:'🧹 [ArticuWrite] ' + modeLabel + ' đã lưu trữ — ' + info.topic + ' (' + info.className + ')',
      htmlBody:html, body:'Tổng kết bài ' + info.topic + ': ' + url });
  } catch (e) {}
}
