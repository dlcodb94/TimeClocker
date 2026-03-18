// ── STATE ──────────────────────────────────────────────────────
const LS = {
  get: (k, fallback) => {
    try {
      const v = localStorage.getItem(k);
      return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set: (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }
};

let timerInterval = null;
let endTime = null;
let phase = 1; // 1 = rest, 2 = prep
let restDuration = 600;  // seconds
let prepDuration = 60;   // seconds
let wakeLock = null;
let lastWarnSec = -1;    // tracks last second we beeped

// ── AUDIO ──────────────────────────────────────────────────────

// 공유 AudioContext (브라우저 제한 우회)
let _audioCtx = null;
function getCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

// 비상벨 단일 삡 — square + sawtooth 레이어, 귀 찌르는 소리
function playAlarmBeep(freq = 900, duration = 0.18, vol = 0.55, startOffset = 0) {
  try {
    const ctx = getCtx();
    const t = ctx.currentTime + startOffset;

    // Layer 1: square wave (메인 비프)
    const osc1 = ctx.createOscillator();
    const g1   = ctx.createGain();
    osc1.type = 'square';
    osc1.frequency.value = freq;
    g1.gain.setValueAtTime(0, t);
    g1.gain.linearRampToValueAtTime(vol, t + 0.005);       // 빠른 attack
    g1.gain.setValueAtTime(vol, t + duration - 0.02);
    g1.gain.linearRampToValueAtTime(0, t + duration);      // 빠른 release
    osc1.connect(g1); g1.connect(ctx.destination);
    osc1.start(t); osc1.stop(t + duration);

    // Layer 2: sawtooth 한 옥타브 위 (짜증 배가)
    const osc2 = ctx.createOscillator();
    const g2   = ctx.createGain();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq * 2;
    g2.gain.setValueAtTime(0, t);
    g2.gain.linearRampToValueAtTime(vol * 0.35, t + 0.005);
    g2.gain.setValueAtTime(vol * 0.35, t + duration - 0.02);
    g2.gain.linearRampToValueAtTime(0, t + duration);
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.start(t); osc2.stop(t + duration);

  } catch {}
}

// Phase 1 → 2 전환: 군 나팔 느낌 (두 음 빠르게)
function playBell() {
  playAlarmBeep(750, 0.15, 0.5, 0);
  playAlarmBeep(1000, 0.25, 0.6, 0.18);
}

// 마지막 10초: 매초 삡! — step 높을수록 더 짜증나게
function playWarnBeep(step) {
  const freq = 700 + step * 50;            // 750 ~ 1200Hz
  const vol  = 0.45 + step * 0.025;
  const dur  = 0.22 - step * 0.008;
  playAlarmBeep(freq, Math.max(0.1, dur), Math.min(vol, 0.75));
}

// 종료: 삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐삐 (빠르게 연속)
function playEndChimes() {
  const count = 22;
  const gap   = 0.10;
  for (let i = 0; i < count; i++) {
    const freq = i % 2 === 0 ? 1100 : 850;
    const vol  = 0.5 + (i / count) * 0.25;
    playAlarmBeep(freq, 0.08, Math.min(vol, 0.8), i * gap);
  }
}

// ── WAKE LOCK ──────────────────────────────────────────────────
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      document.getElementById('wakelock-status').textContent = '🔒 wake lock on';
      wakeLock.addEventListener('release', () => {
        document.getElementById('wakelock-status').textContent = '';
      });
    } catch {}
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  document.getElementById('wakelock-status').textContent = '';
}

// ── CONFIG PAGE ────────────────────────────────────────────────
function getDualSeconds(id) {
  const m = parseInt(document.getElementById(id + '-min').value) || 0;
  const s = parseInt(document.getElementById(id + '-sec').value) || 0;
  return Math.max(1, m * 60 + s);
}

function setDualInputs(id, totalSec) {
  document.getElementById(id + '-min').value = Math.floor(totalSec / 60);
  document.getElementById(id + '-sec').value = totalSec % 60;
}

function stepDual(id, unit, delta) {
  const el  = document.getElementById(`${id}-${unit}`);
  const max = unit === 'min' ? 60 : 59;
  const min = 0;
  el.value  = Math.min(max, Math.max(min, (parseInt(el.value) || 0) + delta));
}

function loadConfig() {
  const savedRest = LS.get('restSec', null);
  const savedPrep = LS.get('prepSec', null);
  if (savedRest !== null) setDualInputs('rest', savedRest);
  if (savedPrep !== null) setDualInputs('prep', savedPrep);
  if (savedRest !== null || savedPrep !== null) {
    const fmt = s => `${Math.floor(s/60)}분 ${s%60}초`;
    document.getElementById('last-config-note').textContent =
      `마지막 설정 — 쉬는시간 ${fmt(savedRest||600)} / 준비시간 ${fmt(savedPrep||60)}`;
  }
}

function startTimer() {
  restDuration = getDualSeconds('rest');
  prepDuration = getDualSeconds('prep');
  LS.set('restSec', restDuration);
  LS.set('prepSec', prepDuration);

  phase = 1;
  lastWarnSec = -1;
  document.body.classList.remove('night');
  clearRedOverlay();
  showPage('timer');
  loadMemo();
  requestWakeLock();
  beginPhase(1);
}

// ── TIMER LOGIC ────────────────────────────────────────────────
function beginPhase(p) {
  phase = p;
  const duration = (p === 1 ? restDuration : prepDuration) * 1000; // already in seconds
  endTime = Date.now() + duration;

  document.getElementById('phase-badge').textContent = `PHASE ${p} / 2`;
  document.getElementById('phase-label').textContent = p === 1 ? '쉬는 시간' : '준비 시간';

  clearInterval(timerInterval);
  timerInterval = setInterval(tick, 250);
  tick();
}

function tick() {
  const remaining = Math.max(0, endTime - Date.now());
  const totalSec  = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;

  document.getElementById('timer-display').textContent =
    `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  // Phase 2: red + beep every second from 10s left down to 0
  if (phase === 2 && totalSec <= 9 && remaining > 0) {
    const step = Math.min(10, 10 - totalSec); // 1(=9s left) … 10(=0s left)
    setRedOverlay(step);
    if (totalSec !== lastWarnSec) {
      lastWarnSec = totalSec;
      playWarnBeep(step);
    }
  }

  if (remaining <= 0) {
    clearInterval(timerInterval);
    if (phase === 1) {
      transitionToNight();
    } else {
      endSequence();
    }
  }
}

// ── RED OVERLAY HELPERS ────────────────────────────────────────
function setRedOverlay(step) {
  const el = document.getElementById('red-overlay');
  el.className = `warn-${step}`;
}

function clearRedOverlay() {
  const el = document.getElementById('red-overlay');
  el.className = '';
}

// ── TRANSITIONS ────────────────────────────────────────────────
function transitionToNight() {
  playBell();
  lastWarnSec = -1;
  clearRedOverlay();
  const overlay = document.getElementById('overlay');
  overlay.classList.add('fade-in');

  setTimeout(() => {
    document.body.classList.add('night');
    overlay.classList.remove('fade-in');
    beginPhase(2);
    rescaleMemo();
  }, 700);
}

function endSequence() {
  playEndChimes();
  releaseWakeLock();
  clearRedOverlay();

  const overlay = document.getElementById('overlay');
  overlay.classList.add('fade-in');
  setTimeout(() => {
    showPage('end');
    overlay.classList.remove('fade-in');
  }, 700);
}

// ── MEMO AUTO-SCALE ────────────────────────────────────────────
const MAX_FONT = 48;
const MIN_FONT = 12;

function rescaleMemo() {
  const ta = document.getElementById('memo-textarea');
  const box = ta.parentElement;
  if (!ta.value) {
    ta.style.fontSize = MAX_FONT + 'px';
    return;
  }

  let size = MAX_FONT;
  ta.style.fontSize = size + 'px';

  while (size > MIN_FONT && (ta.scrollHeight > box.clientHeight || ta.scrollWidth > box.clientWidth)) {
    size -= 1;
    ta.style.fontSize = size + 'px';
  }
}

function loadMemo() {
  const saved = LS.get('memo', '');
  document.getElementById('memo-textarea').value = saved;
  setTimeout(rescaleMemo, 50);
}

// ── PAGE ROUTING ───────────────────────────────────────────────
function showPage(name) {
  ['config-page', 'timer-page', 'end-page'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  const map = { config: 'config-page', timer: 'timer-page', end: 'end-page' };
  const el = document.getElementById(map[name]);
  el.style.display = 'flex';
  el.classList.remove('fade-enter');
  void el.offsetWidth;
  el.classList.add('fade-enter');
}

function goToConfig() {
  clearInterval(timerInterval);
  releaseWakeLock();
  clearRedOverlay();
  document.body.classList.remove('night');
  showPage('config');
  loadConfig();
}

function restartApp() {
  clearRedOverlay();
  document.body.classList.remove('night');
  showPage('config');
  loadConfig();
}

// ── INIT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('memo-textarea').addEventListener('input', (e) => {
    LS.set('memo', e.target.value);
    rescaleMemo();
  });

  const ro = new ResizeObserver(rescaleMemo);
  ro.observe(document.querySelector('.memo-box'));

  loadConfig();
});