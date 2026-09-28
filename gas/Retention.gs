/*───────────────────────────────────────────────────────────────
  ArticuWrite — Data retention module (Retention.gs)

  Goal: keep the working tabs small (target < 2,000 raw rows) without
  losing any result.

  1. DEADLINE MAIL — homework / in-class (hourly trigger)
     When an assignment closes (deadline + 1 day, the same cut-off
     saveResult uses), every student in the class gets ONE email:
     attempts, band per attempt, best band, teacher score + note, and the
     link to their feedback Google Doc (created if missing). The teacher
     gets one summary email.

  2. FREE-WRITING LIFECYCLE — automatic
     • 3rd attempt  → result mail within ~1 min (saveResult schedules a
                      run); essay + AI feedback are removed FREE_DAYS later.
     • < 3 attempts → FREE_DAYS after the last attempt: Doc, result mail,
                      then removed.
     "Removed" = summarised into ResultArchive (title, bands, Doc link —
     still shown in the student's Progress and the teacher's Results; a
     click opens the Doc) and the raw rows deleted.

  3. HOMEWORK / IN-CLASS / TRANSLATE RETENTION — teacher-confirmed
     21 days after the deadline the raw rows become purgeable. On login
     the teacher app lists them; the teacher confirms; a background job
     archives and deletes them.

  INSTALL (one time)
    a) Code.gs from this repo already calls into this file.
    b) appsscript.json ▸ oauthScopes includes script.scriptapp.
    c) Run rtInstall() once from the editor (authorise when asked).
       Only work that closes AFTER this moment gets mail, so installing
       never mass-mails old classes; older free-writing is archived
       silently FREE_DAYS after install.
    d) Deploy ▸ Manage deployments ▸ Edit ▸ Version: New version.

  LOCKING: the background worker never holds the script lock for long
  (saveResult waits on it). One worker at a time is ensured by a lease in
  script properties; the lock is taken only around short sheet mutations.
───────────────────────────────────────────────────────────────*/

var RT = {
  DAYS:         21,                  // raw rows kept this long after the deadline
  FREE_DAYS:    10,                  // free-writing: keep essay + AI feedback this long
  FREE_ATTEMPTS:3,                   // free-writing: attempts that complete a topic
  GRACE_MS:     24 * 3600 * 1000,    // saveResult accepts work until deadline + 1 day
  ROW_BUDGET:   2000,                // target for the heavy tabs combined
  BUDGET_MS:    4.5 * 60 * 1000,     // stop well before the 6-min execution limit
  MAIL_RESERVE: 3,                   // keep a few mails for auth.forgotPassword
  ACTIVE_MS:    3 * 60 * 1000,       // a heartbeat this recent = someone is writing
  ARCHIVE:      'ResultArchive',
  MAILLOG:      'DeadlineMailLog',
  P_SINCE:      'RT_NOTIFY_SINCE',
  P_QUEUE:      'RT_PURGE_QUEUE',
  P_REPORT:     'RT_PURGE_REPORT',
  P_LEASE:      'RT_WORKER_LEASE'
};
var RT_DAY = 86400000;

var RT_ARCHIVE_HEAD = [
  'Archived At','Mode','Class','Topic ID','Topic','Task Type','Deadline',
  'Student ID','Name','Attempts','Best','Avg','Last','Passed','Cleared',
  'Teacher Score JSON','Writes JSON','Doc URL','First At','Last At'
];
var RT_MAILLOG_HEAD = ['Topic ID','Student ID','Email','SentAt','Doc URL'];

// ── Router hook ────────────────────────────────────────────────
function rtDispatch(action, p) {
  switch (action) {
    case 'retention.status': return rtStatus(p || {});
    case 'retention.purge':  return rtRequestPurge(p || {});
  }
  return null;
}

// ── One-time setup (run from the editor) ───────────────────────
function rtInstall() {
  rtTab(RT.ARCHIVE); rtTab(RT.MAILLOG);
  rtDropTriggers('rtHourly');
  ScriptApp.newTrigger('rtHourly').timeBased().everyHours(1).create();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(RT.P_SINCE)) props.setProperty(RT.P_SINCE, String(Date.now()));
  Logger.log('Retention installed. Deadline mail for assignments closing after ' +
             new Date(Number(props.getProperty(RT.P_SINCE))));
}

function rtHourly() { rtWorker(); }
function rtKick()   { rtDropTriggers('rtKick'); rtWorker(); }

/*  rtWorker — one background pass: free-writing first (a student is
    waiting on that mail), then queued teacher purges, then deadline mail. */
function rtWorker() {
  if (!rtLease(true)) return;                      // another pass is running
  var t0 = Date.now(), again = 0;
  try {
    var f = rtFreeSweep(t0);
    if (f.partial && !f.quota) again = 1;
    if (rtQueueLoad().length && Date.now() - t0 < RT.BUDGET_MS) {
      if (rtSomeoneWriting()) again = again || 15;   // class in progress — retry later
      else if (rtProcessQueue(t0)) again = 1;
    }
    if (Date.now() - t0 < RT.BUDGET_MS) {
      var s = rtDeadlineSweep(t0);
      if (s.partial && !s.quota) again = again || 1;
    }
  } finally {
    rtLease(false);
  }
  if (again) rtScheduleKick(again);
}

// Single-worker lease. The script lock is held only for the read-modify-write
// of the property, never for the whole pass.
function rtLease(take) {
  var props = PropertiesService.getScriptProperties(), lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return false;
  try {
    if (!take) { props.deleteProperty(RT.P_LEASE); return true; }
    if (Number(props.getProperty(RT.P_LEASE) || 0) > Date.now()) return false;
    props.setProperty(RT.P_LEASE, String(Date.now() + 7 * 60 * 1000));   // > 6-min execution cap
    return true;
  } finally { lock.releaseLock(); }
}

// Run fn holding the script lock (short sheet mutations only)
function rtLocked(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ═══════════════════════════════════════════════════════════════
//  STATUS + PURGE REQUEST (called from teacher.html)
// ═══════════════════════════════════════════════════════════════
function rtStatus(p) {
  if (!p.teacherEmail) return { success:false, error:'Missing teacherEmail.' };
  var scan   = rtScan(p.teacherEmail);
  var counts = {}, total = 0;
  [T.HOMEWORK, T.INCLASS, T.FREE, T.HISTORY, T.ANNOT, T.QUERIES, T.TR_RESULTS].forEach(function(n){
    counts[n] = Math.max(0, rtTab(n).getLastRow() - 1);
    total += counts[n];
  });
  var me = String(p.teacherEmail).trim().toLowerCase();
  var queued = rtQueueLoad().filter(function(j){ return j.teacherEmail === me; });
  var triggerOn = null;
  try {
    triggerOn = ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'rtHourly'; });
  } catch (e) {}
  return { success:true, data:{
    days: RT.DAYS, budget: RT.ROW_BUDGET, total: total, counts: counts,
    items: scan.items, queued: queued, triggerOn: triggerOn
  } };
}

function rtRequestPurge(p) {
  var me = String(p.teacherEmail || '').trim().toLowerCase();
  if (!me) return { success:false, error:'Missing teacherEmail.' };
  var want = (p.items || []).map(function(x){ return x.kind + '|' + x.id; });
  if (!want.length) return { success:false, error:'Chưa chọn mục nào.' };
  var ok = {};
  rtScan(me).items.forEach(function(it){ ok[it.kind + '|' + it.id] = it; });
  var added = rtQueueMutate(function(q){
    var have = {}, n = 0;
    q.forEach(function(j){ have[j.kind + '|' + j.id] = true; });
    want.forEach(function(k){
      var it = ok[k];
      if (!it || have[k]) return;                  // not eligible / not this teacher's / already queued
      q.push({ kind:it.kind, id:it.id, title:it.title, className:it.className,
               teacherEmail:me, queuedAt:nowIso() });
      have[k] = true; n++;
    });
    return n;
  });
  if (added) rtScheduleKick(1);
  return { success:true, data:{
    queued: added,
    queue: rtQueueLoad().filter(function(j){ return j.teacherEmail === me; })
  } };
}

/*  rtScan — what this teacher can purge now. Reads single columns only
    (Topic ID, Class, Timestamp…), never the Essay/Feedback columns, so it
    stays fast even while the tabs are still large.                     */
function rtScan(teacherEmail) {
  var now = Date.now(), cutoff = now - RT.DAYS * RT_DAY;
  var classes = rtTeacherClasses(teacherEmail);
  var asg = {};
  readAll(T.ASSIGN).forEach(function(a){ asg[String(a['Topic ID'])] = a; });
  var items = [];

  // Homework / In-class — one item per assignment
  [['homework', T.HOMEWORK], ['inclass', T.INCLASS]].forEach(function(m){
    var info = rtCols(m[1], ['Topic ID','Topic','Class','Timestamp']);
    var by = {};
    for (var k = 0; k < info.n; k++) {
      var tid = String(rtAt(info, 'Topic ID', k));
      if (!tid) continue;
      var a = asg[tid];
      var owner = String(a ? a['Class'] : rtAt(info, 'Class', k));
      if (!classes.hasOwnProperty(owner)) continue;
      var g = by[tid] || (by[tid] = { cls:owner, topic:rtAt(info, 'Topic', k), rows:0, last:0 });
      g.rows++;
      var t = rtMs(rtAt(info, 'Timestamp', k));
      if (t > g.last) g.last = t;
    }
    Object.keys(by).forEach(function(tid){
      var g = by[tid], a = asg[tid];
      var dl  = a ? rtMs(a['Deadline']) : NaN;
      var end = isNaN(dl) ? g.last : dl;           // no deadline → last submission
      if (!end || end > cutoff) return;
      items.push({
        kind: m[0], id: tid, class: g.cls, className: classes[g.cls],
        title: String((a && a['Topic']) || g.topic || tid),
        deadline: a && a['Deadline'] ? rtIso(a['Deadline']) : '',
        endAt: new Date(end).toISOString(), rows: g.rows
      });
    });
  });

  // Translate sets — one item per set
  var si = rtCols(T.TR_SETS, ['Set ID','Class','Title','Deadline','Session End']);
  var sets = {};
  for (var s = 0; s < si.n; s++) {
    sets[String(rtAt(si, 'Set ID', s))] = {
      cls: String(rtAt(si, 'Class', s)), title: rtAt(si, 'Title', s),
      end: rtMs(rtAt(si, 'Deadline', s) || rtAt(si, 'Session End', s))
    };
  }
  var ri = rtCols(T.TR_RESULTS, ['Set ID','Timestamp']);
  var rb = {};
  for (var r = 0; r < ri.n; r++) {
    var sid = String(rtAt(ri, 'Set ID', r));
    var st = sets[sid];
    if (!st || !classes.hasOwnProperty(st.cls)) continue;
    var y = rb[sid] || (rb[sid] = { rows:0, last:0 });
    y.rows++;
    var rt = rtMs(rtAt(ri, 'Timestamp', r));
    if (rt > y.last) y.last = rt;
  }
  Object.keys(rb).forEach(function(sid){
    var st = sets[sid], y = rb[sid];
    var end = isNaN(st.end) ? y.last : st.end;
    if (!end || end > cutoff) return;
    items.push({ kind:'translate', id:sid, class:st.cls, className:classes[st.cls],
                 title:String(st.title || sid), deadline: isNaN(st.end) ? '' : new Date(st.end).toISOString(),
                 endAt:new Date(end).toISOString(), rows:y.rows });
  });

  items.sort(function(a, b){ return a.endAt < b.endAt ? -1 : a.endAt > b.endAt ? 1 : 0; });
  return { items: items };
}

// ═══════════════════════════════════════════════════════════════
//  PURGE (background)
// ═══════════════════════════════════════════════════════════════
/*  Returns true when work remains. Each job is re-validated against a
    fresh scan so a stale queue can never delete rows that are not yet
    eligible or that belong to another teacher.                        */
function rtProcessQueue(t0) {
  var scans = {}, left = false;
  var queue = rtQueueLoad();
  for (var i = 0; i < queue.length; i++) {
    if (Date.now() - t0 > RT.BUDGET_MS) { left = true; break; }
    var job = queue[i], key = job.kind + '|' + job.id;
    if (!scans[job.teacherEmail]) {
      scans[job.teacherEmail] = {};
      rtScan(job.teacherEmail).items.forEach(function(it){ scans[job.teacherEmail][it.kind + '|' + it.id] = it; });
    }
    var it = scans[job.teacherEmail][key];
    var r = !it ? { deleted:0, docs:0, skipped:true }
          : it.kind === 'translate' ? rtPurgeTranslate(it)
          :                           rtPurgeAssignment(it, t0);
    rtReportAdd(job.teacherEmail, it, r);
    if (r.partial) { left = true; break; }
    rtQueueMutate(function(q){
      for (var j = q.length - 1; j >= 0; j--) if (q[j].kind + '|' + q[j].id === key) q.splice(j, 1);
    });
  }
  rtReportFlush();
  return left;
}

function rtPurgeAssignment(it, t0) {
  var mode = it.kind, tab = mode === 'homework' ? T.HOMEWORK : T.INCLASS;
  var info = rtCols(tab, ['Topic ID']);
  var ks = rtMatch(info, function(k){ return String(rtAt(info, 'Topic ID', k)) === it.id; });
  var groups = rtGroupBy(rtRows(info, ks), 'Student ID');
  var docs = 0;

  // 1. Every student with work gets a complete Doc before anything is deleted
  var sids = Object.keys(groups);
  for (var i = 0; i < sids.length; i++) {
    var g = groups[sids[i]];
    if (rtDocComplete(g)) continue;
    if (Date.now() - t0 > RT.BUDGET_MS) return { deleted:0, docs:docs, partial:true };
    try {
      var res = exportFeedbackDoc({ mode:mode, studentId:sids[i], topicId:it.id });
      if (res && res.success && res.data) g._docUrl = res.data.url;
      docs++;
    } catch (e) { g._docErr = e.message; }
  }

  // 2. Summarise → ResultArchive (skipped if a previous, interrupted run already did it)
  var asg = readAll(T.ASSIGN).filter(function(a){ return String(a['Topic ID']) === it.id; })[0] || {};
  if (!rtArchiveHas(mode, it.id)) {
    rtArchiveAppend(sids.map(function(sid){ return rtWritingSummary(mode, it.id, asg, groups[sid]); }));
  }

  // 3. Delete raw rows (re-read the key column right before deleting)
  var n = 0, byTopic = function(name){
    return rtDeleteWhere(name, ['Topic ID'], function(i, k){ return String(rtAt(i, 'Topic ID', k)) === it.id; });
  };
  n += byTopic(tab);
  n += byTopic(T.HISTORY);
  n += byTopic(T.ANNOT);
  n += byTopic(T.QUERIES);
  n += byTopic(RT.MAILLOG);
  return { deleted:n, docs:docs };
}

function rtPurgeTranslate(it) {
  var cols = ['Set ID','Student ID','Name','Class','Timestamp','Score','Passed','Partial','Cleared Item IDs JSON'];
  var info = rtCols(T.TR_RESULTS, cols);
  var stu = {};
  for (var k = 0; k < info.n; k++) {
    if (String(rtAt(info, 'Set ID', k)) !== it.id) continue;
    var sid = String(rtAt(info, 'Student ID', k)).trim();
    if (!sid) continue;
    var s = stu[sid] || (stu[sid] = { name:rtAt(info, 'Name', k), cls:rtAt(info, 'Class', k),
      runs:0, sum:0, best:0, last:'', lastScore:'', first:'', cleared:0, passed:false });
    var ts = rtIso(rtAt(info, 'Timestamp', k));
    var cl = 0; try { cl = JSON.parse(rtAt(info, 'Cleared Item IDs JSON', k) || '[]').length; } catch (e) {}
    if (cl > s.cleared) s.cleared = cl;
    if (ts && (!s.first || ts < s.first)) s.first = ts;
    if (String(rtAt(info, 'Partial', k)).toUpperCase() === 'TRUE') continue;
    var sc = parseFloat(rtAt(info, 'Score', k)) || 0;
    s.runs++; s.sum += sc;
    if (sc > s.best) s.best = sc;
    if (String(rtAt(info, 'Passed', k)).toUpperCase() === 'TRUE') s.passed = true;
    if (ts >= s.last) { s.last = ts; s.lastScore = sc; }
  }
  if (!rtArchiveHas('translate', it.id)) {
    var now = nowIso();
    rtArchiveAppend(Object.keys(stu).map(function(sid){
      var s = stu[sid];
      return {
        'Archived At':now, 'Mode':'translate', 'Class':s.cls || it.class, 'Topic ID':it.id,
        'Topic':it.title, 'Task Type':'', 'Deadline':it.deadline, 'Student ID':sid, 'Name':s.name,
        'Attempts':s.runs, 'Best':s.runs ? s.best : '', 'Avg':s.runs ? Math.round(s.sum / s.runs) : '',
        'Last':s.lastScore, 'Passed':s.passed ? 'TRUE' : 'FALSE', 'Cleared':s.cleared,
        'Teacher Score JSON':'', 'Writes JSON':'', 'Doc URL':'',
        'First At':s.first, 'Last At':s.last || s.first
      };
    }));
  }
  var n = rtDeleteWhere(T.TR_RESULTS, ['Set ID'], function(i, k){ return String(rtAt(i, 'Set ID', k)) === it.id; });
  return { deleted:n, docs:0 };
}

function rtWritingSummary(mode, topicId, asg, rows) {
  var madeUrl = rows._docUrl || '';               // set by rtPurgeAssignment when it just built the Doc
  rows = rows.slice().sort(function(a, b){ return rtMs(a['Timestamp']) - rtMs(b['Timestamp']); });
  var writes = rows.map(function(r){
    return {
      timestamp:rtIso(r['Timestamp']), startTime:rtIso(r['Start time']), finishTime:rtIso(r['Finish time']),
      duration:r['Duration'], overall:r['AI Grading'], teacher:r['Teacher Grading'],
      tr:r['TR'], cc:r['CC'], lr:r['LR'], gra:r['GRA'], attempt:r['Attempt']
    };
  });
  var bands = writes.map(function(w){ return parseFloat(w.overall); }).filter(function(v){ return !isNaN(v); });
  var tscore = '', docId = '';
  rows.forEach(function(r){
    if (r['Teacher Score']) tscore = String(r['Teacher Score']);
    if (r['Feedback Doc ID']) docId = String(r['Feedback Doc ID']);
  });
  var first = rows[0], lastRow = rows[rows.length - 1];
  return {
    'Archived At':nowIso(), 'Mode':mode, 'Class':first['Class'] || asg['Class'] || '',
    'Topic ID':topicId, 'Topic':first['Topic'] || asg['Topic'] || '',
    'Task Type':first['Task Type'] || asg['Task Type'] || 'task2',
    'Deadline':asg['Deadline'] ? rtIso(asg['Deadline']) : '',
    'Student ID':String(first['Student ID']), 'Name':first['Name'] || '',
    'Attempts':rows.length,
    'Best':bands.length ? Math.max.apply(null, bands) : '',
    'Avg':bands.length ? Math.round(bands.reduce(function(a, b){ return a + b; }, 0) / bands.length * 10) / 10 : '',
    'Last':bands.length ? bands[bands.length - 1] : '',
    'Passed':'', 'Cleared':'',
    'Teacher Score JSON':tscore, 'Writes JSON':JSON.stringify(writes),
    'Doc URL':madeUrl || (docId ? 'https://docs.google.com/document/d/' + docId + '/edit' : ''),
    'First At':rtIso(first['Timestamp']), 'Last At':rtIso(lastRow['Timestamp'])
  };
}

// A Doc is complete when it already holds every attempt and the final summary
function rtDocComplete(rows) {
  var id = '', cnt = 0, sum = false;
  rows.forEach(function(r){
    if (r['Feedback Doc ID']) id = r['Feedback Doc ID'];
    var c = parseInt(r['Feedback Doc Attempts'], 10); if (c > cnt) cnt = c;
    if (String(r['Feedback Doc Summarized'] || '') === '1') sum = true;
  });
  return !!id && cnt >= rows.length && sum;
}

function rtSomeoneWriting() {
  var t = Number(CacheService.getScriptCache().get('lvlast') || 0);   // set by heartbeat()
  return !!t && Date.now() - t < RT.ACTIVE_MS;
}

// ═══════════════════════════════════════════════════════════════
//  DEADLINE MAIL
// ═══════════════════════════════════════════════════════════════
function rtDeadlineSweep(t0) {
  var since = Number(PropertiesService.getScriptProperties().getProperty(RT.P_SINCE) || 0);
  if (!since) return {};
  var now = Date.now();
  var sh = sheet(T.ASSIGN);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = head.indexOf('Notified At');
  if (col === -1) { col = head.length; sh.getRange(1, col + 1).setValue('Notified At'); }
  var ctx = { students:null, classes:null };

  var list = readAll(T.ASSIGN);
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (a['Notified At']) continue;
    if (a['Active'] === false || String(a['Active']).toLowerCase() === 'false') continue;
    if (a['Mode'] !== 'homework' && a['Mode'] !== 'inclass') continue;
    var dl = rtMs(a['Deadline']);
    if (isNaN(dl)) continue;
    var closeAt = dl + RT.GRACE_MS;
    if (closeAt > now || closeAt < since) continue;
    var r = rtNotifyAssignment(a, t0, ctx);
    if (r.partial) return r;
    sh.getRange(a._row, col + 1).setValue(nowIso());
  }
  return {};
}

function rtNotifyAssignment(a, t0, ctx) {
  var tid = String(a['Topic ID']), mode = a['Mode'], cls = String(a['Class']);
  var tab = mode === 'homework' ? T.HOMEWORK : T.INCLASS;
  if (!ctx.students) ctx.students = readAll(T.STUDENTS);
  if (!ctx.classes) {
    ctx.classes = {};
    readAll(T.CLASSES).forEach(function(c){ ctx.classes[String(c['Class ID'])] = c; });
  }
  var klass = ctx.classes[cls] || {};
  var roster = ctx.students.filter(function(s){
    if (s['Archived'] === true || String(s['Archived']).toLowerCase() === 'true') return false;
    return String(s['Class']) === cls;
  });

  var sent = {};
  var log = rtCols(RT.MAILLOG, ['Topic ID','Student ID']);
  for (var k = 0; k < log.n; k++) if (String(rtAt(log, 'Topic ID', k)) === tid) sent[String(rtAt(log, 'Student ID', k))] = true;

  var info = rtCols(tab, ['Topic ID']);
  var groups = rtGroupBy(rtRows(info, rtMatch(info, function(k){ return String(rtAt(info, 'Topic ID', k)) === tid; })), 'Student ID');
  var required = parseInt(a['Required Attempts'], 10) || 1;
  var logSh = rtTab(RT.MAILLOG);

  for (var i = 0; i < roster.length; i++) {
    var s = roster[i], sid = String(s['Student ID']).trim();
    if (sent[sid]) continue;
    if (Date.now() - t0 > RT.BUDGET_MS) return { partial:true };
    if (MailApp.getRemainingDailyQuota() <= RT.MAIL_RESERVE) return { partial:true, quota:true };
    var rows = groups[sid] || [], docUrl = '';
    if (rows.length) {
      try {
        var d = exportFeedbackDoc({ mode:mode, studentId:sid, topicId:tid });
        if (d && d.success && d.data) docUrl = d.data.url;
      } catch (e) {}
    }
    var email = String(s['Email'] || '').trim();
    if (email) {
      MailApp.sendEmail({
        to: email, name: 'ArticuWrite',
        subject: '[ArticuWrite] Kết quả bài "' + rtPlain(a['Topic']) + '" — đã hết hạn nộp',
        htmlBody: rtStudentMail(s, a, klass, rows, required, docUrl)
      });
    }
    logSh.appendRow([tid, sid, email || '(no email)', nowIso(), docUrl]);
    sent[sid] = true;
  }

  // teacher summary — one mail per assignment
  var to = String(klass['Teacher Email'] || '').trim();
  if (to && MailApp.getRemainingDailyQuota() > RT.MAIL_RESERVE) {
    MailApp.sendEmail({
      to: to, name: 'ArticuWrite',
      subject: '[ArticuWrite] Đã gửi kết quả "' + rtPlain(a['Topic']) + '" cho lớp ' + (klass['Class Name'] || cls),
      htmlBody: rtTeacherMail(a, klass, roster, groups, required)
    });
  }
  return {};
}

function rtStudentMail(s, a, klass, rows, required, docUrl) {
  var modeLabel = a['Mode'] === 'homework' ? 'Homework' : 'In-class practice';
  var task = a['Task Type'] === 'task1' ? 'Task 1' : 'Task 2';
  var h = '<p>Chào <b>' + rtEsc(s['Name'] || s['Student ID']) + '</b>,</p>' +
    '<p>Bài <b>' + rtEsc(a['Topic']) + '</b> (' + modeLabel + ' · ' + task + ' · lớp ' +
    rtEsc(klass['Class Name'] || a['Class']) + ') đã hết hạn nộp lúc ' + rtFmt(a['Deadline']) + '.</p>';
  if (!rows.length) {
    h += '<p style="background:#FEF2F2;border:1px solid #FADCD9;color:#B42318;padding:10px 12px;border-radius:8px">' +
         '⚠ Bạn <b>chưa nộp</b> bài này (0/' + required + ' lần). Liên hệ giảng viên nếu cần hỗ trợ.</p>';
  } else {
    h += rtAttemptsHtml(rows, required, rtAiOn(klass)) + rtDocButton(docUrl);
  }
  return rtMailWrap(h, 'Bài viết và nhận xét chi tiết được lưu trong Google Doc trên. Sau ' + RT.DAYS +
    ' ngày kể từ hạn nộp, dữ liệu thô trên ứng dụng sẽ được lưu trữ; điểm vẫn hiển thị trong Results.');
}

// control classes (AI off) must not see AI bands — research design
function rtAiOn(klass) { return String((klass || {})['AI Enabled']).toLowerCase() !== 'false'; }

function rtAttemptsHtml(rows, required, aiOn) {
  rows = rows.slice().sort(function(x, y){ return rtMs(x['Timestamp']) - rtMs(y['Timestamp']); });
  var bands = [];
  var h = '<table cellpadding="6" style="border-collapse:collapse;font-size:13px;margin:8px 0">' +
       '<tr style="background:#0A6EBD;color:#fff"><th align="left">Lần</th><th align="left">Thời gian nộp</th>' +
       (aiOn ? '<th>Band</th><th>TR</th><th>CC</th><th>LR</th><th>GRA</th>' : '') + '</tr>';
  rows.forEach(function(r, i){
    var b = parseFloat(r['AI Grading']); if (!isNaN(b)) bands.push(b);
    h += '<tr style="border-bottom:1px solid #E5E9EE"><td>' + (i + 1) + '</td><td>' + rtFmt(r['Timestamp']) + '</td>' +
         (aiOn ? '<td align="center"><b>' + rtEsc(r['AI Grading']) + '</b></td><td align="center">' + rtEsc(r['TR']) +
         '</td><td align="center">' + rtEsc(r['CC']) + '</td><td align="center">' + rtEsc(r['LR']) +
         '</td><td align="center">' + rtEsc(r['GRA']) + '</td>' : '') + '</tr>';
  });
  h += '</table>';
  h += '<p>Số lần nộp: <b>' + rows.length + '/' + required + '</b>' +
       (rows.length < required ? ' <span style="color:#B42318">(thiếu ' + (required - rows.length) + ' lần)</span>' : '') + '</p>';
  if (aiOn && bands.length) {
    var best = Math.max.apply(null, bands), diff = Math.round((bands[bands.length - 1] - bands[0]) * 10) / 10;
    h += '<p>Band AI cao nhất: <b style="color:#0A6EBD">' + best + '</b>' +
         (bands.length > 1 ? ' · ' + (diff > 0 ? 'tiến bộ +' + diff : diff < 0 ? 'giảm ' + (-diff) : 'giữ nguyên') + ' so với lần đầu' : '') + '</p>';
  }
  var ts = null;
  rows.forEach(function(r){ if (r['Teacher Score']) { try { ts = JSON.parse(r['Teacher Score']); } catch (e) {} } });
  if (ts && (ts.overall || ts.privateNote)) {   // ts.note is the teacher's private note — never mailed
    h += '<div style="background:#EAF6EF;border-radius:8px;padding:10px 12px;margin:8px 0">' +
         (ts.overall ? '<div><b>Điểm giảng viên: ' + rtEsc(ts.overall) + '</b>' +
           ((ts.tr || ts.cc || ts.lr || ts.gra) ? ' (TR ' + rtEsc(ts.tr || '—') + ' · CC ' + rtEsc(ts.cc || '—') +
           ' · LR ' + rtEsc(ts.lr || '—') + ' · GRA ' + rtEsc(ts.gra || '—') + ')' : '') + '</div>' : '') +
         (ts.privateNote ? '<div style="margin-top:6px">💬 ' + rtEsc(ts.privateNote) + '</div>' : '') + '</div>';
  }
  return h;
}

function rtDocButton(docUrl) {
  return docUrl
    ? '<p style="margin:16px 0"><a href="' + rtEsc(docUrl) + '" style="background:#0A6EBD;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none;font-weight:bold">📄 Mở báo cáo nhận xét (Google Docs)</a></p>'
    : '<p style="color:#5B6B7A">Báo cáo Google Docs chưa tạo được — bạn có thể mở từ mục Progress trong ứng dụng.</p>';
}

function rtMailWrap(inner, footer) {
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#10222E;max-width:620px">' + inner +
    '<p style="color:#8A97A3;font-size:12px;margin-top:18px">' + footer + '<br>— ArticuWrite · Dong Nai University</p></div>';
}

function rtTeacherMail(a, klass, roster, groups, required) {
  var done = 0, missing = [];
  var body = roster.map(function(s){
    var sid = String(s['Student ID']).trim(), rows = groups[sid] || [];
    var bands = rows.map(function(r){ return parseFloat(r['AI Grading']); }).filter(function(v){ return !isNaN(v); });
    if (rows.length) done++; else missing.push(s['Name'] || sid);
    return '<tr style="border-bottom:1px solid #E5E9EE"><td>' + rtEsc(sid) + '</td><td>' + rtEsc(s['Name']) + '</td>' +
      '<td align="center">' + rows.length + '/' + required + '</td><td align="center">' +
      (bands.length ? Math.max.apply(null, bands) : '—') + '</td></tr>';
  }).join('');
  var purgeAt = rtMs(a['Deadline']) + RT.DAYS * RT_DAY;
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#10222E;max-width:640px">' +
    '<p>Bài <b>' + rtEsc(a['Topic']) + '</b> — lớp ' + rtEsc(klass['Class Name'] || a['Class']) + ' đã hết hạn. ' +
    'Hệ thống đã gửi email kết quả + link Google Docs cho sinh viên.</p>' +
    '<p>Đã nộp: <b>' + done + '/' + roster.length + '</b>' +
    (missing.length ? ' · Chưa nộp: ' + rtEsc(missing.join(', ')) : '') + '</p>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-size:13px">' +
    '<tr style="background:#0A6EBD;color:#fff"><th align="left">Student ID</th><th align="left">Họ tên</th><th>Số lần</th><th>Best AI</th></tr>' +
    body + '</table>' +
    '<p style="color:#5B6B7A;font-size:12px;margin-top:14px">Dữ liệu thô của bài này đủ điều kiện dọn từ ' + rtFmt(purgeAt) +
    ' (' + RT.DAYS + ' ngày sau hạn). Ứng dụng sẽ nhắc khi thầy/cô đăng nhập.</p></div>';
}

// ═══════════════════════════════════════════════════════════════
//  FREE-WRITING LIFECYCLE (automatic)
// ═══════════════════════════════════════════════════════════════
/*  Group = student × Topic ID. DeadlineMailLog doubles as the state:
      no log row → not mailed yet; log row → mailed at SentAt.
    Work older than rtInstall() is never mailed; it is archived silently
    FREE_DAYS after install.                                            */
function rtFreeSweep(t0) {
  var since = Number(PropertiesService.getScriptProperties().getProperty(RT.P_SINCE) || 0);
  if (!since) return {};
  var now = Date.now(), keep = RT.FREE_DAYS * RT_DAY;
  var info = rtCols(T.FREE, ['Student ID','Topic ID','Timestamp']);
  var groups = {};
  for (var k = 0; k < info.n; k++) {
    var sid = String(rtAt(info, 'Student ID', k)).trim(), tid = String(rtAt(info, 'Topic ID', k)).trim();
    if (!sid || !tid) continue;
    var g = groups[sid + '||' + tid] || (groups[sid + '||' + tid] = { sid:sid, tid:tid, n:0, last:0 });
    g.n++;
    var t = rtMs(rtAt(info, 'Timestamp', k));
    if (t > g.last) g.last = t;
  }
  var keys = Object.keys(groups);
  if (!keys.length) return {};

  var log = rtCols(RT.MAILLOG, ['Topic ID','Student ID','SentAt']), sent = {};
  for (var m = 0; m < log.n; m++) {
    var lk = String(rtAt(log, 'Student ID', m)).trim() + '||' + String(rtAt(log, 'Topic ID', m)).trim();
    if (groups[lk]) sent[lk] = rtMs(rtAt(log, 'SentAt', m)) || now;
  }

  var ctx = {}, due = [];
  for (var i = 0; i < keys.length; i++) {
    var gr = groups[keys[i]];
    if (sent[keys[i]] != null) { if (now - sent[keys[i]] >= keep) due.push(gr); continue; }
    if (gr.last < since)       { if (now - since >= keep) due.push(gr); continue; }
    var complete = gr.n >= RT.FREE_ATTEMPTS, expired = now - gr.last >= keep;
    if (!complete && !expired) continue;
    if (Date.now() - t0 > RT.BUDGET_MS) return { partial:true };
    if (MailApp.getRemainingDailyQuota() <= RT.MAIL_RESERVE) return { partial:true, quota:true };
    rtFreeMail(gr, complete, ctx);
    if (!complete) due.push(gr);                   // waited FREE_DAYS already — archive now
  }
  return due.length ? rtArchiveFree(due, t0) : {};
}

function rtFreeCtx(ctx) {
  if (ctx.students) return ctx;
  ctx.students = {}; ctx.classes = {};
  readAll(T.STUDENTS).forEach(function(s){ ctx.students[String(s['Student ID']).trim()] = s; });
  readAll(T.CLASSES).forEach(function(c){ ctx.classes[String(c['Class ID'])] = c; });
  return ctx;
}

function rtFreeMail(g, complete, ctx) {
  rtFreeCtx(ctx);
  var rows = readRowsFor(T.FREE, g.sid, g.tid);
  if (!rows.length) return;
  var docUrl = '';
  try {
    var d = exportFeedbackDoc({ mode:'free', studentId:g.sid, topicId:g.tid });
    if (d && d.success && d.data) docUrl = d.data.url;
  } catch (e) {}
  var s = ctx.students[g.sid] || {}, klass = ctx.classes[String(rows[0]['Class'] || s['Class'] || '')] || {};
  var email = String(s['Email'] || '').trim(), title = rows[0]['Topic'] || g.tid;
  if (email) {
    var removeOn = rtFmt(Date.now() + RT.FREE_DAYS * RT_DAY).slice(0, 10);
    var lead = complete
      ? '<p>Bạn đã hoàn thành <b>' + rows.length + ' lần</b> viết bài Free-writing <b>' + rtEsc(title) + '</b>. Kết quả:</p>'
      : '<p>Bài Free-writing <b>' + rtEsc(title) + '</b> đã ' + RT.FREE_DAYS + ' ngày chưa có lần viết mới (' +
        rows.length + '/' + RT.FREE_ATTEMPTS + ' lần) nên được tổng kết. Kết quả:</p>';
    var notice = complete
      ? '⏳ Bài viết và nhận xét AI sẽ được <b>xoá khỏi ứng dụng vào ngày ' + removeOn + '</b> (sau ' + RT.FREE_DAYS + ' ngày). '
      : '📦 Bài viết và nhận xét AI được <b>xoá khỏi ứng dụng</b> từ hôm nay. ';
    notice += 'Tên bài, điểm và link Google Doc vẫn lưu trong <b>My Progress</b>. Vui lòng truy cập Google Doc để xem kết quả đầy đủ.';
    MailApp.sendEmail({
      to: email, name: 'ArticuWrite',
      subject: '[ArticuWrite] Kết quả Free-writing "' + rtPlain(title) + '" (' + rows.length + '/' + RT.FREE_ATTEMPTS + ' lần)',
      htmlBody: rtMailWrap(
        '<p>Chào <b>' + rtEsc(s['Name'] || g.sid) + '</b>,</p>' + lead +
        rtAttemptsHtml(rows, RT.FREE_ATTEMPTS, rtAiOn(klass)) + rtDocButton(docUrl) +
        '<p style="background:#FFF8EC;border:1px solid #F3D9A4;color:#8A6410;padding:10px 12px;border-radius:8px">' + notice + '</p>',
        'Email tự động từ ArticuWrite.')
    });
  }
  rtTab(RT.MAILLOG).appendRow([g.tid, g.sid, email || '(no email)', nowIso(), docUrl]);
}

/*  Archive + delete free-writing groups. Each Doc is brought up to date
    first (a student may have written a 4th attempt after the mail).     */
function rtArchiveFree(due, t0) {
  var already = {};
  var ai = rtCols(RT.ARCHIVE, ['Mode','Student ID','Topic ID']);
  for (var k = 0; k < ai.n; k++)
    if (String(rtAt(ai, 'Mode', k)) === 'free') already[String(rtAt(ai, 'Student ID', k)).trim() + '||' + String(rtAt(ai, 'Topic ID', k)).trim()] = true;

  var done = {}, out = [], partial = false;
  for (var i = 0; i < due.length; i++) {
    if (Date.now() - t0 > RT.BUDGET_MS) { partial = true; break; }
    var g = due[i], key = g.sid + '||' + g.tid;
    var rows = readRowsFor(T.FREE, g.sid, g.tid);
    if (!rows.length) continue;
    if (!rtDocHasAll(rows)) {
      try {
        var d = exportFeedbackDoc({ mode:'free', studentId:g.sid, topicId:g.tid });
        if (d && d.success && d.data) rows._docUrl = d.data.url;
      } catch (e) {}
    }
    if (!already[key]) out.push(rtWritingSummary('free', g.tid, {}, rows));
    done[key] = true;
  }
  rtArchiveAppend(out);
  var hit = function(i, k){ return done[String(rtAt(i, 'Student ID', k)).trim() + '||' + String(rtAt(i, 'Topic ID', k)).trim()]; };
  [T.FREE, T.HISTORY, T.ANNOT, T.QUERIES, RT.MAILLOG].forEach(function(name){
    rtDeleteWhere(name, ['Student ID','Topic ID'], hit);
  });
  return partial ? { partial:true } : {};
}

// Doc exists and already contains every stored attempt
function rtDocHasAll(rows) {
  var id = '', cnt = 0;
  rows.forEach(function(r){
    if (r['Feedback Doc ID']) id = r['Feedback Doc ID'];
    var c = parseInt(r['Feedback Doc Attempts'], 10); if (c > cnt) cnt = c;
  });
  return !!id && cnt >= rows.length;
}

// ═══════════════════════════════════════════════════════════════
//  MERGE ARCHIVE INTO RESULT VIEWS
// ═══════════════════════════════════════════════════════════════
/*  Archived attempts carry archived:true and no essay/feedback text; the
    frontend opens g.docUrl for them instead of the in-app detail view.  */
function rtMergeResults(res, p, who) {
  if (!res || !res.success || !Array.isArray(res.data)) return res;
  try {
    var mode = p.mode || (who === 'teacher' ? 'free' : '');
    var rows;
    if (who === 'student') {
      if (!p.studentId) return res;
      rows = rtArchiveFind('Student ID', p.studentId, function(r){
        return r['Mode'] !== 'translate' && (!mode || r['Mode'] === mode);
      });
    } else {
      var cutoff = p.days > 0 ? Date.now() - parseInt(p.days, 10) * RT_DAY : 0;
      rows = rtArchiveFind(p.class ? 'Class' : 'Mode', p.class || mode, function(r){
        if (r['Mode'] !== mode) return false;
        if (p.topicId && String(r['Topic ID']) !== String(p.topicId)) return false;
        if (cutoff && rtMs(r['Last At']) < cutoff) return false;
        return true;
      });
    }
    if (!rows.length) return res;

    var classNames = {}, asg = {};
    readAll(T.CLASSES).forEach(function(c){ classNames[c['Class ID']] = c['Class Name']; });
    readAll(T.ASSIGN).forEach(function(a){ asg[String(a['Topic ID'])] = a; });
    var keyOf = who === 'student'
      ? function(g){ return g.mode + '||' + g.topicId; }
      : function(g){ return g.studentId + '||' + g.topicId; };
    var byKey = {};
    res.data.forEach(function(g){ byKey[keyOf(g)] = g; });

    rows.forEach(function(r){
      var a = asg[String(r['Topic ID'])] || {};
      var writes = [];
      try { writes = JSON.parse(r['Writes JSON'] || '[]'); } catch (e) {}
      writes.forEach(function(w){ w.archived = true; });
      var ts = null;
      try { ts = r['Teacher Score JSON'] ? JSON.parse(r['Teacher Score JSON']) : null; } catch (e) {}
      if (ts && who === 'student') delete ts.note;
      var g = {
        studentId:String(r['Student ID']), name:r['Name'], mode:r['Mode'],
        class:r['Class'], className:classNames[r['Class']] || r['Class'] || '',
        topic:r['Topic'], topicId:String(r['Topic ID']), taskType:r['Task Type'] || 'task2',
        prompt:a['Prompt'] || '', minWords:parseInt(a['Min Words'] || '0', 10) || 0,
        chartImageId:a['Chart Image ID'] || '', assignedDate:a['CreatedAt'] || r['First At'],
        deadline:a['Deadline'] || r['Deadline'] || '',
        writes:writes, teacherScore:ts, docUrl:r['Doc URL'] || '', archived:true
      };
      var hit = byKey[keyOf(g)];
      if (hit) {                                   // raw rows still exist for this key: archived attempts come first
        hit.writes = writes.concat(hit.writes || []);
        hit.teacherScore = hit.teacherScore || ts;
        hit.docUrl = hit.docUrl || g.docUrl;
        g = hit;
      } else {
        res.data.push(g); byKey[keyOf(g)] = g;
      }
      var best = null;
      g.writes.forEach(function(w){ var v = parseFloat(w.overall); if (!isNaN(v) && (best === null || v > best)) best = v; });
      g.bestResult = best !== null ? best : '';
      g.attemptCount = g.writes.length;
      g.latestTime = g.writes.length ? g.writes[g.writes.length - 1].timestamp : '';
    });
    if (who === 'student') res.data.sort(function(x, y){ return new Date(y.latestTime) - new Date(x.latestTime); });
  } catch (e) {
    res.archiveError = e.message;               // never break Results because of the archive
  }
  return res;
}

function rtMergeTranslateStats(res, p) {
  if (!res || !res.success || !res.data || !p.setId) return res;
  try {
    var rows = rtArchiveFind('Topic ID', p.setId, function(r){ return r['Mode'] === 'translate'; });
    if (!rows.length) return res;
    var d = res.data, have = {};
    d.students.forEach(function(s){ have[s.studentId] = true; });
    var sum = (d.avgScore || 0) * (d.runsCount || 0), runs = d.runsCount || 0;
    rows.forEach(function(r){
      var sid = String(r['Student ID']);
      if (have[sid]) return;
      var n = parseInt(r['Attempts'], 10) || 0;
      runs += n; sum += (parseFloat(r['Avg']) || 0) * n;
      var cleared = parseInt(r['Cleared'], 10) || 0;
      d.students.push({
        studentId:sid, name:r['Name'], runs:n, bestScore:parseFloat(r['Best']) || 0,
        lastScore:parseFloat(r['Last']) || 0, clearedCount:cleared, currentIndex:Math.min(20, cleared),
        inProgress:false, lastTimestamp:rtIso(r['Last At']), progressLabel:cleared + '/20', archived:true
      });
    });
    d.studentCount = d.students.length;
    d.runsCount = runs;
    d.avgScore = runs ? Math.round(sum / runs) : 0;
    d.avgCleared = d.students.length
      ? Math.round(d.students.reduce(function(a, s){ return a + (s.clearedCount || 0); }, 0) / d.students.length) : 0;
  } catch (e) {
    res.archiveError = e.message;
  }
  return res;
}

// ═══════════════════════════════════════════════════════════════
//  SHEET HELPERS
// ═══════════════════════════════════════════════════════════════
var _rtSheets = {};                                 // per-execution memo: ss() re-opens the file on every call
function rtTab(name) {
  if (_rtSheets[name]) return _rtSheets[name];
  var head = name === RT.ARCHIVE ? RT_ARCHIVE_HEAD : name === RT.MAILLOG ? RT_MAILLOG_HEAD : null;
  var sh;
  if (!head) sh = sheet(name);
  else {
    var book = ss();
    sh = book.getSheetByName(name);
    if (!sh) {
      sh = book.insertSheet(name);
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  return (_rtSheets[name] = sh);
}

/*  rtCols — read only the named columns. On a 5,000-row submission tab a
    Topic ID column is a few KB; the full rows (Essay + Feedback JSON) are
    tens of MB. Missing columns read as empty.                          */
function rtCols(name, cols) {
  var sh = rtTab(name), lastCol = sh.getLastColumn();
  var head = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var out = { sh:sh, head:head, n:Math.max(0, sh.getLastRow() - 1), idx:{}, col:{} };
  head.forEach(function(h, i){ if (h !== '' && out.idx[h] == null) out.idx[h] = i; });
  cols.forEach(function(c){
    var i = out.idx[c];
    out.col[c] = (i == null || !out.n) ? [] :
      sh.getRange(2, i + 1, out.n, 1).getValues().map(function(r){ return r[0]; });
  });
  return out;
}
function rtAt(info, c, k) { var v = info.col[c] && info.col[c][k]; return v == null ? '' : v; }
function rtMatch(info, fn) { var ks = []; for (var k = 0; k < info.n; k++) if (fn(k)) ks.push(k); return ks; }

// Full rows for data indexes ks (one block read from min..max)
function rtRows(info, ks) {
  if (!ks.length || !info.head.length) return [];
  var lo = Math.min.apply(null, ks), hi = Math.max.apply(null, ks);
  var vals = info.sh.getRange(lo + 2, 1, hi - lo + 1, info.head.length).getValues();
  return ks.map(function(k){
    var r = vals[k - lo], o = { _row:k + 2 };
    info.head.forEach(function(h, i){ if (h !== '' && !(h in o)) o[h] = r[i]; });
    return o;
  });
}

function rtGroupBy(rows, col) {
  var g = {};
  rows.forEach(function(r){
    var k = String(r[col]).trim();
    (g[k] = g[k] || []).push(r);
  });
  return g;
}

/*  Delete matching rows bottom-up in contiguous blocks: one deleteRows call
    per block instead of one per row, and rows appended meanwhile (always
    below the scanned range) are never touched.                          */
function rtDeleteWhere(name, cols, fn) {
  return rtLocked(function(){ return rtDeleteWhereNow(name, cols, fn); });
}
function rtDeleteWhereNow(name, cols, fn) {
  var info = rtCols(name, cols);
  var rows = rtMatch(info, function(k){ return fn(info, k); }).map(function(k){ return k + 2; });
  if (!rows.length) return 0;
  var sh = info.sh;
  if (sh.getMaxRows() - rows.length < 2) sh.insertRowsAfter(sh.getMaxRows(), 1);  // Sheets refuses to delete every non-frozen row
  rows.sort(function(a, b){ return b - a; });
  for (var i = 0; i < rows.length; i++) {
    var end = rows[i], start = end;
    while (i + 1 < rows.length && rows[i + 1] === start - 1) { i++; start--; }
    sh.deleteRows(start, end - start + 1);
  }
  return rows.length;
}

function rtArchiveAppend(objs) {
  if (!objs.length) return;
  var sh = rtTab(RT.ARCHIVE);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  RT_ARCHIVE_HEAD.forEach(function(h){
    if (head.indexOf(h) === -1) { head.push(h); sh.getRange(1, head.length).setValue(h); }
  });
  var values = objs.map(function(o){ return head.map(function(h){ return o[h] != null ? o[h] : ''; }); });
  var start = sh.getLastRow() + 1;
  sh.getRange(start, head.indexOf('Student ID') + 1, values.length, 1).setNumberFormat('@');
  sh.getRange(start, 1, values.length, head.length).setValues(values);
}

function rtArchiveHas(mode, id) {
  var info = rtCols(RT.ARCHIVE, ['Mode','Topic ID']);
  for (var k = 0; k < info.n; k++)
    if (String(rtAt(info, 'Mode', k)) === mode && String(rtAt(info, 'Topic ID', k)) === String(id)) return true;
  return false;
}

function rtArchiveFind(keyCol, keyVal, pred) {
  var info = rtCols(RT.ARCHIVE, [keyCol]);
  var ks = rtMatch(info, function(k){ return String(rtAt(info, keyCol, k)).trim() === String(keyVal).trim(); });
  var rows = rtRows(info, ks);
  return pred ? rows.filter(pred) : rows;
}

function rtTeacherClasses(email) {
  email = String(email || '').trim().toLowerCase();
  var out = {};
  readAll(T.CLASSES).forEach(function(c){
    if (String(c['Teacher Email']).trim().toLowerCase() === email)
      out[String(c['Class ID'])] = c['Class Name'] || c['Class ID'];
  });
  return out;
}

// ── Queue (script properties) ──────────────────────────────────
function rtQueueLoad() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(RT.P_QUEUE) || '[]'); }
  catch (e) { return []; }
}
function rtQueueMutate(fn) {
  var l = LockService.getScriptLock();              // short hold — the worker never keeps it
  l.waitLock(20000);
  try {
    var q = rtQueueLoad(), r = fn(q);
    PropertiesService.getScriptProperties().setProperty(RT.P_QUEUE, JSON.stringify(q));
    return r;
  } finally { l.releaseLock(); }
}

// Per-teacher report, mailed once that teacher's queue is empty
function rtReportAdd(email, it, r) {
  var props = PropertiesService.getScriptProperties();
  var rep = {}; try { rep = JSON.parse(props.getProperty(RT.P_REPORT) || '{}'); } catch (e) {}
  var x = rep[email] || (rep[email] = { items:[], deleted:0, docs:0 });
  x.deleted += r.deleted || 0; x.docs += r.docs || 0;
  if (it && !r.partial) x.items.push((it.className ? it.className + ' · ' : '') + it.title);
  props.setProperty(RT.P_REPORT, JSON.stringify(rep));
}
function rtReportFlush() {
  var props = PropertiesService.getScriptProperties();
  var rep = {}; try { rep = JSON.parse(props.getProperty(RT.P_REPORT) || '{}'); } catch (e) {}
  var q = rtQueueLoad();
  Object.keys(rep).forEach(function(email){
    if (q.some(function(j){ return j.teacherEmail === email; })) return;
    var x = rep[email];
    if (x.items.length && MailApp.getRemainingDailyQuota() > RT.MAIL_RESERVE) {
      MailApp.sendEmail({
        to: email, name: 'ArticuWrite',
        subject: '[ArticuWrite] Đã dọn dữ liệu: ' + x.items.length + ' mục, ' + x.deleted + ' dòng',
        htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px">' +
          '<p>Đã lưu trữ kết quả và xoá <b>' + x.deleted + '</b> dòng dữ liệu thô' +
          (x.docs ? ' (tạo/cập nhật ' + x.docs + ' Google Doc)' : '') + ':</p><ul>' +
          x.items.map(function(t){ return '<li>' + rtEsc(t) + '</li>'; }).join('') + '</ul>' +
          '<p style="color:#5B6B7A;font-size:12px">Điểm vẫn hiển thị trong Results; bài viết đầy đủ nằm trong Google Doc của từng sinh viên.</p></div>'
      });
    }
    delete rep[email];
  });
  props.setProperty(RT.P_REPORT, JSON.stringify(rep));
}

// ── Triggers ───────────────────────────────────────────────────
function rtScheduleKick(minutes) {
  try {
    var exists = ScriptApp.getProjectTriggers().some(function(t){ return t.getHandlerFunction() === 'rtKick'; });
    if (!exists) ScriptApp.newTrigger('rtKick').timeBased().after(Math.max(1, minutes) * 60000).create();
  } catch (e) {
    // scope missing / trigger quota — the hourly trigger still picks the queue up
  }
}
function rtDropTriggers(handler) {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

// ── Small utils ────────────────────────────────────────────────
function rtMs(v) {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}
function rtIso(v) {
  var ms = rtMs(v);
  return isNaN(ms) ? String(v == null ? '' : v) : new Date(ms).toISOString();
}
function rtFmt(v) {
  var ms = rtMs(v);
  return isNaN(ms) ? String(v || '') : Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
}
function rtEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}
function rtPlain(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80); }
