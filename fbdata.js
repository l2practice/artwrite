/*───────────────────────────────────────────────────────────────
  ArticuWrite — Firebase data layer (fbdata.js)

  AW.api(action, payload) lands here when Firebase is switched on
  (AW_FIREBASE.config.apiKey set in aw-common.js). Each action below
  answers from Firestore in the SAME shape the old Apps Script returned,
  so the pages did not have to change. Three kinds of actions:

    ACTIONS      answered here, straight from Firestore
    GAS_FB       Apps Script, Firebase edition (Firebase.gs): accounts,
                 Google Docs / Sheets export — needs admin rights or
                 Google services. Sent with the caller's ID token.
    everything   still on the Google Sheet (Live, annotations, queries,
    else         boards, translate, library, vocab) until it moves over.

  Collections (see firestore.rules):
    users/{uid}          role 'student'|'teacher', studentId, name, classId,
                         teacherUid (students), birthdate, phone, email,
                         archived, createdAt
    loginIndex/{sha256}  sha256(lowercased email) → { sid }   (email sign-in)
    classes/{classId}    classId, className, year, semester, teacherUid,
                         teacherEmail, aiEnabled, archived, createdAt, …
    assignments/{topicId} topicId, mode, classId, teacherUid, topic, prompt,
                         taskType, chartImageId, minWords, writingType,
                         aiNotes, requiredAttempts, durationMin, deadline,
                         active, dataStatus, createdAt
    progress/{uid}       ONE doc per student: studentId, name, classId,
                         teacherUid, items { subId: light row (scores) },
                         tscore { 'mode|topicId': teacher score }
    essays/{subId}       essay + feedback JSON of one attempt (loaded only
                         when someone opens that attempt)
───────────────────────────────────────────────────────────────*/
(function () {
'use strict';

const CFG = window.AW_FIREBASE || {};
const STUDENT_DOMAIN = CFG.studentDomain || 'students.articuwrite.app';

let fs = null, auth = null, FV = null, FP = null, _authReady = null;
function init() {
  if (fs) return;
  firebase.initializeApp(window.__FB_CONFIG || CFG.config);
  fs = firebase.firestore();
  auth = firebase.auth();
  if (window.__FB_EMU) { auth.useEmulator('http://127.0.0.1:9099'); fs.useEmulator('127.0.0.1', 8080); } // tests only
  FV = firebase.firestore.FieldValue;
  FP = firebase.firestore.FieldPath;
  _authReady = new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
}
function authReady() { init(); return _authReady; }

// ── helpers ─────────────────────────────────
// Firebase refuses passwords under 6 characters; older accounts may have one.
// Every place that sets or checks a password pads it the same way (Firebase.gs too).
function authPw(p) { p = String(p == null ? '' : p); return p.length >= 6 ? p : (p + '______').slice(0, 6); }
function loginEmailFor(studentId) {
  return String(studentId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_') + '@' + STUDENT_DOMAIN;
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function genId(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < (n || 10); i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const ok   = data => (data === undefined ? { success: true } : { success: true, data });
const fail = (msg, extra) => Object.assign({ success: false, error: msg }, extra || {});
const str  = v => String(v == null ? '' : v).trim();
const low  = v => str(v).toLowerCase();
const docs = qs => qs.docs.map(d => Object.assign({ _id: d.id }, d.data()));
const nowIso = () => new Date().toISOString();
const ms = v => { const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };
// Map keys become Firestore field names: keep them to [A-Za-z0-9_].
const safeKey = v => str(v).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120);
const tsKey = (mode, topicId) => mode + '|' + str(topicId);

// ── short-lived memo (one page visit re-reads the same lists a lot) ──
const _memo = {};
async function memo(key, ttl, fn) {
  const h = _memo[key];
  if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn();
  _memo[key] = { t: Date.now(), v };
  return v;
}
function forget(prefix) { Object.keys(_memo).forEach(k => { if (!prefix || k.indexOf(prefix) === 0) delete _memo[k]; }); }

// ── current user ────────────────────────────
let _me = null;
async function me() {
  await authReady();
  const u = auth.currentUser;
  if (!u) throw new Error('SESSION_EXPIRED');
  if (_me && _me.uid === u.uid) return _me;
  const d = await fs.doc('users/' + u.uid).get();
  if (!d.exists) throw new Error('SESSION_EXPIRED');
  return (_me = Object.assign({ uid: u.uid }, d.data()));
}
async function teacher() {
  const t = await me();
  if (t.role !== 'teacher') throw Object.assign(new Error('Chỉ giáo viên mới dùng được chức năng này.'), { code: 'not-teacher' });
  return t;
}
async function setPersistence(remember) {
  const P = firebase.auth.Auth.Persistence;
  try { await auth.setPersistence(remember ? P.LOCAL : P.SESSION); } catch (e) {}
}

// ── teacher-side cached lists ───────────────
const myClasses   = t => memo('classes', 60000, async () => docs(await fs.collection('classes').where('teacherUid', '==', t.uid).get()));
const myStudents  = t => memo('students', 60000, async () => docs(await fs.collection('users').where('teacherUid', '==', t.uid).get()));
const classAssign = (t, classId) => memo('assign|' + classId, 60000, async () =>
  docs(await fs.collection('assignments').where('classId', '==', classId).get()));
const classProgress = (t, classId) => memo('progress|' + classId, 20000, async () =>
  docs(await fs.collection('progress').where('teacherUid', '==', t.uid).where('classId', '==', classId).get()));
async function studentByIdForTeacher(t, studentId) {
  const hit = (await myStudents(t)).find(s => str(s.studentId) === str(studentId));
  if (hit) return hit;
  const qs = await fs.collection('users').where('teacherUid', '==', t.uid).where('studentId', '==', str(studentId)).limit(1).get();
  return qs.empty ? null : Object.assign({ _id: qs.docs[0].id }, qs.docs[0].data());
}
function itemsOf(prog) { return Object.values((prog && prog.items) || {}); }
function byTime(a, b) { return ms(a.timestamp) - ms(b.timestamp); }

// ════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════
async function studentLogin(p) {
  init();
  const id = str(p.studentId || p.login);
  if (!id) return fail('Vui lòng nhập Student ID hoặc email.');
  let sid = id;
  if (id.indexOf('@') >= 0) {
    const idx = await fs.doc('loginIndex/' + await sha256Hex(low(id))).get();
    if (!idx.exists) return fail('Sai Student ID/email hoặc mật khẩu.');
    if (idx.data().multi) return fail('Email này gắn với nhiều tài khoản. Hãy đăng nhập bằng Student ID.');
    sid = idx.data().sid;
  }
  await setPersistence(!!p.remember);
  try { await auth.signInWithEmailAndPassword(loginEmailFor(sid), authPw(p.password)); }
  catch (e) {
    const c = e.code || '';
    if (/too-many-requests/.test(c)) return fail('Đăng nhập sai quá nhiều lần. Vui lòng đợi vài phút.');
    if (/network/.test(c)) return fail('Lỗi mạng — kiểm tra kết nối và thử lại.');
    return fail('Sai Student ID/email hoặc mật khẩu.');
  }
  _me = null; forget();
  const u = await me();
  if (u.role !== 'student' || u.archived) { await signOut(); return fail('Sai Student ID/email hoặc mật khẩu.'); }
  const cls = await fs.doc('classes/' + u.classId).get();
  if (cls.exists && cls.data().archived) {
    await signOut();
    return fail('Lớp "' + (cls.data().className || u.classId) + '" đã kết thúc học kỳ nên tài khoản tạm khoá. Liên hệ giảng viên nếu bạn học lại lớp này.');
  }
  return ok({ studentId: u.studentId, name: u.name, class: u.classId, email: u.email || '' });
}

async function teacherLogin(p) {
  init();
  const email = low(p.email);
  if (!email || !p.password) return fail('Sai email hoặc mật khẩu.');
  await setPersistence(!!p.remember);
  try { await auth.signInWithEmailAndPassword(email, authPw(p.password)); }
  catch (e) {
    if (/too-many-requests/.test(e.code || '')) return fail('Đăng nhập sai quá nhiều lần. Vui lòng đợi vài phút.');
    return fail('Sai email hoặc mật khẩu.');
  }
  _me = null; forget();
  const u = await me().catch(() => null);
  if (!u || u.role !== 'teacher') { await signOut(); return fail('Sai email hoặc mật khẩu.'); }
  return ok({ name: u.name || '', email: u.email || email, class: '' });
}

async function signOut() { init(); _me = null; forget(); try { await auth.signOut(); } catch (e) {} }

async function changePassword(p) {
  if (!p.oldPass || !p.newPass) return fail('Thiếu mật khẩu.');
  await me();
  const u = auth.currentUser;
  try { await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, authPw(p.oldPass))); }
  catch (e) { return fail('Sai mật khẩu hiện tại.'); }
  await u.updatePassword(authPw(p.newPass));
  return ok();
}

// Accounts are created by Apps Script (admin), then we sign in here.
async function studentSignup(p) {
  const res = await gas('fb.studentSignup', p, true);
  if (!res || !res.success) return res;
  await setPersistence(false);
  try { await auth.signInWithEmailAndPassword(loginEmailFor(p.studentId), authPw(p.password)); } catch (e) {}
  _me = null; forget();
  return res;
}
async function teacherSignup(p) {
  const res = await gas('fb.teacherSignup', p, true);
  if (!res || !res.success) return res;
  await setPersistence(false);
  try { await auth.signInWithEmailAndPassword(low(p.email), authPw(p.password)); } catch (e) {}
  _me = null; forget();
  return res;
}

// ════════════════════════════════════════════
// CLASSES / STUDENTS
// ════════════════════════════════════════════
function classRow(c) {
  return { classId: c.classId || c._id, className: c.className, year: c.year || '', semester: c.semester || '',
           teacherEmail: c.teacherEmail || '', aiEnabled: c.aiEnabled !== false };
}
async function classCreate(p) {
  const t = await teacher();
  if (!str(p.className)) return fail('Thiếu tên lớp.');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let k = 0; k < 20; k++) {
    id = 'AW-'; for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
    if (!(await fs.doc('classes/' + id).get()).exists) break;
  }
  await fs.doc('classes/' + id).set({
    classId: id, className: str(p.className), year: str(p.year), semester: str(p.semester),
    teacherUid: t.uid, teacherEmail: t.email || '', aiEnabled: true, archived: false, createdAt: nowIso()
  });
  forget('classes');
  return ok({ classId: id, className: p.className, year: p.year, semester: p.semester });
}
async function classList() {
  const t = await teacher();
  const rows = (await myClasses(t)).filter(c => !c.archived)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return ok(rows.map(classRow));
}
async function classGet(p) {
  await me();
  const d = await fs.doc('classes/' + str(p.classId)).get();
  if (!d.exists) return fail('Mã lớp không tồn tại.');
  const r = classRow(Object.assign({ _id: d.id }, d.data()));
  delete r.teacherEmail;
  return ok(r);
}
async function classPatch(classId, patch) {
  const t = await teacher();
  const ref = fs.doc('classes/' + str(classId));
  const d = await ref.get();
  if (!d.exists || d.data().teacherUid !== t.uid) return fail('Class not found.');
  await ref.update(patch);
  forget('classes');
  return null;
}
async function classArchive(p) {
  if (!p.classId) return fail('Missing classId.');
  const e = await classPatch(p.classId, p.archived === false ? { archived: false, archivedAt: '' } : { archived: true, archivedAt: nowIso() });
  return e || ok();
}
async function classSetAiEnabled(p) {
  if (!p.classId) return fail('Missing classId.');
  const e = await classPatch(p.classId, { aiEnabled: p.enabled !== false });
  return e || ok({ classId: p.classId, aiEnabled: p.enabled !== false });
}
async function classListArchived() {
  const t = await teacher();
  const [classes, students] = await Promise.all([myClasses(t), myStudents(t)]);
  const counts = {};
  students.forEach(s => { if (!s.archived) counts[s.classId] = (counts[s.classId] || 0) + 1; });
  return ok(classes.filter(c => c.archived).map(c => ({
    classId: c.classId, className: c.className, year: c.year || '', semester: c.semester || '',
    archivedAt: c.archivedAt || '', reportUrl: c.lastReport || '', students: counts[c.classId] || 0
  })));
}
async function getRoster(p) {
  const t = await teacher();
  const rows = (await myStudents(t)).filter(s => !s.archived && (!p.class || s.classId === str(p.class)));
  rows.sort((a, b) => String(a.studentId).localeCompare(String(b.studentId)));
  return ok(rows.map(s => ({ studentId: s.studentId, name: s.name, email: s.email || '', phone: s.phone || '',
                             birthdate: s.birthdate || '' })));
}
async function archiveStudent(p) {
  if (!p.studentId) return fail('Missing studentId.');
  const t = await teacher();
  const s = await studentByIdForTeacher(t, p.studentId);
  if (!s) return fail('Student not found.');
  await fs.doc('users/' + s._id).update({ archived: p.archived !== false });
  forget('students');
  return ok();
}

// ════════════════════════════════════════════
// ASSIGNMENTS
// ════════════════════════════════════════════
function assignOut(a) {
  return {
    topicId: a.topicId || a._id, mode: a.mode, class: a.classId, topic: a.topic, prompt: a.prompt,
    taskType: a.taskType || 'task2', chartImageId: a.chartImageId || '', aiNotes: a.aiNotes || '',
    requiredAttempts: a.requiredAttempts, durationMin: a.durationMin, deadline: a.deadline,
    dataStatus: a.dataStatus || ''
  };
}
async function getAssignments(p) {
  const u = await me();
  const classId = str(p.class || (u.role === 'student' ? u.classId : ''));
  if (!classId) return ok([]);
  let rows = u.role === 'teacher'
    ? await classAssign(u, classId)
    : docs(await fs.collection('assignments').where('classId', '==', classId).get());
  rows = rows.filter(a => a.active !== false &&
    (!p.mode || a.mode === p.mode) && (!p.taskType || (a.taskType || 'task2') === p.taskType))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return ok(rows.map(assignOut));
}
async function getPrompt(p) {
  if (!p.topicId) return fail('Missing topicId.');
  await me();
  const d = await fs.doc('assignments/' + str(p.topicId)).get();
  if (!d.exists) return ok({ prompt: '', topic: '', taskType: 'task2', chartImageId: '' });
  const a = d.data();
  return ok({ prompt: a.prompt || '', topic: a.topic || '', taskType: a.taskType || 'task2',
              chartImageId: a.chartImageId || '', minWords: a.minWords || 0,
              writingType: a.writingType || 'full_essay', aiNotes: a.aiNotes || '', durationMin: a.durationMin || '' });
}
async function createAssignment(p) {
  const t = await teacher();
  const classId = str(p.class);
  const cls = (await myClasses(t)).find(c => c.classId === classId);
  if (!cls) return fail('Lớp không thuộc tài khoản của bạn.');
  const topicId = safeKey(p.topicId) || ('A' + Date.now().toString(36) + genId(4));
  const taskType = p.taskType === 'task1' ? 'task1' : 'task2';
  await fs.doc('assignments/' + topicId).set({
    topicId, mode: p.mode || 'homework', classId, teacherUid: t.uid, topic: p.topic || '', prompt: p.prompt || '',
    taskType, chartImageId: p.chartImageId || '', minWords: Number(p.minWords) || 0,
    writingType: p.writingType || 'full_essay', aiNotes: p.aiNotes || '',
    requiredAttempts: Number(p.requiredAttempts) || 1, durationMin: p.durationMin || '',
    deadline: p.deadline || '', createdAt: nowIso(), active: true, dataStatus: ''
  });
  forget('assign|');
  return ok({ topicId, taskType });
}
async function updateAssignment(p) {
  if (!p.topicId) return fail('Missing topicId.');
  await teacher();
  const ref = fs.doc('assignments/' + str(p.topicId));
  if (!(await ref.get()).exists) return fail('Assignment not found.');
  const patch = {};
  ['topic', 'prompt', 'deadline', 'aiNotes'].forEach(k => { if (p[k] != null) patch[k] = p[k]; });
  if (p.minWords != null) patch.minWords = Number(p.minWords) || 0;
  if (p.requiredAttempts != null) patch.requiredAttempts = Number(p.requiredAttempts) || 1;
  await ref.update(patch);
  forget('assign|');
  return ok();
}
async function deleteAssignment(p) {
  if (!p.topicId) return fail('Missing topicId.');
  await teacher();
  const ref = fs.doc('assignments/' + str(p.topicId));
  if (!(await ref.get()).exists) return fail('Assignment not found.');
  await ref.update({ active: false });     // soft delete: submissions keep their topic
  forget('assign|');
  return ok();
}

// ════════════════════════════════════════════
// SUBMISSIONS
// ════════════════════════════════════════════
/*  One transaction: numbers the attempt from the student's own progress doc,
    so two saves can never take the same number, and a re-sent save (same
    submissionId) is recognised instead of counted twice.                    */
async function saveResult(p) {
  const u = await me();
  if (u.role !== 'student') return fail('Chỉ sinh viên mới nộp bài được.');
  const mode = p.mode;
  if (['free', 'homework', 'inclass'].indexOf(mode) < 0) return fail('Mode không hợp lệ: ' + mode);
  const topicId = str(p.topicId);
  const subId = safeKey(p.submissionId) || (safeKey(u.studentId) + '_' + Date.now().toString(36) + '_' + genId(5));

  let asg = null;
  if (mode !== 'free' && topicId) {
    const d = await fs.doc('assignments/' + topicId).get();
    asg = d.exists ? d.data() : null;
  }
  const progRef = fs.doc('progress/' + u.uid), essayRef = fs.doc('essays/' + subId);
  return fs.runTransaction(async tx => {
    const snap = await tx.get(progRef);
    const items = (snap.exists && snap.data().items) || {};
    if (items[subId]) return ok({ attempt: Number(items[subId].attempt) || 1, topicId: items[subId].topicId || topicId, duplicate: true });
    const prior = Object.values(items).filter(r => r.mode === mode && str(r.topicId) === topicId).length;
    if (mode !== 'free' && prior >= 3)
      return fail('Bạn đã viết đủ 3 lần cho bài này.', { locked: true, attempt: prior });
    if (asg && asg.dataStatus)
      return fail('Bài này đã được giáo viên lưu trữ (Clear Data), không nộp thêm được.', { locked: true, attempt: prior });
    if (asg && asg.deadline) {
      const dl = ms(asg.deadline);
      if (dl && Date.now() > dl + 86400000)
        return fail('Đã quá hạn nộp bài (deadline: ' + asg.deadline + ').', { locked: true, attempt: prior });
    }
    const attempt = prior + 1, ts = nowIso();
    const light = {
      id: subId, mode, topicId, topic: p.topic || '', taskType: p.taskType || 'task2', classId: u.classId,
      timestamp: ts, startTime: p.startTime || '', finishTime: p.finishTime || '', duration: p.duration || '',
      tr: p.tr != null ? p.tr : '', cc: p.cc != null ? p.cc : '', lr: p.lr != null ? p.lr : '', gra: p.gra != null ? p.gra : '',
      aiGrading: p.aiGrading != null ? p.aiGrading : '', teacherGrading: p.teacherGrading != null ? p.teacherGrading : '',
      attempt, hasFb: String(p.feedback || '').length > 10, noAI: !!p.noAI, docLink: p.docLink || ''
    };
    tx.set(essayRef, { uid: u.uid, studentId: u.studentId, classId: u.classId, teacherUid: u.teacherUid || '',
                       mode, topicId, timestamp: ts, essay: String(p.essay || ''), feedback: String(p.feedback || '') });
    const base = { studentId: u.studentId, name: u.name || '', classId: u.classId, teacherUid: u.teacherUid || '' };
    if (snap.exists) tx.update(progRef, Object.assign(base, { ['items.' + subId]: light }));
    else tx.set(progRef, Object.assign(base, { items: { [subId]: light }, tscore: {} }));
    return ok({ attempt, topicId });
  });
}

async function getAttemptCount(p) {
  const u = await me();
  const d = await fs.doc('progress/' + u.uid).get();
  const n = itemsOf(d.exists ? d.data() : null).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).length;
  return ok({ count: n });
}

async function getEssay(p) {
  await me();
  const d = await fs.doc('essays/' + safeKey(p.id)).get();
  if (!d.exists) return fail('Không tìm thấy bài viết.');
  return ok({ essay: d.data().essay || '', feedback: d.data().feedback || '' });
}

function groupKey(r) { return r.mode + '||' + str(r.topicId); }
function writeOut(r) {
  return { timestamp: r.timestamp, startTime: r.startTime, finishTime: r.finishTime, duration: r.duration,
           overall: r.aiGrading, teacher: r.teacherGrading, tr: r.tr || '', cc: r.cc || '', lr: r.lr || '', gra: r.gra || '' };
}
function bestOf(writes) {
  let best = null;
  writes.forEach(w => { const v = parseFloat(w.overall); if (!isNaN(v) && (best === null || v > best)) best = v; });
  return best;
}

async function getMyResults(p) {
  const u = await me();
  const [progSnap, classSnap] = await Promise.all([
    fs.doc('progress/' + u.uid).get(), fs.doc('classes/' + u.classId).get()]);
  const prog = progSnap.exists ? progSnap.data() : {};
  const asn = {};
  if (u.classId) docs(await fs.collection('assignments').where('classId', '==', u.classId).get())
    .forEach(a => { asn[a.topicId || a._id] = a; });
  const className = classSnap.exists ? (classSnap.data().className || u.classId) : u.classId;
  const groups = {};
  itemsOf(prog).filter(r => !p.mode || r.mode === p.mode).forEach(r => {
    const k = groupKey(r), a = asn[r.topicId] || {};
    if (!groups[k]) {
      let ts = (prog.tscore || {})[tsKey(r.mode, r.topicId)] || null;
      if (ts) { ts = Object.assign({}, ts); delete ts.note; }
      groups[k] = { mode: r.mode, topic: r.topic, topicId: r.topicId, taskType: r.taskType || a.taskType || 'task2',
        chartImageId: a.chartImageId || '', prompt: a.prompt || '', minWords: a.minWords || 0,
        className: r.classId === u.classId ? className : (r.classId || ''),
        assignedDate: a.createdAt || r.timestamp, deadline: a.deadline || '', writes: [], teacherScore: ts };
    }
    if (r.cleared) { groups[k].cleared = true; groups[k].docUrl = r.docUrl || ''; }
    // essay + feedback load on demand (write.getEssay) — keeps this read light
    groups[k].writes.push(Object.assign(writeOut(r), { attempt: r.attempt, essayId: r.id }));
  });
  const out = Object.values(groups).map(g => {
    g.writes.sort(byTime);
    const best = bestOf(g.writes);
    g.bestResult = best !== null ? best : '';
    g.attemptCount = g.writes.length;
    g.latestTime = g.writes.length ? g.writes[g.writes.length - 1].timestamp : '';
    return g;
  }).sort((a, b) => ms(b.latestTime) - ms(a.latestTime));
  return ok(out);
}

async function getResults(p) {
  const t = await teacher();
  const classId = str(p.class);
  const [classes, progs, asg] = await Promise.all([myClasses(t), classProgress(t, classId), classAssign(t, classId)]);
  const classNames = {}, prompts = {};
  classes.forEach(c => { classNames[c.classId] = c.className; });
  asg.forEach(a => { prompts[a.topicId] = { prompt: a.prompt, taskType: a.taskType || 'task2', minWords: Number(a.minWords) || 0 }; });
  const mode = ['free', 'homework', 'inclass'].indexOf(p.mode) >= 0 ? p.mode : 'free';
  const cutoff = Number(p.days) > 0 ? Date.now() - Number(p.days) * 86400000 : 0;
  const groups = {};
  progs.forEach(prog => {
    itemsOf(prog).forEach(r => {
      if (r.mode !== mode || !r.topicId) return;
      if (p.topicId && str(r.topicId) !== str(p.topicId)) return;
      if (cutoff && ms(r.timestamp) < cutoff) return;
      const key = prog.studentId + '||' + r.topicId, pr = prompts[r.topicId] || {};
      if (!groups[key]) groups[key] = {
        studentId: prog.studentId, name: prog.name, class: r.classId || prog.classId,
        className: classNames[r.classId || prog.classId] || r.classId || '',
        topic: r.topic, topicId: r.topicId, taskType: r.taskType || pr.taskType || 'task2',
        prompt: pr.prompt || '', minWords: pr.minWords || 0, writes: [],
        teacherScore: (prog.tscore || {})[tsKey(mode, r.topicId)] || null
      };
      if (r.cleared) { groups[key].cleared = true; groups[key].docUrl = r.docUrl || ''; }
      groups[key].writes.push(Object.assign(writeOut(r), { hasAiFeedback: !!r.hasFb }));
    });
  });
  return ok(Object.values(groups).map(g => {
    g.writes.sort(byTime);
    const best = bestOf(g.writes);
    g.bestResult = best !== null ? best : '';
    g.attemptCount = g.writes.length;
    return g;
  }));
}

async function studentProgress(t, studentId) {
  const s = await studentByIdForTeacher(t, studentId);
  if (!s) return null;
  const d = await fs.doc('progress/' + s._id).get();
  return { uid: s._id, ref: d.ref, data: d.exists ? d.data() : { items: {}, tscore: {} } };
}
async function getAttemptDetail(p) {
  if (!p.studentId || !p.topicId || !p.mode) return fail('Missing params.');
  const t = await teacher();
  const sp = await studentProgress(t, p.studentId);
  if (!sp) return ok([]);
  const rows = itemsOf(sp.data).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byTime);
  const es = await Promise.all(rows.map(r => fs.doc('essays/' + r.id).get().catch(() => null)));
  return ok(rows.map((r, i) => {
    const e = es[i] && es[i].exists ? es[i].data() : {};
    return { attempt: i + 1, timestamp: r.timestamp, duration: r.duration, overall: r.aiGrading,
             tr: r.tr || '', cc: r.cc || '', lr: r.lr || '', gra: r.gra || '',
             essay: e.essay || '', feedback: e.feedback || '' };
  }));
}

// Teacher deletes one attempt so the student can redo it. Remaining attempts
// of that student+topic are renumbered 1..n in time order.
async function deleteAttempt(p) {
  if (!p.studentId || !p.topicId || !p.mode || !p.timestamp) return fail('Thiếu thông tin bài cần xoá.');
  const t = await teacher();
  const s = await studentByIdForTeacher(t, p.studentId);
  if (!s) return fail('Không tìm thấy bài này (có thể đã bị xoá).');
  const ref = fs.doc('progress/' + s._id), target = ms(p.timestamp);
  const res = await fs.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const same = itemsOf(snap.exists ? snap.data() : null)
      .filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byTime);
    const hit = same.find(r => Math.abs(ms(r.timestamp) - target) < 1000 || String(r.timestamp) === String(p.timestamp));
    if (!hit) return fail('Không tìm thấy bài này (có thể đã bị xoá).');
    const args = [new FP('items', hit.id), FV.delete()];
    same.filter(r => r.id !== hit.id).forEach((r, k) => { args.push(new FP('items', r.id, 'attempt'), k + 1); });
    tx.update(ref, ...args);
    tx.delete(fs.doc('essays/' + hit.id));
    return ok();
  });
  forget('progress|');
  return res;
}

async function saveManualScore(p) {
  if (['free', 'homework', 'inclass'].indexOf(p.mode) < 0) return fail('Invalid mode.');
  const t = await teacher();
  const sp = await studentProgress(t, p.studentId);
  const rows = sp ? itemsOf(sp.data).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byTime) : [];
  if (!rows.length) return fail('Submission not found.');
  const score = { tr: p.tr || '', cc: p.cc || '', lr: p.lr || '', gra: p.gra || '', overall: p.overall || '',
                  note: p.note || '', privateNote: p.privateNote || '', gradedAt: nowIso() };
  const args = [new FP('tscore', tsKey(p.mode, p.topicId)), score];
  if (p.overall) args.push(new FP('items', rows[rows.length - 1].id, 'teacherGrading'), p.overall);
  await sp.ref.update(...args);
  forget('progress|');
  return ok();
}

// Annotation itself still lives in the Google Sheet (Live phase); the grade
// it carries belongs on the submission, which is in Firestore now.
async function saveAnnotation(p) {
  const res = await legacy('teacher.saveAnnotation', Object.assign({}, p, { teacherGrading: null }));
  if (res && res.success && p.teacherGrading != null && p.mode) {
    const t = await teacher();
    const sp = await studentProgress(t, p.studentId);
    const rows = sp ? itemsOf(sp.data).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byTime) : [];
    if (rows.length) await sp.ref.update(new FP('items', rows[rows.length - 1].id, 'teacherGrading'), p.teacherGrading);
    forget('progress|');
  }
  return res;
}

async function getOverview(p) {
  const t = await teacher();
  const classId = str(p.class);
  const [students, asg] = await Promise.all([myStudents(t), classId ? classAssign(t, classId) : Promise.resolve([])]);
  const active = asg.filter(a => a.active !== false);
  return ok({
    activeStudents: students.filter(s => !classId || s.classId === classId).length,
    totalAssignments: active.length,
    hwAssignments: active.filter(a => a.mode === 'homework').length,
    icAssignments: active.filter(a => a.mode === 'inclass').length,
    avgScore: '—', totalEssays: '—', feedbackPending: '—'
  });
}

// ════════════════════════════════════════════
// Apps Script
// ════════════════════════════════════════════
// Firebase edition actions (Firebase.gs) — the ID token proves who calls.
async function gas(action, payload, anonymous) {
  init();
  const u = auth.currentUser;
  const idToken = (!anonymous && u) ? await u.getIdToken() : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(window.AW.GAS, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload, idToken }), redirect: 'follow', signal: ctrl.signal
    });
    if (!r.ok) throw new Error('Network error ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
// Still on the Google Sheet: the original transport (fetch + JSONP fallback).
function legacy(action, payload) { return window.AW._legacyApi(action, payload); }

const GAS_FB = {
  'auth.forgotPassword':  p => gas('fb.forgotPassword', p, true),
  'student.edit':         p => gas('fb.studentEdit', p).then(r => { forget('students'); forget('progress|'); return r; }),
  'write.exportDoc':      p => gas('fb.exportDoc', p),
  'teacher.exportResults':p => gas('fb.exportResults', p)
};

// Waiting for their Firestore version (End Course / Clear Data / reset read
// the submissions, which no longer live in the Sheet).
const LATER = ['class.endSemester', 'class.restore', 'assign.clearData', 'admin.resetTab',
               'write.getHistory', 'write.getAttempt', 'write.getSubmissions', 'write.backfillFeedback'];

const ACTIONS = {
  'auth.studentLogin': studentLogin, 'auth.teacherLogin': teacherLogin,
  'auth.studentSignup': studentSignup, 'auth.teacherSignup': teacherSignup,
  'auth.changePassword': changePassword,
  'class.create': classCreate, 'class.list': classList, 'class.get': classGet, 'class.roster': getRoster,
  'class.archive': classArchive, 'class.setAiEnabled': classSetAiEnabled, 'class.listArchived': classListArchived,
  'student.archive': archiveStudent,
  'write.saveResult': saveResult, 'write.getAssignments': getAssignments, 'write.getPrompt': getPrompt,
  'write.getAttemptCount': getAttemptCount, 'write.getMyResults': getMyResults, 'write.getEssay': getEssay,
  'teacher.getResults': getResults, 'teacher.getAttemptDetail': getAttemptDetail,
  'teacher.deleteAttempt': deleteAttempt, 'teacher.saveManualScore': saveManualScore,
  'teacher.saveAnnotation': saveAnnotation, 'teacher.getOverview': getOverview,
  'teacher.createAssignment': createAssignment, 'teacher.updateAssignment': updateAssignment,
  'teacher.deleteAssignment': deleteAssignment
};

async function call(action, payload) {
  init();
  payload = payload || {};
  try {
    if (ACTIONS[action]) return await ACTIONS[action](payload);
    if (GAS_FB[action]) return await GAS_FB[action](payload);
    if (LATER.indexOf(action) >= 0)
      return fail('Chức năng này đang được chuyển sang Firebase và sẽ hoạt động lại ở bản cập nhật tới.');
    return await legacy(action, payload);
  } catch (e) {
    const code = (e && e.code) || '';
    if (e && (e.message === 'SESSION_EXPIRED' || /unauthenticated/.test(code))) return fail('SESSION_EXPIRED');
    if (/permission-denied/.test(code)) return fail(auth && auth.currentUser ? 'Bạn không có quyền truy cập dữ liệu này.' : 'SESSION_EXPIRED');
    if (/unavailable|deadline-exceeded/.test(code)) return fail('Không kết nối được máy chủ — kiểm tra mạng và thử lại.');
    console.error('[fbdata] ' + action, e);
    return fail((e && e.message) || String(e));
  }
}

window.FB = {
  call, authReady, signOut,
  isSignedIn: async () => { await authReady(); return !!auth.currentUser; },
  _helpers: { authPw, loginEmailFor, safeKey, forget }
};
})();
