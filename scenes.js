'use strict';

// Сцена DASH — приборная панель. Использует общее состояние из app.js:
// g, W, H, state, disp, BANDS, actx, analyser, freqBytes, waveData, tempo, beatPulse, clock
// и помощники alpha / clamp01 / easeOut / isLive.
// Принимает «присутствие» k (0…1) для плавного перетекания режимов.

const TAU = Math.PI * 2;
const F_MIN = 30, F_MAX = 16000;
const xOfFreq = (f) => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN);
const hasSignal = () => !!freqBytes && (isLive() || state.loaded);

// ---------- Основной тон: самая громкая частота 40 Гц – 4 кГц ----------
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (f) => {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
};
const pitch = { f: 0, conf: 0, text: '—', hz: '', lastText: 0 };

function trackPitch() {
  if (!hasSignal()) { pitch.conf *= 0.95; return; }
  const binHz = actx.sampleRate / analyser.fftSize;
  const b0 = Math.max(2, Math.floor(40 / binHz)), b1 = Math.floor(4000 / binHz);
  let best = 0, bi = 0;
  for (let b = b0; b <= b1; b++) if (freqBytes[b] > best) { best = freqBytes[b]; bi = b; }
  if (best < 110) { pitch.conf = Math.max(0, pitch.conf - 0.03); }
  else {
    const a = freqBytes[bi - 1], c = freqBytes[bi + 1];
    const den = a - 2 * best + c;
    const f = (bi + (den ? (0.5 * (a - c)) / den : 0)) * binHz;
    // Сглаживаем в логарифмах, чтобы метка не скакала
    pitch.f = pitch.f ? Math.exp(Math.log(pitch.f) + (Math.log(f) - Math.log(pitch.f)) * 0.12) : f;
    pitch.conf = Math.min(1, pitch.conf + 0.05);
  }
  // Текст обновляем 5 раз в секунду — так его можно прочитать
  if (clock - pitch.lastText > 0.2) {
    pitch.lastText = clock;
    const ok = pitch.conf > 0.4 && pitch.f;
    pitch.text = ok ? noteName(pitch.f) : '—';
    pitch.hz = ok ? `${Math.round(pitch.f)} Гц` : '';
  }
}

function label(text, x, y, align, color, font) {
  g.font = font;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, x, y);
}

// ======================================================================
// DASH — громкость и темп на стрелочных приборах, основной тон и частотные зоны
// ======================================================================
const ZONES = [
  ['Саб', 20, 60],
  ['Бас', 60, 250],
  ['Середина', 250, 2000],
  ['Присутствие', 2000, 6000],
  ['Воздух', 6000, 16000],
];
const dash = { lvl: -60, lvlV: 0, bpm: 60, bpmV: 0, zones: new Float32Array(ZONES.length) };
const MUTED = 'rgba(200,215,240,.6)';

function zoneLevel(f0, f1) {
  if (!hasSignal()) {
    const a = Math.floor(clamp01(xOfFreq(Math.max(F_MIN, f0))) * (BANDS - 1));
    const b = Math.max(a + 1, Math.ceil(clamp01(xOfFreq(f1)) * (BANDS - 1)));
    let s = 0;
    for (let i = a; i < b; i++) s += disp[i];
    return s / (b - a);
  }
  const binHz = actx.sampleRate / analyser.fftSize;
  const b0 = Math.max(1, Math.floor(f0 / binHz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
  let s = 0;
  for (let b = b0; b < b1; b++) s += freqBytes[b];
  return Math.min(1, Math.pow(s / (b1 - b0) / 255, 1.3) * state.sens * 1.2);
}

// Пружина для стрелок: быстро, но без дрожи
function spring(pos, vel, target, dt) {
  vel += ((target - pos) * 45 - vel * 11) * dt;
  return [pos + vel * dt, vel];
}

function drawGauge(cx, cy, R, frac, ticks, title, value, unit, lamp) {
  const { c1, c2, c3 } = state.colors;
  const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
  const fr = clamp01(frac);

  g.save();
  g.lineCap = 'round';
  g.lineWidth = R * 0.09;
  g.strokeStyle = 'rgba(255,255,255,.07)';
  g.beginPath(); g.arc(cx, cy, R, a0, a0 + sweep); g.stroke();

  const cg = g.createConicGradient(a0, cx, cy);
  cg.addColorStop(0, c2);
  cg.addColorStop(0.45, c1);
  cg.addColorStop(0.75, c3);
  cg.addColorStop(1, c3);
  g.strokeStyle = cg;
  g.shadowColor = c1;
  g.shadowBlur = 14;
  if (fr > 0.002) { g.beginPath(); g.arc(cx, cy, R, a0, a0 + sweep * fr); g.stroke(); }
  g.shadowBlur = 0;

  // Деления
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(255,255,255,.25)';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i <= 30; i++) {
    const a = a0 + (sweep * i) / 30;
    const r0 = R * (i % 5 ? 0.8 : 0.76);
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * R * 0.85, cy + Math.sin(a) * R * 0.85);
  }
  g.stroke();
  const fs = Math.max(10, Math.round(R * 0.1));
  const small = `600 ${fs}px "Exo 2", sans-serif`;
  for (const [f, t] of ticks) {
    const a = a0 + sweep * f;
    label(t, cx + Math.cos(a) * R * 0.64, cy + Math.sin(a) * R * 0.64, 'center', 'rgba(200,215,240,.7)', small);
  }

  // Стрелка
  const an = a0 + sweep * fr;
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(2, R * 0.025);
  g.lineCap = 'round';
  g.shadowColor = c1;
  g.shadowBlur = 12;
  g.beginPath();
  g.moveTo(cx - Math.cos(an) * R * 0.12, cy - Math.sin(an) * R * 0.12);
  g.lineTo(cx + Math.cos(an) * R * 0.8, cy + Math.sin(an) * R * 0.8);
  g.stroke();
  g.fillStyle = c1;
  g.beginPath(); g.arc(cx, cy, R * 0.06, 0, TAU); g.fill();
  g.shadowBlur = 0;

  if (lamp != null) {
    g.fillStyle = alpha(c3, 0.15 + lamp * 0.85);
    g.shadowColor = c3;
    g.shadowBlur = lamp * 16;
    g.beginPath(); g.arc(cx, cy - R * 0.36, R * 0.045, 0, TAU); g.fill();
    g.shadowBlur = 0;
  }

  label(value, cx, cy + R * 0.42, 'center', '#fff', `${Math.round(R * 0.26)}px "Russo One", sans-serif`);
  label(unit, cx, cy + R * 0.66, 'center', alpha(c1, 0.9), small);
  label(title, cx, cy + R * 1.08, 'center', MUTED, small);
  g.restore();
}

const LEVEL_TICKS = [[0, '-60'], [1 / 3, '-40'], [2 / 3, '-20'], [5 / 6, '-10'], [1, '0']];
const BPM_TICKS = [60, 80, 100, 120, 140, 160, 180, 200].map((b) => [(b - 60) / 140, String(b)]);

function drawDash(dt, k) {
  const { c1, c2, c3 } = state.colors;
  if (dt > 0) {
    let sum = 0;
    for (let i = 0; i < waveData.length; i++) sum += waveData[i] * waveData[i];
    const db = Math.max(-60, Math.min(0, 20 * Math.log10(Math.sqrt(sum / waveData.length) + 1e-6)));
    [dash.lvl, dash.lvlV] = spring(dash.lvl, dash.lvlV, db, dt);
    [dash.bpm, dash.bpmV] = spring(dash.bpm, dash.bpmV, tempo.value || 60, dt);
    ZONES.forEach(([, f0, f1], i) => {
      const z = zoneLevel(f0, f1);
      dash.zones[i] += (z - dash.zones[i]) * (z > dash.zones[i] ? 0.2 : 0.05);
    });
  }

  // Раскладка: приборы сверху, зоны снизу, весь блок по центру по вертикали.
  // На узком экране тон выносится отдельной строкой под приборы.
  const e = easeOut(clamp01(k));
  const narrow = W < 560;
  const top = 66;
  const avail = H - top - (narrow ? 20 : 56);
  const R = Math.max(40, Math.min(W * (narrow ? 0.2 : 0.15), avail * (narrow ? 0.2 : 0.24))) * (0.85 + 0.15 * state.scale);
  const noteRow = narrow ? 58 : 0;
  const gaugeBlock = R * 2.08 + 48 + noteRow;
  const rowH = Math.max(30, Math.min(58, (avail - gaugeBlock) / ZONES.length));
  const y0 = top + Math.max(0, (avail - gaugeBlock - rowH * ZONES.length) / 2);
  const gy = y0 + R + 18;
  const gx = narrow ? 0.27 : 0.25;

  g.save();
  g.translate(W / 2, H / 2);
  g.scale(0.85 + 0.15 * e, 0.85 + 0.15 * e);
  g.translate(-W / 2, -H / 2);

  drawGauge(W * gx, gy, R, (dash.lvl + 60) / 60, LEVEL_TICKS, 'ГРОМКОСТЬ', String(Math.round(dash.lvl)), 'дБ');
  drawGauge(W * (1 - gx), gy, R, (dash.bpm - 60) / 140, BPM_TICKS, 'ТЕМП', tempo.value ? String(Math.round(tempo.value)) : '—', 'BPM', beatPulse);

  // Основной тон
  g.shadowColor = c1;
  if (narrow) {
    const ny = gy + R * 1.08 + 30 + noteRow / 2;
    label('ОСНОВНОЙ ТОН', W / 2, ny - 16, 'center', MUTED, '600 11px "Exo 2", sans-serif');
    g.shadowBlur = 12;
    label(pitch.hz ? `${pitch.text} · ${pitch.hz}` : '—', W / 2, ny + 8, 'center', c1, '22px "Russo One", sans-serif');
    g.shadowBlur = 0;
  } else {
    const gap = W * 0.5 - R * 2.2;
    const big = Math.max(16, Math.min(46, gap * 0.32));
    label('ОСНОВНОЙ ТОН', W / 2, gy - big * 1.1, 'center', MUTED, `600 ${Math.max(10, big * 0.28)}px "Exo 2", sans-serif`);
    g.shadowBlur = 16;
    label(pitch.text, W / 2, gy, 'center', c1, `${big}px "Russo One", sans-serif`);
    g.shadowBlur = 0;
    label(pitch.hz, W / 2, gy + big * 0.9, 'center', 'rgba(230,240,255,.85)', `600 ${Math.max(11, big * 0.34)}px "Exo 2", sans-serif`);
  }

  // Частотные зоны
  const zTop = gy + R * 1.08 + 30 + noteRow;
  const x0 = Math.max(16, W * (narrow ? 0.05 : 0.08)), x1 = W - x0;
  const labelW = narrow ? Math.max(92, W * 0.3) : Math.min(150, W * 0.24);
  let loud = 0;
  dash.zones.forEach((v, i) => { if (v > dash.zones[loud]) loud = i; });
  ZONES.forEach(([name, f0, f1], i) => {
    const y = zTop + i * rowH + rowH / 2;
    const v = dash.zones[i];
    const isLoud = i === loud && v > 0.15;
    label(name, x0, y - 7, 'left', isLoud ? c1 : 'rgba(230,240,255,.9)', `700 ${narrow ? 13 : 14}px "Exo 2", sans-serif`);
    const range = f1 >= 1000 ? `${f0 >= 1000 ? f0 / 1000 : f0}–${f1 / 1000} кГц` : `${f0}–${f1} Гц`;
    label(range, x0, y + 9, 'left', 'rgba(200,215,240,.5)', '500 11px "Exo 2", sans-serif');
    const bx = x0 + labelW, bw = x1 - bx - 44, bh = Math.max(6, Math.min(12, rowH * 0.3));
    g.fillStyle = 'rgba(255,255,255,.06)';
    g.beginPath(); g.roundRect(bx, y - bh / 2, bw, bh, bh / 2); g.fill();
    if (v > 0.002) {
      const zg = g.createLinearGradient(bx, 0, bx + bw, 0);
      zg.addColorStop(0, c2);
      zg.addColorStop(0.6, c1);
      zg.addColorStop(1, c3);
      g.fillStyle = zg;
      g.shadowColor = c1;
      g.shadowBlur = isLoud ? 12 : 0;
      g.beginPath(); g.roundRect(bx, y - bh / 2, Math.max(bh, bw * clamp01(v)), bh, bh / 2); g.fill();
      g.shadowBlur = 0;
    }
    label(`${Math.round(clamp01(v) * 100)}%`, x1, y, 'right', 'rgba(230,240,255,.85)', '600 13px "Exo 2", sans-serif');
  });
  g.restore();
}
