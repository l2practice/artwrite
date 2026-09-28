/*───────────────────────────────────────────────────────────────
  ArticuWrite — End of semester (Semester.gs)

  Settings ▸ "Kết thúc học kỳ", for the classes the teacher picks:
    1. builds ONE Google Sheet report — overview, a gradebook per class,
       detail per mode (Homework / In-class / Free-writing), Translate and
       the student list — formatted for reading, printing and sharing;
       saved in the feedback Drive folder and shared with the teacher;
    2. (optional) wipes every row of those classes: submissions, history,
       annotations, queries, assignments, translate sets + results,
       ResultArchive, mail log, live cache — next semester starts on empty
       tabs — and archives the classes. Student accounts are NOT deleted:
       archiving a class locks its students' login; Settings ▸ "Lớp đã
       lưu trữ" ▸ Restore unlocks them (archiveClass, Code.gs);
    3. emails the teacher the summary + the report link.

  Runs in the background worker (queue kind 'semester', Retention.gs).
  The report is built before anything is deleted, and nothing is deleted
  if the report fails. Students' feedback Google Docs stay in Drive.
  Uses Retention.gs helpers (rtCols, rtAt, rtDeleteWhere, rtQueue…).
───────────────────────────────────────────────────────────────*/

var SEM_NAVY = '#0A3D62', SEM_BLUE = '#0A6EBD', SEM_MISS = '#FDECEA', SEM_GREY = '#5B6B7A';
var SEM_WIPE_STEPS = ['maillog','history','annot','queries','homework','inclass','free',
                      'trresults','trsets','assign','archive','live','classes'];

// ── Preview (Settings modal) ───────────────────────────────────
function semPreview(p) {
  var me = String(p.teacherEmail || '').trim().toLowerCase();
  if (!me) return { success:false, error:'Missing teacherEmail.' };
  var mine = readAll(T.CLASSES).filter(function(c){ return String(c['Teacher Email']).trim().toLowerCase() === me; });
  var count = function(name, col){
    var info = rtCols(name, [col]), n = {};
    for (var k = 0; k < info.n; k++) { var c = String(rtAt(info, col, k)).trim(); n[c] = (n[c] || 0) + 1; }
    return n;
  };
  var stu = count(T.STUDENTS, 'Class'), hw = count(T.HOMEWORK, 'Class'), ic = count(T.INCLASS, 'Class'),
      fw = count(T.FREE, 'Class'), tr = count(T.TR_RESULTS, 'Class'), asg = count(T.ASSIGN, 'Class');
  var queued = rtQueueLoad().filter(function(j){ return j.kind === 'semester' && j.teacherEmail === me; });
  return { success:true, data:{
    classes: mine.map(function(c){
      var id = String(c['Class ID']);
      return { classId:id, className:c['Class Name'] || id, year:c['Academic Year'] || '', semester:c['Semester'] || '',
               archived: String(c['Archived']).toLowerCase() === 'true',
               students:stu[id] || 0, assignments:asg[id] || 0,
               homework:hw[id] || 0, inclass:ic[id] || 0, free:fw[id] || 0, translate:tr[id] || 0 };
    }),
    queued: queued
  } };
}

// ── Request (queued; the worker does the work) ─────────────────
function semRequest(p) {
  var me = String(p.teacherEmail || '').trim().toLowerCase();
  if (!me) return { success:false, error:'Missing teacherEmail.' };
  var own = rtTeacherClasses(me);
  var classes = (p.classes || []).map(String).filter(function(c){ return own.hasOwnProperty(c); });
  if (!classes.length) return { success:false, error:'Chưa chọn lớp nào.' };
  var wipe = !!p.wipe;
  if (wipe && String(p.confirm || '').trim().toUpperCase() !== 'RESET')
    return { success:false, error:'Gõ RESET để xác nhận xoá dữ liệu.' };
  var dup = false;
  rtQueueMutate(function(q){
    dup = q.some(function(j){ return j.kind === 'semester' && j.teacherEmail === me; });
    if (dup) return;
    q.push({ kind:'semester', id:'sem-' + Date.now(), teacherEmail:me, queuedAt:nowIso(),
             title:(wipe ? 'Kết thúc học kỳ' : 'Báo cáo học kỳ') + ' (' + classes.length + ' lớp)',
             classes:classes, wipe:wipe, step:0, deleted:0 });
  });
  if (dup) return { success:false, error:'Đang có một yêu cầu tổng kết học kỳ chưa xử lý xong.' };
  rtScheduleKick(1);
  return { success:true, data:{ queued:true } };
}

// ── Worker entry ───────────────────────────────────────────────
/*  Returns {partial} to continue later, {} when finished (job removed by
    the caller). Progress (report URL, wipe step) is saved on the queue
    item after every step, so a run cut short resumes where it stopped. */
function semRun(job, t0) {
  var set = {};
  job.classes.forEach(function(c){ set[c] = true; });
  if (!job.reportUrl) {
    try {
      var rep = semBuildReport(job, set);
      semSave(job, { reportUrl:rep.url, summary:rep.summary });
    } catch (e) {
      semFailMail(job, e);
      return {};                                   // dropped — nothing was deleted
    }
  }
  if (job.wipe) {
    var r = semWipe(job, set, t0);
    if (r.partial) return r;
  }
  if (MailApp.getRemainingDailyQuota() < 1) return { partial:true, quota:true };
  semDoneMail(job);
  return {};
}

function semSave(job, patch) {
  Object.keys(patch).forEach(function(k){ job[k] = patch[k]; });
  rtQueueMutate(function(q){
    q.forEach(function(j){ if (j.id === job.id) Object.keys(patch).forEach(function(k){ j[k] = patch[k]; }); });
  });
}

// ── Wipe ───────────────────────────────────────────────────────
function semWipe(job, set, t0) {
  // Who and what belongs to these classes (computed before anything is deleted in this run)
  var sids = {}, topics = {}, setIds = {};
  var si = rtCols(T.STUDENTS, ['Student ID','Class']);
  for (var k = 0; k < si.n; k++) if (set[String(rtAt(si, 'Class', k)).trim()]) sids[String(rtAt(si, 'Student ID', k)).trim()] = true;
  var ai = rtCols(T.ASSIGN, ['Topic ID','Class']);
  for (k = 0; k < ai.n; k++) if (set[String(rtAt(ai, 'Class', k)).trim()]) topics[String(rtAt(ai, 'Topic ID', k)).trim()] = true;
  [T.HOMEWORK, T.INCLASS, T.FREE].forEach(function(tab){
    var info = rtCols(tab, ['Student ID','Topic ID','Class']);
    for (var j = 0; j < info.n; j++) if (set[String(rtAt(info, 'Class', j)).trim()]) {
      sids[String(rtAt(info, 'Student ID', j)).trim()] = true;
      if (tab !== T.FREE) topics[String(rtAt(info, 'Topic ID', j)).trim()] = true;
    }
  });
  var ts = rtCols(T.TR_SETS, ['Set ID','Class']);
  for (k = 0; k < ts.n; k++) if (set[String(rtAt(ts, 'Class', k)).trim()]) setIds[String(rtAt(ts, 'Set ID', k)).trim()] = true;

  var v = function(i, c, k2){ return String(rtAt(i, c, k2)).trim(); };
  var byClass = function(i, k2){ return !!set[v(i, 'Class', k2)]; };
  var bySid   = function(i, k2){ return !!sids[v(i, 'Student ID', k2)]; };
  var byTopic = function(i, k2){ return !!topics[v(i, 'Topic ID', k2)]; };
  var run = {
    maillog:  function(){ return rtDeleteWhere(RT.MAILLOG, ['Student ID','Topic ID'], function(i, k2){ return bySid(i, k2) || byTopic(i, k2); }); },
    history:  function(){ return rtDeleteWhere(T.HISTORY, ['Student ID','Topic ID'], function(i, k2){ return bySid(i, k2) || byTopic(i, k2); }); },
    annot:    function(){ return rtDeleteWhere(T.ANNOT, ['Student ID','Topic ID'], function(i, k2){ return bySid(i, k2) || byTopic(i, k2); }); },
    queries:  function(){ return rtDeleteWhere(T.QUERIES, ['Class','Topic ID'], function(i, k2){ return byClass(i, k2) || byTopic(i, k2); }); },
    homework: function(){ return rtDeleteWhere(T.HOMEWORK, ['Class','Topic ID'], function(i, k2){ return byClass(i, k2) || byTopic(i, k2); }); },
    inclass:  function(){ return rtDeleteWhere(T.INCLASS, ['Class','Topic ID'], function(i, k2){ return byClass(i, k2) || byTopic(i, k2); }); },
    free:     function(){ return rtDeleteWhere(T.FREE, ['Class'], byClass); },
    trresults:function(){ return rtDeleteWhere(T.TR_RESULTS, ['Class','Set ID'], function(i, k2){ return byClass(i, k2) || !!setIds[v(i, 'Set ID', k2)]; }); },
    trsets:   function(){ return rtDeleteWhere(T.TR_SETS, ['Class'], byClass); },
    assign:   function(){ return rtDeleteWhere(T.ASSIGN, ['Class'], byClass); },
    archive:  function(){ return rtDeleteWhere(RT.ARCHIVE, ['Class'], byClass); },
    live:     function(){ job.classes.forEach(function(c){ clearLiveSessions({ class:c }); CacheService.getScriptCache().remove('lvr:' + c); }); return 0; },
    // class archived → its students' login is locked (accounts kept, restorable)
    classes:  function(){
      job.classes.forEach(function(c){ rtLocked(function(){ archiveClass({ classId:c }); }); });
      return 0;
    }
  };
  for (var s = job.step || 0; s < SEM_WIPE_STEPS.length; s++) {
    if (Date.now() - t0 > RT.BUDGET_MS) return { partial:true };
    var n = run[SEM_WIPE_STEPS[s]]();
    semSave(job, { step:s + 1, deleted:(job.deleted || 0) + (n || 0) });
  }
  return {};
}

// ── Data ───────────────────────────────────────────────────────
function semCollect(set) {
  var D = { classes:[], cls:{}, students:{}, assigns:[], asgBy:{}, groups:{ homework:[], inclass:[], free:[] }, translate:[], sets:{} };
  readAll(T.CLASSES).forEach(function(c){
    var id = String(c['Class ID']);
    if (!set[id]) return;
    var o = { id:id, name:c['Class Name'] || id, year:c['Academic Year'] || '', semester:c['Semester'] || '',
              aiOn:String(c['AI Enabled']).toLowerCase() !== 'false' };
    D.classes.push(o); D.cls[id] = o;
  });
  readAll(T.STUDENTS).forEach(function(s){
    var c = String(s['Class']).trim();
    if (!set[c]) return;
    var sid = String(s['Student ID']).trim();
    D.students[sid] = { sid:sid, name:s['Name'] || '', cls:c, email:s['Email'] || '', phone:s['Phone'] || '' };
  });
  readAll(T.ASSIGN).forEach(function(a){
    var c = String(a['Class']).trim();
    if (!set[c] || (a['Mode'] !== 'homework' && a['Mode'] !== 'inclass')) return;
    var o = { tid:String(a['Topic ID']), mode:a['Mode'], cls:c, topic:a['Topic'] || '', taskType:a['Task Type'] || 'task2',
              deadline:a['Deadline'], created:a['CreatedAt'], required:parseInt(a['Required Attempts'], 10) || 1,
              active:!(a['Active'] === false || String(a['Active']).toLowerCase() === 'false') };
    D.assigns.push(o); D.asgBy[o.tid] = o;
  });

  var G = {};
  var group = function(mode, sid, tid, meta){
    var key = mode + '|' + sid + '|' + tid;
    if (!G[key]) { G[key] = { mode:mode, sid:sid, tid:tid, name:'', cls:'', topic:'', taskType:'task2', writes:[], ts:null, docUrl:'' }; D.groups[mode].push(G[key]); }
    var g = G[key];
    Object.keys(meta).forEach(function(k){ if (meta[k] && !g[k]) g[k] = meta[k]; });
    return g;
  };
  var cols = ['Timestamp','Student ID','Name','Class','Topic','Topic ID','Task Type','AI Grading','TR','CC','LR','GRA','Teacher Score','Feedback Doc ID'];
  [['homework', T.HOMEWORK], ['inclass', T.INCLASS], ['free', T.FREE]].forEach(function(m){
    var info = rtCols(m[1], cols);
    for (var k = 0; k < info.n; k++) {
      var tid = String(rtAt(info, 'Topic ID', k)).trim(), asg = D.asgBy[tid];
      var cls = m[0] !== 'free' && asg ? asg.cls : String(rtAt(info, 'Class', k)).trim();
      if (!set[cls]) continue;
      var sid = String(rtAt(info, 'Student ID', k)).trim();
      if (!sid) continue;
      var g = group(m[0], sid, tid, { name:rtAt(info, 'Name', k), cls:cls, topic:rtAt(info, 'Topic', k) || (asg && asg.topic),
                                      taskType:rtAt(info, 'Task Type', k) });
      g.writes.push({ t:rtMs(rtAt(info, 'Timestamp', k)), overall:rtAt(info, 'AI Grading', k),
                      tr:rtAt(info, 'TR', k), cc:rtAt(info, 'CC', k), lr:rtAt(info, 'LR', k), gra:rtAt(info, 'GRA', k) });
      var tsj = rtAt(info, 'Teacher Score', k);
      if (tsj) { try { g.ts = JSON.parse(tsj); } catch (e) {} }
      var doc = rtAt(info, 'Feedback Doc ID', k);
      if (doc) g.docUrl = 'https://docs.google.com/document/d/' + doc + '/edit';
    }
  });

  // Archived results (homework / free-writing retired earlier, translate purged)
  var ar = rtCols(RT.ARCHIVE, ['Mode','Class','Topic ID','Topic','Task Type','Student ID','Name','Attempts','Best','Avg','Last',
                                'Passed','Cleared','Teacher Score JSON','Writes JSON','Doc URL','Last At','Deadline']);
  for (var a = 0; a < ar.n; a++) {
    var cl = String(rtAt(ar, 'Class', a)).trim();
    if (!set[cl]) continue;
    var mode = String(rtAt(ar, 'Mode', a)), sid2 = String(rtAt(ar, 'Student ID', a)).trim(), tid2 = String(rtAt(ar, 'Topic ID', a)).trim();
    if (mode === 'translate') {
      D.translate.push({ cls:cl, sid:sid2, name:rtAt(ar, 'Name', a), setId:tid2, title:rtAt(ar, 'Topic', a), deadline:rtAt(ar, 'Deadline', a),
        runs:parseInt(rtAt(ar, 'Attempts', a), 10) || 0, best:rtNum(rtAt(ar, 'Best', a)), last:rtNum(rtAt(ar, 'Last', a)),
        avg:rtNum(rtAt(ar, 'Avg', a)), cleared:parseInt(rtAt(ar, 'Cleared', a), 10) || 0,
        passed:String(rtAt(ar, 'Passed', a)).toUpperCase() === 'TRUE' });
      continue;
    }
    if (!D.groups[mode]) continue;
    var ga = group(mode, sid2, tid2, { name:rtAt(ar, 'Name', a), cls:cl, topic:rtAt(ar, 'Topic', a), taskType:rtAt(ar, 'Task Type', a) });
    var ws = []; try { ws = JSON.parse(rtAt(ar, 'Writes JSON', a) || '[]'); } catch (e) {}
    ws.forEach(function(w){ ga.writes.push({ t:rtMs(w.timestamp), overall:w.overall, tr:w.tr, cc:w.cc, lr:w.lr, gra:w.gra }); });
    if (!ga.ts) { try { ga.ts = JSON.parse(rtAt(ar, 'Teacher Score JSON', a) || 'null'); } catch (e) {} }
    if (!ga.docUrl) ga.docUrl = rtAt(ar, 'Doc URL', a);
  }

  // Finalise writing groups
  ['homework','inclass','free'].forEach(function(m){
    D.groups[m].forEach(function(g){
      g.writes.sort(function(x, y){ return (x.t || 0) - (y.t || 0); });
      g.best = null;
      g.writes.forEach(function(w){ var b = rtNum(w.overall); if (b !== '' && (g.best === null || b > rtNum(g.best.overall))) g.best = w; });
      g.lastAt = g.writes.length ? g.writes[g.writes.length - 1].t : 0;
      if (!g.name && D.students[g.sid]) g.name = D.students[g.sid].name;
    });
  });

  // Translate sets + live results
  var st = rtCols(T.TR_SETS, ['Set ID','Class','Title','Deadline']);
  for (var s = 0; s < st.n; s++) {
    var sc = String(rtAt(st, 'Class', s)).trim();
    if (set[sc]) D.sets[String(rtAt(st, 'Set ID', s))] = { cls:sc, title:rtAt(st, 'Title', s), deadline:rtAt(st, 'Deadline', s) };
  }
  var tr = rtCols(T.TR_RESULTS, ['Set ID','Student ID','Name','Class','Timestamp','Score','Passed','Partial','Cleared Item IDs JSON']);
  var TA = {};
  for (var r = 0; r < tr.n; r++) {
    var setId = String(rtAt(tr, 'Set ID', r)), meta = D.sets[setId];
    var rc = meta ? meta.cls : String(rtAt(tr, 'Class', r)).trim();
    if (!set[rc]) continue;
    var sid3 = String(rtAt(tr, 'Student ID', r)).trim();
    var x = TA[sid3 + '|' + setId] || (TA[sid3 + '|' + setId] = { cls:rc, sid:sid3, name:rtAt(tr, 'Name', r), setId:setId,
      title:meta ? meta.title : setId, deadline:meta ? meta.deadline : '', runs:0, sum:0, best:'', last:'', lastT:'', cleared:0, passed:false });
    var cl2 = 0; try { cl2 = JSON.parse(rtAt(tr, 'Cleared Item IDs JSON', r) || '[]').length; } catch (e) {}
    if (cl2 > x.cleared) x.cleared = cl2;
    if (String(rtAt(tr, 'Partial', r)).toUpperCase() === 'TRUE') continue;
    var score = parseFloat(rtAt(tr, 'Score', r)) || 0, t = rtIso(rtAt(tr, 'Timestamp', r));
    x.runs++; x.sum += score;
    if (x.best === '' || score > x.best) x.best = score;
    if (t >= x.lastT) { x.lastT = t; x.last = score; }
    if (String(rtAt(tr, 'Passed', r)).toUpperCase() === 'TRUE') x.passed = true;
  }
  Object.keys(TA).forEach(function(k){ var x = TA[k]; x.avg = x.runs ? Math.round(x.sum / x.runs) : ''; D.translate.push(x); });
  return D;
}

// ── Report ─────────────────────────────────────────────────────
function semBuildReport(job, set) {
  var D = semCollect(set), tz = Session.getScriptTimeZone(), now = new Date();
  var title = 'ArticuWrite — Tổng kết học kỳ — ' + D.classes.map(function(c){ return c.name; }).join(', ').slice(0, 80) +
              ' — ' + Utilities.formatDate(now, tz, 'dd-MM-yyyy');
  var book = SpreadsheetApp.create(title);
  var used = {};
  var tab = function(name, first){
    name = String(name).replace(/[\[\]\*\?\/\\:]/g, ' ').slice(0, 90);
    var n = name, i = 2; while (used[n]) n = name + ' (' + (i++) + ')';
    used[n] = true;
    if (first) { var s0 = book.getSheets()[0]; s0.setName(n); return s0; }
    return book.insertSheet(n);
  };
  var summary = semSummary(D);

  semOverviewTab(tab('Tổng quan', true), D, summary, job, now);
  D.classes.forEach(function(c){ semGradebookTab(tab('Bảng điểm · ' + c.name), D, c); });
  [['homework','Homework'], ['inclass','In-class'], ['free','Free-writing']].forEach(function(m){
    if (D.groups[m[0]].length) semDetailTab(tab('Chi tiết ' + m[1]), D, m[0], m[1]);
  });
  if (D.translate.length) semTranslateTab(tab('Translate'), D);
  semStudentsTab(tab('Sinh viên'), D);

  var file = DriveApp.getFileById(book.getId());
  try {
    var parent = DriveApp.getFolderById(FEEDBACK_FOLDER_ID), it = parent.getFoldersByName('ArticuWrite Semester Reports');
    file.moveTo(it.hasNext() ? it.next() : parent.createFolder('ArticuWrite Semester Reports'));
  } catch (e) {}
  try { file.addEditor(job.teacherEmail); } catch (e) {}   // already the owner, or not a Google account
  return { url:book.getUrl(), summary:summary };
}

// Per-class numbers used by the overview tab and the email
function semSummary(D) {
  return D.classes.map(function(c){
    var nStu = semRoster(D, c.id).length;
    var o = { id:c.id, name:c.name, year:c.year, semester:c.semester, aiOn:c.aiOn, students:nStu };
    ['homework','inclass'].forEach(function(m){
      var asg = D.assigns.filter(function(a){ return a.cls === c.id && a.mode === m && (a.active || semHasWork(D, m, a.tid)); });
      var gs = D.groups[m].filter(function(g){ return g.cls === c.id; });
      var bands = gs.map(function(g){ return g.best ? rtNum(g.best.overall) : ''; }).filter(function(b){ return b !== ''; });
      var ids = {}; asg.forEach(function(a){ ids[a.tid] = 1; });
      o[m] = asg.length;
      o[m + 'Rate'] = nStu && asg.length ? gs.filter(function(g){ return ids[g.tid]; }).length / (nStu * asg.length) : '';
      o[m + 'Band'] = bands.length ? Math.round(bands.reduce(function(a, b){ return a + b; }, 0) / bands.length * 10) / 10 : '';
    });
    o.free = D.groups.free.filter(function(g){ return g.cls === c.id; }).length;
    var trs = D.translate.filter(function(x){ return x.cls === c.id; });
    var trSets = {}; trs.forEach(function(x){ trSets[x.setId] = 1; });
    o.translate = Object.keys(trSets).length;
    var trBest = trs.map(function(x){ return x.best; }).filter(function(b){ return b !== ''; });
    o.translateAvg = trBest.length ? Math.round(trBest.reduce(function(a, b){ return a + b; }, 0) / trBest.length) : '';
    return o;
  });
}

function semHasWork(D, mode, tid) { return D.groups[mode].some(function(g){ return g.tid === tid; }); }

// Class members + anyone who submitted work for the class, sorted by Student ID
function semRoster(D, cls) {
  var seen = {}, out = [];
  Object.keys(D.students).forEach(function(sid){ if (D.students[sid].cls === cls) { seen[sid] = 1; out.push(D.students[sid]); } });
  ['homework','inclass','free'].forEach(function(m){
    D.groups[m].forEach(function(g){ if (g.cls === cls && !seen[g.sid]) { seen[g.sid] = 1; out.push({ sid:g.sid, name:g.name, cls:cls, email:'', phone:'' }); } });
  });
  D.translate.forEach(function(x){ if (x.cls === cls && !seen[x.sid]) { seen[x.sid] = 1; out.push({ sid:x.sid, name:x.name, cls:cls, email:'', phone:'' }); } });
  return out.sort(function(a, b){ return String(a.sid).localeCompare(String(b.sid), 'vi', { numeric:true }); });
}

function semOverviewTab(sh, D, summary, job, now) {
  var head = ['Lớp','Mã lớp','Năm học','HK','Nhóm','Sĩ số','Homework (bài)','Tỉ lệ nộp HW','Band TB HW',
              'In-class (bài)','Tỉ lệ nộp IC','Band TB IC','Free-writing (bài)','Translate (bộ)','Điểm TB Translate'];
  semTitle(sh, 'ArticuWrite — Báo cáo tổng kết học kỳ',
    'Giảng viên: ' + job.teacherEmail + '   ·   Xuất lúc ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') +
    '   ·   ' + summary.length + ' lớp', head.length);
  var rows = summary.map(function(o){
    return [o.name, o.id, o.year, o.semester ? 'HK' + o.semester : '', o.aiOn ? 'Thực nghiệm (AI)' : 'Đối chứng',
            o.students, o.homework, o.homeworkRate, o.homeworkBand, o.inclass, o.inclassRate, o.inclassBand,
            o.free, o.translate, o.translateAvg];
  });
  var top = 4;
  semTable(sh, top, [head], rows, { widths:[170,90,90,50,130,60,90,90,80,90,90,80,100,90,110] });
  if (rows.length) {
    sh.getRange(top + 1, 8, rows.length, 1).setNumberFormat('0%');
    sh.getRange(top + 1, 11, rows.length, 1).setNumberFormat('0%');
    semBandFormat(sh, [sh.getRange(top + 1, 9, rows.length, 1), sh.getRange(top + 1, 12, rows.length, 1)]);
  }
  var notes = [
    ['Cách đọc báo cáo'],
    ['• Band: band AI tốt nhất của mỗi sinh viên cho mỗi bài (thang IELTS 0–9). Tỉ lệ nộp = số lượt SV × bài có nộp / (sĩ số × số bài).'],
    ['• Tab "Bảng điểm · <lớp>": mỗi SV một dòng, mỗi bài hai cột AI / GV; ô đỏ nhạt = chưa nộp.'],
    ['• Tab "Chi tiết …": từng lần viết, điểm tiêu chí, điểm & nhận xét GV và link Google Doc của SV.'],
    ['• Bài viết và nhận xét chi tiết nằm trong Google Docs của từng SV (thư mục phản hồi trên Drive), không bị xoá khi reset.']
  ];
  var nr = top + rows.length + 3;
  sh.getRange(nr, 1, notes.length, 1).setValues(notes);
  sh.getRange(nr, 1).setFontWeight('bold').setFontColor(SEM_NAVY);
  sh.getRange(nr + 1, 1, notes.length - 1, 1).setFontColor(SEM_GREY);
}

function semGradebookTab(sh, D, c) {
  var asg = D.assigns.filter(function(a){ return a.cls === c.id && (a.active || semHasWork(D, a.mode, a.tid)); })
    .sort(function(x, y){
      if (x.mode !== y.mode) return x.mode === 'homework' ? -1 : 1;
      return (rtMs(x.deadline) || rtMs(x.created) || 0) - (rtMs(y.deadline) || rtMs(y.created) || 0);
    });
  var per = c.aiOn ? 2 : 1, n = { homework:0, inclass:0 };
  var h1 = ['STT','Student ID','Họ tên'], h2 = ['','',''];
  asg.forEach(function(a){
    var label = (a.mode === 'homework' ? 'HW' : 'IC') + (++n[a.mode]) + ' · ' + rtPlain(a.topic).slice(0, 40) +
                (a.deadline ? ' (' + rtFmt(a.deadline).slice(0, 5) + ')' : '');
    h1.push(label); if (per === 2) { h1.push(''); h2.push('AI', 'GV'); } else h2.push('GV');
  });
  h1.push('Đã nộp');
  if (c.aiOn) h1.push('Band AI TB');
  h1.push('Điểm GV TB', 'Free-writing (bài)', 'Translate TB (%)');
  while (h2.length < h1.length) h2.push('');

  var idx = {};
  ['homework','inclass'].forEach(function(m){ D.groups[m].forEach(function(g){ idx[m + '|' + g.sid + '|' + g.tid] = g; }); });
  var roster = semRoster(D, c.id), miss = [];
  var rows = roster.map(function(s, i){
    var r = [i + 1, s.sid, s.name], ai = [], gv = [], done = 0;
    asg.forEach(function(a){
      var g = idx[a.mode + '|' + s.sid + '|' + a.tid];
      var b = g && g.best ? rtNum(g.best.overall) : '', t = g && g.ts ? rtNum(g.ts.overall) : '';
      if (g) done++;
      if (b !== '') ai.push(b);
      if (t !== '') gv.push(t);
      if (per === 2) r.push(g ? b : '—', g ? t : '—'); else r.push(g ? t : '—');
      if (!g) for (var q = 0; q < per; q++) miss.push([i, r.length - per + q]);
    });
    var avg = function(v){ return v.length ? Math.round(v.reduce(function(x, y){ return x + y; }, 0) / v.length * 10) / 10 : ''; };
    var fw = D.groups.free.filter(function(g){ return g.cls === c.id && g.sid === s.sid; }).length;
    var tr = D.translate.filter(function(x){ return x.cls === c.id && x.sid === s.sid && x.best !== ''; }).map(function(x){ return x.best; });
    r.push(done + '/' + asg.length);
    if (c.aiOn) r.push(avg(ai));
    r.push(avg(gv), fw, tr.length ? Math.round(tr.reduce(function(x, y){ return x + y; }, 0) / tr.length) : '');
    return r;
  });

  semTitle(sh, 'Bảng điểm — ' + c.name + ' (' + c.id + ')',
    (c.aiOn ? 'AI = band AI tốt nhất · GV = điểm giảng viên' : 'Lớp đối chứng · GV = điểm giảng viên') +
    ' · ô đỏ nhạt = chưa nộp · HW = Homework, IC = In-class', h1.length);
  var top = 4, widths = [45, 95, 180];
  asg.forEach(function(){ for (var q = 0; q < per; q++) widths.push(per === 2 ? 58 : 90); });
  widths = widths.concat(c.aiOn ? [70, 80, 80, 85, 90] : [70, 80, 85, 90]);
  semTable(sh, top, [h1, h2], rows, { widths:widths });
  if (per > 1) for (var col = 4, a = 0; a < asg.length; a++, col += per) sh.getRange(top, col, 1, per).merge();
  for (var tail = 4 + asg.length * per; tail <= h1.length; tail++) sh.getRange(top, tail, 2, 1).merge();
  [1, 2, 3].forEach(function(cc){ sh.getRange(top, cc, 2, 1).merge(); });
  if (rows.length) {
    var bandRanges = [];
    if (asg.length) bandRanges.push(sh.getRange(top + 2, 4, rows.length, asg.length * per));
    var avgCol = 4 + asg.length * per + 1;
    bandRanges.push(sh.getRange(top + 2, avgCol, rows.length, c.aiOn ? 2 : 1));
    bandRanges.forEach(function(r){ r.setNumberFormat('0.0').setHorizontalAlignment('center'); });
    semBandFormat(sh, bandRanges);
    // one RangeList call; setBackgrounds on the whole block would paint every
    // cell white and hide the row banding
    if (miss.length) sh.getRangeList(miss.map(function(m){ return colA1(top + 2 + m[0], m[1] + 1); })).setBackground(SEM_MISS);
  }
  sh.setFrozenColumns(3);
}

function semDetailTab(sh, D, mode, label) {
  var isFree = mode === 'free';
  var head = ['Lớp','Student ID','Họ tên','Bài', 'Task', isFree ? 'Lần viết cuối' : 'Hạn nộp', 'Số lần',
              'Lần 1','Lần 2','Lần 3','Best','TR','CC','LR','GRA','GV TR','GV CC','GV LR','GV GRA','GV Overall',
              'Nhận xét gửi SV','Ghi chú riêng GV','Google Doc'];
  var gs = D.groups[mode].slice().sort(function(a, b){
    return String(a.cls).localeCompare(String(b.cls)) || String(a.topic).localeCompare(String(b.topic), 'vi') ||
           String(a.sid).localeCompare(String(b.sid), 'vi', { numeric:true });
  });
  var rows = gs.map(function(g){
    var a = D.asgBy[g.tid] || {}, w = g.writes, b = g.best || {}, ts = g.ts || {};
    var band = function(i){ return w[i] ? rtNum(w[i].overall) : ''; };
    return [(D.cls[g.cls] || {}).name || g.cls, g.sid, g.name, semText(g.topic), (a.taskType || g.taskType) === 'task1' ? 'T1' : 'T2',
            isFree ? (g.lastAt ? rtFmt(g.lastAt) : '') : (a.deadline ? rtFmt(a.deadline) : ''), w.length,
            band(0), band(1), band(2), g.best ? rtNum(b.overall) : '', rtNum(b.tr), rtNum(b.cc), rtNum(b.lr), rtNum(b.gra),
            rtNum(ts.tr), rtNum(ts.cc), rtNum(ts.lr), rtNum(ts.gra), rtNum(ts.overall),
            semText(ts.privateNote), semText(ts.note),
            g.docUrl ? '=HYPERLINK("' + String(g.docUrl).replace(/"/g, '') + '","📄 Mở Doc")' : ''];
  });
  semTitle(sh, 'Chi tiết ' + label, 'Mỗi dòng: một sinh viên × một bài. Lần 1–3 = band AI từng lần; TR–GRA theo lần tốt nhất; GV = điểm giảng viên.', head.length);
  semTable(sh, 4, [head], rows, { widths:[120,90,170,220,45,110,55,55,55,55,55,45,45,45,45,55,55,55,55,70,240,200,90],
                                  wrap:[4, 21, 22] });
  if (rows.length) {
    sh.getRange(5, 8, rows.length, 13).setNumberFormat('0.0').setHorizontalAlignment('center');
    semBandFormat(sh, [sh.getRange(5, 8, rows.length, 4), sh.getRange(5, 20, rows.length, 1)]);
  }
  sh.setFrozenColumns(3);
}

function semTranslateTab(sh, D) {
  var head = ['Lớp','Student ID','Họ tên','Bộ câu','Hạn','Số lượt','Điểm cao nhất (%)','Điểm gần nhất (%)','Điểm TB (%)','Số câu đã qua','Đạt'];
  var rows = D.translate.slice().sort(function(a, b){
    return String(a.cls).localeCompare(String(b.cls)) || String(a.title).localeCompare(String(b.title), 'vi') ||
           String(a.sid).localeCompare(String(b.sid), 'vi', { numeric:true });
  }).map(function(x){
    return [(D.cls[x.cls] || {}).name || x.cls, x.sid, x.name || (D.students[x.sid] || {}).name || '', semText(x.title),
            x.deadline ? rtFmt(x.deadline) : '', x.runs, x.best, x.last, x.avg, x.cleared, x.passed ? '✓' : ''];
  });
  semTitle(sh, 'Translate Practice', 'Mỗi dòng: một sinh viên × một bộ câu.', head.length);
  semTable(sh, 4, [head], rows, { widths:[120,90,170,220,110,60,110,110,90,90,50] });
  if (rows.length) {
    sh.getRange(5, 6, rows.length, 6).setHorizontalAlignment('center');
    var rule = SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#F4C7C3', SpreadsheetApp.InterpolationType.NUMBER, '50')
      .setGradientMidpointWithValue('#FCE8B2', SpreadsheetApp.InterpolationType.NUMBER, '75')
      .setGradientMaxpointWithValue('#B7E1CD', SpreadsheetApp.InterpolationType.NUMBER, '95')
      .setRanges([sh.getRange(5, 7, rows.length, 3)]).build();
    sh.setConditionalFormatRules(sh.getConditionalFormatRules().concat([rule]));
  }
}

function semStudentsTab(sh, D) {
  var head = ['Lớp','Student ID','Họ tên','Email','Số điện thoại','Homework đã nộp','In-class đã nộp','Free-writing (bài)','Translate (bộ)'];
  var rows = [];
  D.classes.forEach(function(c){
    var nHw = D.assigns.filter(function(a){ return a.cls === c.id && a.mode === 'homework' && (a.active || semHasWork(D, 'homework', a.tid)); }).length;
    var nIc = D.assigns.filter(function(a){ return a.cls === c.id && a.mode === 'inclass' && (a.active || semHasWork(D, 'inclass', a.tid)); }).length;
    semRoster(D, c.id).forEach(function(s){
      var cnt = function(m){ return D.groups[m].filter(function(g){ return g.cls === c.id && g.sid === s.sid && D.asgBy[g.tid]; }).length; };
      rows.push([c.name, s.sid, s.name, s.email, semText(s.phone), cnt('homework') + '/' + nHw, cnt('inclass') + '/' + nIc,
                 D.groups.free.filter(function(g){ return g.cls === c.id && g.sid === s.sid; }).length,
                 D.translate.filter(function(x){ return x.cls === c.id && x.sid === s.sid; }).length]);
    });
  });
  semTitle(sh, 'Danh sách sinh viên', 'Sĩ số và mức độ tham gia theo lớp.', head.length);
  semTable(sh, 4, [head], rows, { widths:[120,90,180,220,110,110,110,110,100] });
  if (rows.length) sh.getRange(5, 6, rows.length, 4).setHorizontalAlignment('center');
}

// ── Formatting helpers ─────────────────────────────────────────
function semTitle(sh, title, sub, width) {
  width = Math.max(width, 4);
  sh.getRange(1, 1, 1, width).merge().setValue(title)
    .setFontSize(15).setFontWeight('bold').setFontColor('#FFFFFF').setBackground(SEM_NAVY).setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);
  sh.getRange(2, 1, 1, width).merge().setValue(sub).setFontStyle('italic').setFontColor(SEM_GREY).setFontSize(9);
}

/*  head: array of header rows; rows: data. Header in blue with white bold
    text, data with light banding and thin borders, header rows frozen. */
function semTable(sh, top, head, rows, opt) {
  var width = head[0].length, hN = head.length;
  sh.getRange(top, 1, hN, width).setValues(head)
    .setBackground(SEM_BLUE).setFontColor('#FFFFFF').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  if (rows.length) {
    var data = sh.getRange(top + hN, 1, rows.length, width);
    data.setValues(rows).setVerticalAlignment('middle').setFontSize(10);
    data.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
    (opt.wrap || []).forEach(function(c){ sh.getRange(top + hN, c, rows.length, 1).setWrap(true); });
  }
  sh.getRange(top, 1, hN + Math.max(rows.length, 0), width)
    .setBorder(true, true, true, true, true, true, '#D0D7DE', SpreadsheetApp.BorderStyle.SOLID);
  sh.setFrozenRows(top + hN - 1);
  (opt.widths || []).forEach(function(w, i){ if (i < width) sh.setColumnWidth(i + 1, w); });
}

// Red → amber → green on IELTS bands (4 → 6 → 8); text like "—" is ignored
function semBandFormat(sh, ranges) {
  if (!ranges.length) return;
  var rule = SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpointWithValue('#F4C7C3', SpreadsheetApp.InterpolationType.NUMBER, '4')
    .setGradientMidpointWithValue('#FCE8B2', SpreadsheetApp.InterpolationType.NUMBER, '6')
    .setGradientMaxpointWithValue('#B7E1CD', SpreadsheetApp.InterpolationType.NUMBER, '8')
    .setRanges(ranges).build();
  sh.setConditionalFormatRules(sh.getConditionalFormatRules().concat([rule]));
}

// Plain text safe for a cell: no formula injection from student/teacher text
function semText(v) {
  var s = String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function rtNum(v) { var n = parseFloat(v); return isNaN(n) ? '' : n; }

// ── Mail ───────────────────────────────────────────────────────
function semDoneMail(job) {
  var S = job.summary || [];
  var pct = function(v){ return v === '' || v == null ? '—' : Math.round(v * 100) + '%'; };
  var td = function(v, left){ return '<td' + (left ? '' : ' align="center"') + '>' + rtEsc(v === '' || v == null ? '—' : v) + '</td>'; };
  var rows = S.map(function(o){
    return '<tr style="border-bottom:1px solid #E5E9EE">' + td(o.name + ' (' + o.id + ')', 1) + td(o.students) +
      td(o.homework) + td(pct(o.homeworkRate)) + td(o.homeworkBand) + td(o.inclass) + td(pct(o.inclassRate)) + td(o.inclassBand) +
      td(o.free) + td(o.translate) + '</tr>';
  }).join('');
  var th = function(t){ return '<th style="padding:6px 8px">' + t + '</th>'; };
  var wiped = job.wipe
    ? '<div style="background:#FEF2F2;border:1px solid #FADCD9;color:#7A1A12;padding:10px 12px;border-radius:8px;margin:12px 0">' +
      '🗑 Đã xoá <b>' + (job.deleted || 0) + '</b> dòng dữ liệu bài viết của ' + S.length + ' lớp. ' +
      'Các lớp đã được lưu trữ và tài khoản sinh viên của các lớp này tạm khoá đăng nhập (không bị xoá). ' +
      'Nếu dạy lại lớp nào ở học kỳ mới: Settings ▸ <b>Lớp đã lưu trữ</b> ▸ <b>Khôi phục</b> — sinh viên đăng nhập và dùng tiếp như cũ.</div>'
    : '<p style="color:#5B6B7A">Chỉ xuất báo cáo — dữ liệu trên ứng dụng được giữ nguyên.</p>';
  MailApp.sendEmail({
    to: job.teacherEmail, name: 'ArticuWrite',
    subject: '[ArticuWrite] ' + (job.wipe ? 'Tổng kết học kỳ & reset dữ liệu' : 'Báo cáo tổng kết học kỳ') + ' — ' + S.length + ' lớp',
    htmlBody: rtMailWrap(
      '<h2 style="color:#0A3D62;font-size:18px;margin:0 0 8px">📊 Báo cáo tổng kết học kỳ</h2>' +
      '<p>Báo cáo đầy đủ (bảng điểm từng lớp, chi tiết từng bài, Translate, danh sách sinh viên) đã được tạo trên Google Sheets:</p>' +
      '<p style="margin:14px 0"><a href="' + rtEsc(job.reportUrl) + '" style="background:#0A6EBD;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none;font-weight:bold">📊 Mở báo cáo Google Sheets</a></p>' +
      '<table cellpadding="6" style="border-collapse:collapse;font-size:13px">' +
      '<tr style="background:#0A3D62;color:#fff">' + th('Lớp') + th('Sĩ số') + th('HW') + th('Nộp HW') + th('Band HW') +
      th('IC') + th('Nộp IC') + th('Band IC') + th('Free') + th('Translate') + '</tr>' + rows + '</table>' + wiped +
      '<p style="color:#5B6B7A;font-size:12px">Bài viết và nhận xét chi tiết của sinh viên vẫn nằm trong các Google Doc trên Drive (link trong báo cáo).</p>',
      'Email tự động từ ArticuWrite.')
  });
}

function semFailMail(job, err) {
  try {
    MailApp.sendEmail({
      to: job.teacherEmail, name: 'ArticuWrite',
      subject: '[ArticuWrite] Không tạo được báo cáo học kỳ — dữ liệu CHƯA bị xoá',
      htmlBody: rtMailWrap('<p>Hệ thống không tạo được báo cáo Google Sheets nên <b>chưa xoá dữ liệu nào</b>.</p>' +
        '<p>Lỗi: <code>' + rtEsc(err && err.message || err) + '</code></p><p>Thầy/cô có thể thử lại trong Settings.</p>',
        'Email tự động từ ArticuWrite.')
    });
  } catch (e) {}
}
