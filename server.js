require('dotenv').config();

const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

/* ============================================================
   STARTUP DIAGNOSTICS
   ============================================================ */
const log = (icon, msg) => console.log(`${icon} ${msg}`);
const line = () => console.log('─'.repeat(60));

line();
log('🔧', 'STARTUP DIAGNOSTICS');
line();

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  log('❌', `.env NOT found at ${envPath}`);
  process.exit(1);
}
log('✅', '.env file found');

const REQUIRED = ['JWT_SECRET', 'EXAMINER_PASSWORD', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
let envOK = true;
for (const key of REQUIRED) {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    log('❌', `Missing env var: ${key}`);
    envOK = false;
  } else {
    const preview = key.includes('KEY') || key.includes('SECRET') || key.includes('PASSWORD')
      ? val.slice(0, 12) + '...' + val.slice(-4)
      : val;
    log('✅', `${key} = ${preview}`);
  }
}
if (!envOK) process.exit(1);
line();

/* ============================================================
   SUPABASE
   ============================================================ */
const SUPABASE_URL = process.env.SUPABASE_URL.trim().replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY.trim();

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

async function testSupabase() {
  line();
  log('🔌', 'TESTING SUPABASE');
  line();
  for (const t of ['questions', 'rooms', 'students', 'submissions']) {
    const { error } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (error) log('❌', `Table "${t}": ${error.message}`);
    else log('✅', `Table "${t}" OK`);
  }
  try {
    const { data } = await sb.from('questions').select('id,title');
    if (!data || data.length === 0) log('⚠️ ', 'No questions seeded');
    else {
      log('✅', `Found ${data.length} question(s):`);
      data.forEach(q => log('   ', `• ${q.id} — ${q.title}`));
    }
  } catch (e) { log('❌', e.message); }
  line();
  log('🚀', `Ready → http://localhost:${process.env.PORT || 3000}/login`);
  line();
}

/* ============================================================
   AUTH
   ============================================================ */
const issueToken = () => jwt.sign({ role: 'examiner' }, process.env.JWT_SECRET, { expiresIn: '12h' });
const verifyToken = (t) => { try { return jwt.verify(t, process.env.JWT_SECRET); } catch { return null; } };
const requireExaminer = (req, res, next) => {
  const t = req.cookies?.token;
  const p = t && verifyToken(t);
  if (p?.role !== 'examiner') return res.status(401).json({ error: 'unauthorized' });
  next();
};

/* ============================================================
   DB HELPERS
   ============================================================ */
const DB = {
  listQuestions: async () => {
    const { data, error } = await sb.from('questions').select('id,title');
    if (error) throw new Error(error.message);
    return data;
  },

  getRoom: async (code) => {
    const { data, error } = await sb.from('rooms')
      .select('*, questions(*)').eq('code', code.toUpperCase()).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  createRoom: async (code, questionId) => {
    const { error } = await sb.from('rooms').insert({ code, question_id: questionId });
    if (error) throw new Error(error.message);
  },

  startRoom: async (code) => {
    const { error } = await sb.from('rooms').update({
      started_at: new Date().toISOString(),
      ends_at: null,
      is_active: true
    }).eq('code', code);
    if (error) throw new Error(error.message);
  },

  endRoom: async (code) => {
    const { error } = await sb.from('rooms').update({ is_active: false }).eq('code', code);
    if (error) throw new Error(error.message);
  },

  resetRoom: async (code) => {
    await sb.from('rooms').update({ started_at: null, ends_at: null, is_active: false }).eq('code', code);
    await sb.from('submissions').delete().eq('room_code', code);
    await sb.from('students').delete().eq('room_code', code);
  },

  upsertStudent: async (roomCode, name, socketId) => {
    const { data: existing } = await sb.from('students')
      .select('id').eq('room_code', roomCode).eq('name', name).maybeSingle();
    if (existing) {
      await sb.from('students').update({ socket_id: socketId }).eq('id', existing.id);
      return existing.id;
    }
    const { data, error } = await sb.from('students')
      .insert({ room_code: roomCode, name, socket_id: socketId }).select('id').single();
    if (error) throw new Error(error.message);
    return data.id;
  },

  // No time_taken anymore — only code, language, and submitted_at
  saveSubmission: async (roomCode, studentId, code, language) => {
    const { data, error } = await sb.from('submissions').upsert({
      room_code: roomCode,
      student_id: studentId,
      code, language,
      submitted_at: new Date().toISOString(),
      time_taken: null
    }, { onConflict: 'room_code,student_id' }).select('id').single();
    if (error) throw new Error(error.message);
    return data.id;
  },

  getFullSubmission: async (studentId) => {
    const { data, error } = await sb.from('submissions').select('*, students(name)')
      .eq('student_id', studentId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  // Leaderboard = submissions only, sorted by submission order (earliest first)
  getLeaderboard: async (roomCode) => {
    const { data, error } = await sb.from('submissions')
      .select('student_id, submitted_at, students(name)')
      .eq('room_code', roomCode)
      .not('submitted_at', 'is', null);
    if (error) throw new Error(error.message);
    return (data || []).map(s => ({
      id: s.student_id,
      name: s.students?.name || 'Unknown',
      submittedAt: s.submitted_at
    })).sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
  },

  removeStudent: async (studentId) => {
    await sb.from('submissions').delete().eq('student_id', studentId);
    const { error } = await sb.from('students').delete().eq('id', studentId);
    if (error) throw new Error(error.message);
  }
};

/* ============================================================
   EXPRESS
   ============================================================ */
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(cookieParser());

const CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
header{display:flex;justify-content:space-between;align-items:center;padding:14px 24px;background:#1e293b;border-bottom:1px solid #334155}
button{background:#38bdf8;color:#0f172a;border:none;padding:9px 16px;border-radius:6px;font-weight:600;cursor:pointer;margin-left:6px}
button:disabled{opacity:.4;cursor:not-allowed}
button.danger{background:#ef4444;color:white}
input,select{width:100%;padding:10px 12px;border-radius:6px;border:1px solid #334155;background:#0b1220;color:white;font-size:14px;margin-bottom:10px}
.card{background:#1e293b;border-radius:12px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
.center{display:grid;place-items:center;min-height:100vh}
.container{max-width:900px;margin:0 auto;padding:24px}
.pill{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase}
.pill.idle{background:#334155;color:#94a3b8}
.pill.live{background:#14532d;color:#4ade80}
.muted{color:#94a3b8}
.toolbar{display:flex;justify-content:space-between;align-items:center;margin:12px 0}
.toolbar select{width:auto;margin:0}
.CodeMirror{height:380px;border-radius:8px;font-size:14px}
.layout{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px}
.panel{background:#1e293b;border-radius:10px;padding:16px}
.panel h3{margin-top:0}
.row{display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid #334155;cursor:pointer;border-radius:6px;gap:8px}
.row:hover{background:#334155}
.rank{display:inline-block;width:32px;color:#38bdf8;font-weight:700}
.remove-btn{background:#ef4444;color:white;padding:5px 10px;font-size:12px;border:none;border-radius:4px;cursor:pointer;margin:0}
.remove-btn:hover{background:#dc2626}
pre{background:#0b1220;padding:14px;border-radius:8px;overflow:auto;max-height:400px;white-space:pre-wrap}
code{background:#1e293b;padding:1px 4px;border-radius:3px}
`;

const LOGIN_HTML = `<!DOCTYPE html><html><head><title>Login</title>
<style>${CSS}</style></head><body class="center">
<div class="card" style="width:340px">
  <h2>🎛️ Examiner Login</h2>
  <input id="pw" type="password" placeholder="Password"/>
  <button onclick="login()" style="width:100%">Login</button>
  <p id="err" style="color:#f87171"></p>
</div>
<script>
async function login(){
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});
  if(r.ok){
    const j=await r.json();
    localStorage.setItem('examiner_token',j.token);
    location.href='/examiner';
  }else{
    document.getElementById('err').textContent='Wrong password';
  }
}
pw.addEventListener('keydown',e=>e.key==='Enter'&&login());
</script></body></html>`;

const EXAMINER_HTML = `<!DOCTYPE html><html><head><title>Examiner</title>
<style>${CSS}</style></head><body>
<header>
  <div>🎛️ Examiner — Room <strong id="roomCode">—</strong> <span id="status" class="pill idle">idle</span></div>
  <div>
    <button id="startBtn" onclick="start()" disabled>▶ Start</button>
    <button class="danger" onclick="reset()" disabled>⟲ Reset</button>
  </div>
</header>
<div id="setup" class="card" style="max-width:520px;margin:40px auto">
  <h2>Create a Room</h2>
  <label>Question</label>
  <select id="qSel"><option>Loading...</option></select>
  <button onclick="createRoom()" style="margin-top:14px;width:100%">Create Room →</button>
  <p id="setupErr" style="color:#f87171"></p>
</div>
<div id="dash" style="display:none">
  <div class="layout">
    <div class="panel">
      <h3>Submissions <span id="count" class="muted"></span></h3>
      <div id="board"></div>
    </div>
    <div class="panel">
      <h3>Student Response</h3>
      <div id="detail"><p class="muted">Click a student to view their code.</p></div>
    </div>
  </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
let socket,roomCode=null;
const $=id=>document.getElementById(id);

(async()=>{
  try{
    const r=await fetch('/api/questions');
    if(r.status===401) return location.href='/login';
    const qs=await r.json();
    if(!qs.length){
      $('qSel').innerHTML='<option value="">— No questions —</option>';
      return;
    }
    $('qSel').innerHTML=qs.map(q=>'<option value="'+q.id+'">'+q.title+'</option>').join('');
  }catch(e){ $('setupErr').textContent='Error: '+e.message; }
})();

async function createRoom(){
  $('setupErr').textContent='';
  const qid=$('qSel').value;
  if(!qid) return $('setupErr').textContent='No question selected';

  const r=await fetch('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questionId:qid})});
  if(!r.ok) return $('setupErr').textContent='Create failed: '+await r.text();
  const {code}=await r.json();

  roomCode=code;
  $('roomCode').textContent=code;
  $('setup').style.display='none';
  $('dash').style.display='block';

  socket=io();
  socket.on('connect',()=>{
    socket.emit('examiner:auth',{token:localStorage.getItem('examiner_token')});
  });
  socket.on('examiner:auth',r=>{
    if(!r.ok){
      localStorage.removeItem('examiner_token');
      return location.href='/login';
    }
    socket.emit('examiner:join-room',{code});
    $('startBtn').disabled=false;
  });

  socket.on('round:start',()=>{$('status').textContent='live';$('status').className='pill live';});
  socket.on('round:end',()=>{$('status').textContent='ended';$('status').className='pill idle';});
  socket.on('round:reset',()=>{
    $('board').innerHTML='';
    $('detail').innerHTML='<p class="muted">Click a student to view their code.</p>';
  });

  socket.on('leaderboard',list=>{
    if(!list.length){
      $('board').innerHTML='<p class="muted">No submissions yet. Waiting...</p>';
    } else {
      $('board').innerHTML=list.map((s,i)=>
        '<div class="row" onclick="viewStudent(\\''+s.id+'\\')">'+
          '<div><span class="rank">#'+(i+1)+'</span>'+esc(s.name)+'</div>'+
          '<div>'+
            '<button class="remove-btn" onclick="event.stopPropagation();removeStudent(\\''+s.id+'\\',\\''+esc(s.name)+'\\')">Remove</button>'+
          '</div>'+
        '</div>').join('');
    }
    $('count').textContent='('+list.length+')';
  });

  socket.on('student:detail',s=>{
    $('detail').innerHTML=
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">'+
        '<strong>'+esc(s.name||'')+'</strong>'+
        '<span class="muted" style="font-size:12px">'+
          (s.submittedAt ? new Date(s.submittedAt).toLocaleTimeString() : '')+
        '</span>'+
      '</div>'+
      '<pre>'+esc(s.code||'// no submission')+'</pre>';
  });

  socket.on('student:kicked',({studentId})=>{
    $('detail').innerHTML='<p class="muted">Student was removed.</p>';
  });
}

function start(){socket.emit('examiner:start');}
function reset(){if(confirm('Reset all submissions and students?'))socket.emit('examiner:reset');}
function viewStudent(id){socket.emit('examiner:view',{studentId:id});}
function removeStudent(id,name){
  if(!confirm('Remove '+name+' from this room? Their submission will be deleted.')) return;
  socket.emit('examiner:remove-student',{studentId:id});
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
</script></body></html>`;

const STUDENT_HTML = `<!DOCTYPE html><html><head><title>Student</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.css">
<style>${CSS}</style></head><body>
<header>
  <div>💻 Code Challenge · Room <strong id="roomCode">—</strong></div>
</header>
<div id="joinCard" class="card" style="max-width:380px;margin:60px auto">
  <h2>Join a Quiz</h2>
  <input id="code" placeholder="Room code"/>
  <input id="name" placeholder="Your name"/>
  <button onclick="join()" style="width:100%">Join</button>
  <p id="err" style="color:#f87171"></p>
</div>
<div id="quiz" style="display:none" class="container">
  <h2 id="qTitle"></h2>
  <p id="qDesc" class="muted" style="white-space:pre-wrap"></p>
  <div class="toolbar">
    <select id="lang">
      <option value="javascript">JavaScript</option>
      <option value="python">Python</option>
    </select>
    <span id="status" class="muted"></span>
  </div>
  <textarea id="editor"></textarea>
  <button id="submitBtn" onclick="submit()" style="margin-top:12px">Submit</button>
</div>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/javascript/javascript.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/python/python.js"></script>
<script src="/socket.io/socket.io.js"></script>
<script>
const socket=io();
const $=id=>document.getElementById(id);
let editor,submitted=false,room;

editor=CodeMirror.fromTextArea($('editor'),{
  lineNumbers:false,
  gutters:[],
  theme:'default'
});

const m=location.pathname.match(/\\/join\\/([A-Z0-9]+)/i)||location.pathname.match(/^\\/([A-F0-9]{6})$/i);
if(m) $('code').value=m[1].toUpperCase();

function join(){
  const code=$('code').value.trim().toUpperCase();
  const name=$('name').value.trim();
  if(!code||!name){$('err').textContent='Enter code and name';return;}
  socket.emit('student:join',{code,name});
}
socket.on('join:error',msg=>$('err').textContent=msg);

socket.on('room:state',s=>{
  room=s;
  $('joinCard').style.display='none';
  $('quiz').style.display='block';
  $('roomCode').textContent=s.code;
  $('qTitle').textContent=s.question.title;
  $('qDesc').textContent=s.question.description;
  editor.setValue(s.question.starterCode[s.language]||'');
  $('lang').value=s.language;
});

$('lang').addEventListener('change',e=>{
  const lang=e.target.value;
  if(room) editor.setValue(room.question.starterCode[lang]||'');
});

socket.on('round:start',()=>{
  submitted=false;
  $('status').textContent='Round started';
  $('submitBtn').disabled=false;
  $('submitBtn').textContent='Submit';
});

socket.on('round:end',()=>{
  $('submitBtn').disabled=true;
});

socket.on('round:reset',()=>{
  $('submitBtn').disabled=false;
  $('submitBtn').textContent='Submit';
  $('status').textContent='';
  submitted=false;
});

socket.on('student:kicked',()=>{
  alert('You have been removed from this room by the examiner.');
  location.reload();
});

function submit(){
  if(submitted) return;
  submitted=true;
  $('submitBtn').disabled=true;
  $('submitBtn').textContent='Submitted ✓';
  $('status').textContent='Submitting...';
  socket.emit('student:submit',{code:editor.getValue(),language:$('lang').value});
}

socket.on('submitted:ack',()=>{
  $('status').textContent='✅ Submitted';
});
</script></body></html>`;

/* ---------- API ROUTES ---------- */
app.post('/api/login', (req, res) => {
  if (req.body.password !== process.env.EXAMINER_PASSWORD)
    return res.status(401).json({ error: 'wrong password' });
  const token = issueToken();
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, token });
});

app.get('/api/questions', requireExaminer, async (req, res) => {
  try { res.json(await DB.listQuestions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms', requireExaminer, async (req, res) => {
  try {
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    await DB.createRoom(code, req.body.questionId);
    console.log(`✅ Room created: ${code}`);
    res.json({ code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug', async (req, res) => {
  const out = { tables: {}, questions: [], rooms: [] };
  for (const t of ['questions', 'rooms', 'students', 'submissions']) {
    const { error, count } = await sb.from(t).select('*', { count: 'exact', head: true });
    out.tables[t] = error ? `ERROR: ${error.message}` : `OK (${count} rows)`;
  }
  out.questions = (await sb.from('questions').select('id,title')).data || [];
  out.rooms = (await sb.from('rooms').select('code,question_id,is_active').order('created_at', { ascending: false }).limit(10)).data || [];
  res.json(out);
});

/* ---------- PAGES ---------- */
app.get('/login', (_, res) => res.send(LOGIN_HTML));
app.get('/examiner', (_, res) => res.send(EXAMINER_HTML));
app.get('/student', (_, res) => res.send(STUDENT_HTML));
app.get('/join/:code', (_, res) => res.send(STUDENT_HTML));
app.get('/', (_, res) => res.redirect('/login'));

app.get('/:code', (req, res, next) => {
  if (/^[A-F0-9]{6}$/.test(req.params.code.toUpperCase()))
    return res.send(STUDENT_HTML);
  next();
});

/* ============================================================
   SOCKET.IO
   ============================================================ */
const examinerSockets = new Map();
const studentSockets = new Map();

io.on('connection', (socket) => {
  let roomCode = null;
  let studentId = null;
  let isExaminer = false;

  socket.on('examiner:auth', (payload) => {
    const p = payload?.token && verifyToken(payload.token);
    isExaminer = p?.role === 'examiner';
    socket.emit('examiner:auth', { ok: isExaminer });
    console.log(isExaminer ? `✅ Examiner auth OK` : `❌ Examiner auth failed`);
  });

  socket.on('examiner:join-room', async (payload) => {
    if (!isExaminer) return;
    try {
      const room = await DB.getRoom(payload.code);
      if (!room) return socket.emit('error', 'room not found');
      roomCode = room.code;
      socket.join(roomCode);
      if (!examinerSockets.has(roomCode)) examinerSockets.set(roomCode, new Set());
      examinerSockets.get(roomCode).add(socket.id);
      await emitLeaderboard(roomCode);
    } catch (e) { console.error('examiner:join-room:', e.message); }
  });

  socket.on('student:join', async (payload) => {
    try {
      const room = await DB.getRoom(payload.code);
      if (!room) return socket.emit('join:error', 'Invalid room code');
      roomCode = room.code;
      socket.join(roomCode);
      studentId = await DB.upsertStudent(roomCode, payload.name.trim(), socket.id);
      studentSockets.set(studentId, socket.id);
      socket.emit('room:state', shapeState(room));
    } catch (e) { socket.emit('join:error', e.message); }
  });

  socket.on('examiner:start', async () => {
    if (!isExaminer || !roomCode) return;
    try {
      await DB.startRoom(roomCode);
      io.to(roomCode).emit('round:start', {});
      await emitLeaderboard(roomCode);
    } catch (e) { console.error('examiner:start:', e.message); }
  });

  socket.on('examiner:reset', async () => {
    if (!isExaminer || !roomCode) return;
    try {
      await DB.resetRoom(roomCode);
      io.to(roomCode).emit('round:reset');
      await emitLeaderboard(roomCode);
    } catch (e) { console.error('examiner:reset:', e.message); }
  });

  socket.on('examiner:view', async (payload) => {
    if (!isExaminer || !roomCode) return;
    try {
      const sub = await DB.getFullSubmission(payload.studentId);
      if (sub) socket.emit('student:detail', {
        id: payload.studentId,
        name: sub.students?.name,
        code: sub.code,
        language: sub.language,
        submittedAt: sub.submitted_at
      });
      else socket.emit('student:detail', { id: payload.studentId, code: '' });
    } catch (e) { console.error('examiner:view:', e.message); }
  });

  socket.on('examiner:remove-student', async (payload) => {
    if (!isExaminer || !roomCode) return;
    try {
      const sid = payload.studentId;
      console.log(`🗑️ Examiner removing student ${sid.slice(0, 8)}`);

      const sSocket = studentSockets.get(sid);
      if (sSocket) {
        io.to(sSocket).emit('student:kicked');
        studentSockets.delete(sid);
      }
      await DB.removeStudent(sid);
      await emitLeaderboard(roomCode);
      socket.emit('student:kicked', { studentId: sid });
    } catch (e) { console.error('examiner:remove-student:', e.message); }
  });

  socket.on('student:submit', async (payload) => {
    if (!roomCode || !studentId) return;
    try {
      const room = await DB.getRoom(roomCode);
      const lang = payload.language || room.language;

      await DB.saveSubmission(roomCode, studentId, payload.code, lang);
      socket.emit('submitted:ack', {});
      await emitLeaderboard(roomCode);

      const full = await DB.getFullSubmission(studentId);
      (examinerSockets.get(roomCode) || new Set()).forEach(id =>
        io.to(id).emit('student:detail', {
          id: studentId,
          name: full?.students?.name,
          code: payload.code,
          language: lang,
          submittedAt: full?.submitted_at
        })
      );
    } catch (e) { console.error('student:submit:', e.message); }
  });

  socket.on('disconnect', () => {
    if (roomCode && examinerSockets.has(roomCode))
      examinerSockets.get(roomCode).delete(socket.id);
  });
});

function shapeState(room) {
  const q = room.questions;
  return {
    code: room.code,
    question: {
      id: q.id, title: q.title, description: q.description,
      starterCode: q.starter_code
    },
    language: room.language,
    isActive: room.is_active
  };
}

async function emitLeaderboard(roomCode) {
  const list = await DB.getLeaderboard(roomCode);
  io.to(roomCode).emit('leaderboard', list);
}

/* ============================================================
   BOOT
   ============================================================ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n🌐 Server listening on http://localhost:${PORT}`);
  await testSupabase();
});