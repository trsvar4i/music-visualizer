'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const app = $('#app');
const deck = $('#deck');
const stage = $('#stage');
const audio = $('#audio');
const canvas = $('#viz');
const g = canvas.getContext('2d');
const fileInput = $('#file');
const progress = $('#progress');
const dropzone = $('#dropzone');
const drawer = $('#drawer');
const bpmBox = $('#bpmBox');
const lightsL = $('#lightsL');
const lightsR = $('#lightsR');
const grilles = [$('#grilleL'), $('#grilleR')].map((c) => ({ c, g: c.getContext('2d') }));

const MODES = ['bars', 'wave', 'circle', 'dash'];
const ROAD_MODES = new Set(['bars', 'wave', 'circle']);      // поверх общей дороги, с искрами
const OPAQUE_MODES = new Set(['bars', 'wave', 'dash']);      // без шлейфа прошлых кадров
// Целевые цвета пресетов (дублируют style.css: CSS-переменные анимируются и в середине перехода отдают промежуточные значения)
const PALETTES = {
  neon:  { c1: '#2ff3ff', c2: '#3a6bff', c3: '#c45bff', b1: '#2f63ff', b2: '#0a1a66' },
  synth: { c1: '#ff4fe8', c2: '#7b3dff', c3: '#ffd23d', b1: '#8a33ff', b2: '#260a55' },
  toxic: { c1: '#8dff3a', c2: '#10c4a4', c3: '#f2ff3c', b1: '#149a76', b2: '#05322a' },
  mack:  { c1: '#ff7040', c2: '#ff2a55', c3: '#ffd23d', b1: '#d8262f', b2: '#46060c' },
};
const PRESETS = Object.keys(PALETTES);
const BANDS = 64;

const MODE_MS = 900;    // длительность перетекания режимов
const COLOR_MS = 1200;  // длительность цветовой волны

// Пять полос, как на автомагнитоле
const EQ_BANDS = [
  { f: 60, type: 'lowshelf', label: '60' },
  { f: 230, type: 'peaking', label: '230' },
  { f: 910, type: 'peaking', label: '910' },
  { f: 3600, type: 'peaking', label: '3.6k' },
  { f: 12000, type: 'highshelf', label: '12k' },
];
const EQ_PRESETS = {
  flat:   { name: 'Ровно',    gains: [0, 0, 0, 0, 0] },
  bass:   { name: 'Бас-буст', gains: [8, 4, 0, 0, 1] },
  sub:    { name: 'Сабвуфер', gains: [12, 6, -2, -1, 0] },
  street: { name: 'Улица',    gains: [6, 2, -3, 3, 6] },
  vocal:  { name: 'Вокал',    gains: [-2, -1, 4, 3, 1] },
  bright: { name: 'Звон',     gains: [-1, 0, 1, 4, 8] },
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

const state = {
  mode: 'bars',
  sens: 1,
  scale: 1,
  volume: 0.9,
  eq: [0, 0, 0, 0, 0],
  eqPreset: 'flat',
  source: 'file',   // file | mic | tab
  loaded: false,
  seeking: false,
  colors: {},
};

const isLive = () => state.source !== 'file';
const isPlaying = () => isLive() || (state.loaded && !audio.paused);

// ---------- Аудио-граф ----------
// Файл → эквалайзер → лимитер → анализатор → громкость → колонки.
// Микрофон и вкладка идут только в анализатор (на колонки не выводим, чтобы не было эха).
let actx = null;
let analyser = null;
let outGain = null;
let eqNodes = [];
let freqBytes = null;
let bandRanges = [];
let liveNode = null;
let liveStream = null;
const waveData = new Float32Array(4096);

function initAudio() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = actx.createAnalyser();
  analyser.fftSize = 4096; // ~11 Гц на бин — хватает, чтобы различать ноты в басу
  analyser.smoothingTimeConstant = 0.78;
  analyser.minDecibels = -88;
  analyser.maxDecibels = -18;

  let node = actx.createMediaElementSource(audio);
  eqNodes = EQ_BANDS.map((b, i) => {
    const f = actx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.f;
    if (b.type === 'peaking') f.Q.value = 1.1;
    f.gain.value = state.eq[i];
    node.connect(f);
    node = f;
    return f;
  });
  // Лимитер, чтобы бас-буст не хрипел
  const limiter = actx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;
  node.connect(limiter);
  limiter.connect(analyser);

  outGain = actx.createGain();
  outGain.gain.value = state.volume;
  analyser.connect(outGain);
  outGain.connect(actx.destination);

  freqBytes = new Uint8Array(analyser.frequencyBinCount);
  buildBandRanges();
}

// Логарифмическая разбивка спектра на полосы: басу достаётся столько же полос, сколько верхам
function buildBandRanges() {
  const nyquist = actx.sampleRate / 2;
  const bins = analyser.frequencyBinCount;
  const fMin = 32, fMax = 16000;
  bandRanges = [];
  for (let i = 0; i < BANDS; i++) {
    const f0 = fMin * Math.pow(fMax / fMin, i / BANDS);
    const f1 = fMin * Math.pow(fMax / fMin, (i + 1) / BANDS);
    const b0 = Math.min(bins - 1, Math.floor((f0 / nyquist) * bins));
    const b1 = Math.min(bins, Math.max(b0 + 1, Math.ceil((f1 / nyquist) * bins)));
    bandRanges.push([b0, b1]);
  }
}

// ---------- Анализ ----------
const raw = new Float32Array(BANDS);
const disp = new Float32Array(BANDS);
const peaks = new Float32Array(BANDS);
let bass = 0, bassSmooth = 0, bassAvg = 0.2, energy = 0;
let lastBeat = 0;
let beatPulse = 0;   // пульс метронома по найденному BPM (0…1)

function sample(t, now) {
  const live = isLive() || state.loaded;

  if (live) {
    analyser.getByteFrequencyData(freqBytes);
    analyser.getFloatTimeDomainData(waveData);
    for (let i = 0; i < BANDS; i++) {
      const [b0, b1] = bandRanges[i];
      let m = 0;
      for (let b = b0; b < b1; b++) if (freqBytes[b] > m) m = freqBytes[b];
      const v = Math.pow(m / 255, 1.5) * (0.85 + (i / BANDS) * 0.5);
      raw[i] = Math.min(1, v * state.sens * 1.15);
    }
  } else {
    // Холостой ход: мягкая «дышащая» анимация, пока ничего не играет
    for (let i = 0; i < BANDS; i++) {
      const v = 0.16 + 0.1 * Math.sin(t * 1.4 + i * 0.32) + 0.07 * Math.sin(t * 2.6 - i * 0.19);
      raw[i] = Math.max(0, v * (1 - (i / BANDS) * 0.55)) * state.sens;
    }
    for (let i = 0; i < waveData.length; i++) {
      const x = i / waveData.length;
      waveData[i] = 0.12 * Math.sin(x * 18 + t * 2) * Math.sin(x * Math.PI) + 0.04 * Math.sin(x * 61 - t * 3);
    }
  }

  // Плавное падение полос и пиков
  let sum = 0;
  for (let i = 0; i < BANDS; i++) {
    disp[i] = raw[i] > disp[i] ? raw[i] : Math.max(raw[i], disp[i] - 0.025);
    peaks[i] = disp[i] > peaks[i] ? disp[i] : Math.max(0, peaks[i] - 0.006);
    sum += disp[i];
  }
  energy = sum / BANDS;

  bass = (disp[0] + disp[1] + disp[2] + disp[3] + disp[4] + disp[5]) / 6;
  bassSmooth += (bass - bassSmooth) * 0.35;
  bassAvg = bassAvg * 0.96 + bass * 0.04;

  // Простой детектор ударов по басу — для вспышек и искр
  if (isPlaying() && bass > bassAvg * 1.25 && bass > 0.35 && now - lastBeat > 200) {
    lastBeat = now;
    onBeat();
  }

  if (isPlaying()) trackTempo(now);
  updateBeatPulse(now);
}

function onBeat() {
  for (const el of [lightsL, lightsR]) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 110);
  }
  spawnBurst(16 + Math.round(bass * 20));
}

// ---------- Темп (BPM) ----------
// Огибающая «всплесков» спектра за последние 8 с → автокорреляция → самый вероятный период.
// Фаза метронома подстраивается под реальные удары, поэтому пульс эффектов попадает в долю.
const TEMPO_FS = 100;       // частота огибающей, Гц
const TEMPO_WINDOW = 8000;  // мс
const tempo = {
  prev: new Float32Array(BANDS),
  hist: [],
  times: [], flux: [],
  lastOnset: 0, anchor: 0, misses: 0,
  value: 0, cand: 0, period: 0, lastCalc: 0,
};

function resetTempo() {
  tempo.hist.length = tempo.times.length = tempo.flux.length = 0;
  tempo.value = tempo.cand = tempo.period = tempo.anchor = 0;
  tempo.prev.fill(0);
  $('#bpm').textContent = '—';
}

function trackTempo(now) {
  let flux = 0;
  for (let i = 0; i < BANDS; i++) {
    const d = raw[i] - tempo.prev[i];
    if (d > 0) flux += d * (i < 12 ? 1.6 : i < 40 ? 1 : 0.5);
    tempo.prev[i] = raw[i];
  }
  tempo.times.push(now);
  tempo.flux.push(flux);
  while (tempo.times.length && now - tempo.times[0] > TEMPO_WINDOW) { tempo.times.shift(); tempo.flux.shift(); }

  // Отдельные удары для подстройки фазы
  const h = tempo.hist;
  h.push(flux);
  if (h.length > 40) h.shift();
  const mean = h.reduce((a, b) => a + b, 0) / h.length;
  if (flux > mean * 1.5 + 0.25 && now - tempo.lastOnset > 250) {
    tempo.lastOnset = now;
    if (tempo.period) {
      const ph = (now - tempo.anchor) / tempo.period;
      if (Math.abs(ph - Math.round(ph)) < 0.18) { tempo.anchor = now; tempo.misses = 0; }
      else if (++tempo.misses > 4) { tempo.anchor = now; tempo.misses = 0; }
    }
  }

  if (now - tempo.lastCalc > 1000) { tempo.lastCalc = now; estimateTempo(); }
}

function estimateTempo() {
  const { times, flux } = tempo;
  if (times.length < 2 || times[times.length - 1] - times[0] < 5000) return;
  const t0 = times[0];
  const n = Math.floor(((times[times.length - 1] - t0) / 1000) * TEMPO_FS) + 1;
  const env = new Float32Array(n);
  let j = 0, held = 0;
  for (let b = 0; b < n; b++) {
    const tb = t0 + (b * 1000) / TEMPO_FS;
    let m = -1;
    while (j < times.length && times[j] <= tb + 1000 / TEMPO_FS) { m = Math.max(m, flux[j]); j++; }
    if (m >= 0) held = m;
    env[b] = held;
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  for (let b = 0; b < n; b++) env[b] = Math.max(0, env[b] - mean);

  const lagMin = Math.floor((60 * TEMPO_FS) / 180);
  const lagMax = Math.ceil((60 * TEMPO_FS) / 70);
  const acf = new Float32Array(lagMax * 2 + 2);
  for (let L = lagMin; L <= lagMax * 2 + 1 && L < n; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
    acf[L] = s / (n - L);
  }
  // Учитываем удвоенный период и мягко предпочитаем «танцевальный» диапазон около 120
  const score = (L) => {
    const bpmL = (60 * TEMPO_FS) / L;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpmL / 120) / 0.7, 2));
    return (acf[L] + 0.5 * (acf[2 * L] || 0)) * w;
  };
  let best = -1, bestL = 0;
  for (let L = lagMin; L <= lagMax; L++) {
    const s = score(L);
    if (s > best) { best = s; bestL = L; }
  }
  if (!bestL || best <= 0) return;
  const a = score(bestL - 1), b = best, c = score(bestL + 1);
  const shift = (a - 2 * b + c) !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const est = (60 * TEMPO_FS) / (bestL + Math.max(-0.5, Math.min(0.5, shift)));

  // Принимаем новое значение, когда оценка повторилась
  if (tempo.value && Math.abs(est - tempo.value) / tempo.value < 0.04) setBpm(tempo.value * 0.7 + est * 0.3);
  else if (tempo.cand && Math.abs(est - tempo.cand) / tempo.cand < 0.04) setBpm(est);
  tempo.cand = est;
}

function setBpm(v) {
  if (!tempo.period) tempo.anchor = tempo.lastOnset || performance.now();
  tempo.value = v;
  tempo.period = 60000 / v;
  $('#bpm').textContent = Math.round(v);
}

function updateBeatPulse(now) {
  if (tempo.period && isPlaying()) {
    const ph = (((now - tempo.anchor) / tempo.period) % 1 + 1) % 1;
    beatPulse = Math.exp(-ph * 5);
  } else {
    beatPulse *= 0.9;
  }
}

// ---------- Канвас ----------
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
}

function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function lerpHex(a, b, t) {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((x >> s) & 255) + (((y >> s) & 255) - ((x >> s) & 255)) * t);
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}
const lerpPalette = (a, b, t) => Object.fromEntries(Object.keys(b).map((k) => [k, lerpHex(a[k], b[k], t)]));

// Переходы: режим «перерастает» в новый, цвет расходится волной из центра
let modeFx = null;   // { from, start }
let colorFx = null;  // { from, start }

let clock = 0;       // секунды, общие часы сцен
let roadPos = 0;     // смещение разметки дороги

// Дорога в перспективе — «мокрый асфальт» под визуализацией
function drawRoad() {
  const { c1, c2 } = state.colors;
  const hy = H * 0.6;
  const vx = W / 2;

  g.save();
  const fog = g.createLinearGradient(0, hy, 0, H);
  fog.addColorStop(0, alpha(c2, 0));
  fog.addColorStop(1, alpha(c2, 0.1));
  g.fillStyle = fog;
  g.fillRect(0, hy, W, H - hy);

  g.lineWidth = 1;
  g.strokeStyle = alpha(c2, 0.22);
  g.beginPath();
  for (let k = -10; k <= 10; k++) {
    g.moveTo(vx, hy);
    g.lineTo(vx + k * W * 0.16, H);
  }
  g.stroke();

  for (let k = 0; k < 10; k++) {
    const p = (k + roadPos) / 10;
    const y = hy + (H - hy) * p * p;
    g.strokeStyle = alpha(c2, 0.05 + p * 0.25);
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }

  const hz = g.createLinearGradient(0, 0, W, 0);
  hz.addColorStop(0, alpha(c1, 0));
  hz.addColorStop(0.5, alpha(c1, 0.35 + bassSmooth * 0.5));
  hz.addColorStop(1, alpha(c1, 0));
  g.strokeStyle = hz;
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, hy); g.lineTo(W, hy); g.stroke();
  g.restore();
}

// Каждый режим рисуется с «присутствием» k: 0 — свёрнут, 1 — полностью развёрнут.
// При переключении старый режим сворачивается, а новый вырастает из центра.

// --- Режим 1: полосы (бас в центре, зеркально в стороны) ---
function drawBars(k) {
  const { c1, c2, c3 } = state.colors;
  const floorY = H * 0.74;
  // На узком экране объединяем соседние полосы попарно — столбики выходят шире и читаемее
  const step = W < 560 ? 2 : 1;
  const cols = BANDS / step;
  const bw = (W * 0.94) / (cols * 2);
  const gap = Math.max(1, bw * 0.28);
  const maxH = floorY * 0.85 * state.scale;
  const val = (arr, c) => (step === 1 ? arr[c] : Math.max(arr[c * 2], arr[c * 2 + 1]));
  // Полосы у центра вырастают первыми, к краям — с задержкой
  const grow = (c) => easeOut(clamp01(k * 1.6 - (c / cols) * 0.6));
  const xr = (c) => W / 2 + c * bw + gap / 2;
  const xl = (c) => W / 2 - (c + 1) * bw + gap / 2;

  const grad = g.createLinearGradient(0, floorY, 0, floorY - maxH);
  grad.addColorStop(0, c2);
  grad.addColorStop(0.55, c1);
  grad.addColorStop(1, c3);

  g.save();
  g.shadowColor = c1;
  g.shadowBlur = 16;
  g.fillStyle = grad;
  for (let c = 0; c < cols; c++) {
    const gc = grow(c);
    if (gc <= 0) continue;
    const h = Math.max(2, val(disp, c) * maxH) * gc;
    g.fillRect(xr(c), floorY - h, bw - gap, h);
    g.fillRect(xl(c), floorY - h, bw - gap, h);
  }
  g.shadowBlur = 10;
  g.shadowColor = c3;
  g.fillStyle = c3;
  for (let c = 0; c < cols; c++) {
    const gc = grow(c);
    if (gc <= 0) continue;
    const y = floorY - val(peaks, c) * maxH * gc - 5;
    g.fillRect(xr(c), y, bw - gap, 3);
    g.fillRect(xl(c), y, bw - gap, 3);
  }
  g.restore();

  // Отражение на асфальте
  g.save();
  const rg = g.createLinearGradient(0, floorY, 0, floorY + maxH * 0.4);
  rg.addColorStop(0, alpha(c1, 0.35));
  rg.addColorStop(1, alpha(c1, 0));
  g.fillStyle = rg;
  for (let c = 0; c < cols; c++) {
    const h = val(disp, c) * maxH * 0.4 * grow(c);
    if (h <= 0) continue;
    g.fillRect(xr(c), floorY + 3, bw - gap, h);
    g.fillRect(xl(c), floorY + 3, bw - gap, h);
  }
  g.restore();
}

// --- Режим 2: осциллограмма ---
// Спокойная версия: окно привязано к переходу через ноль (как синхронизация в осциллографе),
// точки усредняются по соседним сэмплам и плавно догоняют новые значения.
// Медленное «эхо» рисуется второй, приглушённой линией.
const WAVE_PTS = 200;
const waveFast = new Float32Array(WAVE_PTS);
const waveSlow = new Float32Array(WAVE_PTS);
const waveTmp = new Float32Array(WAVE_PTS);

function updateWave() {
  const n = waveData.length;
  const span = Math.floor(n / 2);
  let start = 0;
  for (let i = 1; i < n - span; i++) {
    if (waveData[i - 1] < 0 && waveData[i] >= 0) { start = i; break; }
  }
  const block = span / WAVE_PTS;
  for (let p = 0; p < WAVE_PTS; p++) {
    const a = start + Math.floor(p * block), b = start + Math.floor((p + 1) * block);
    let s = 0;
    for (let i = a; i < b; i++) s += waveData[i];
    waveTmp[p] = s / Math.max(1, b - a);
  }
  // Сглаживание по соседям — убирает мелкую «рябь»
  for (let pass = 0; pass < 2; pass++) {
    let prev = waveTmp[0];
    for (let p = 1; p < WAVE_PTS - 1; p++) {
      const cur = waveTmp[p];
      waveTmp[p] = (prev + cur * 2 + waveTmp[p + 1]) / 4;
      prev = cur;
    }
  }
  for (let p = 0; p < WAVE_PTS; p++) {
    waveFast[p] += (waveTmp[p] - waveFast[p]) * 0.15;
    waveSlow[p] += (waveTmp[p] - waveSlow[p]) * 0.05;
  }
}

function wavePoints(src, mid, amp, k) {
  const pts = [];
  for (let p = 0; p < WAVE_PTS; p++) {
    const x = p / (WAVE_PTS - 1);
    // Края прижаты к центру; при включении режима волна раскачивается из середины
    const taper = Math.pow(Math.sin(x * Math.PI), 0.6);
    const env = k >= 1 ? 1 : easeInOut(clamp01((k * 1.4 - Math.abs(x - 0.5) * 0.8) / 0.4));
    // Мягкое ограничение (tanh): громкий бас скругляется, а не упирается в «полку»
    pts.push([x * W, mid + Math.tanh(src[p] * 1.8) * amp * taper * env]);
  }
  return pts;
}

function smoothLine(pts) {
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  const last = pts[pts.length - 1];
  g.lineTo(last[0], last[1]);
}

function drawWave(dt, k) {
  if (dt > 0) updateWave();
  const { c1, c2, c3 } = state.colors;
  const mid = H * 0.45;
  const amp = H * 0.3 * state.scale * state.sens;
  const pts = wavePoints(waveFast, mid, amp, k);
  const echo = wavePoints(waveSlow, mid, amp * 1.15, k);

  const line = g.createLinearGradient(0, 0, W, 0);
  line.addColorStop(0, c2);
  line.addColorStop(0.5, c1);
  line.addColorStop(1, c3);

  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // Заливка между линией и центром
  const fill = g.createLinearGradient(0, mid - amp, 0, mid + amp);
  fill.addColorStop(0, alpha(c1, 0));
  fill.addColorStop(0.5, alpha(c1, 0.16));
  fill.addColorStop(1, alpha(c1, 0));
  g.fillStyle = fill;
  g.beginPath();
  smoothLine(pts);
  g.lineTo(W, mid);
  g.lineTo(0, mid);
  g.closePath();
  g.fill();

  // Медленное эхо
  g.strokeStyle = alpha(c3, 0.4);
  g.lineWidth = 1.5;
  g.beginPath();
  smoothLine(echo);
  g.stroke();

  // Основная линия с неоновым свечением
  g.shadowColor = c1;
  g.shadowBlur = 18;
  g.strokeStyle = line;
  g.lineWidth = 3;
  g.beginPath();
  smoothLine(pts);
  g.stroke();
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(255,255,255,.6)';
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}

// --- Режим 3: круговой — светящийся «диск колеса», в ступице обложка трека ---
let rot = 0;
let coverArt = null; // Image текущей обложки
function drawCircle(dt, k) {
  const { c1, c2, c3 } = state.colors;
  const cx = W / 2, cy = H * 0.46;
  const m = Math.min(W, H);
  const ek = easeOut(k);
  // Колесо раскручивается из точки в центре
  const R = m * 0.17 * state.scale * (1 + bassSmooth * 0.18) * (0.15 + 0.85 * ek);
  const maxLen = m * 0.24 * state.scale * easeInOut(k);
  rot += dt * (0.6 + energy * 9) + dt * (1 - k) * 8;
  const hasCover = coverArt && coverArt.complete && coverArt.naturalWidth > 0;

  g.save();
  // Лучи спектра
  const n2 = BANDS * 2;
  const rg = g.createRadialGradient(cx, cy, R, cx, cy, R + maxLen);
  rg.addColorStop(0, c2);
  rg.addColorStop(0.45, c1);
  rg.addColorStop(1, c3);
  g.strokeStyle = rg;
  g.lineCap = 'round';
  g.lineWidth = Math.max(2, ((Math.PI * 2 * R) / n2) * 0.55);
  g.shadowColor = c1;
  g.shadowBlur = 14;
  g.beginPath();
  for (let j = 0; j < n2; j++) {
    const i = j < BANDS ? j : n2 - 1 - j;
    const a = (j / n2) * Math.PI * 2 - Math.PI / 2;
    const len = 3 + disp[i] * maxLen;
    const ca = Math.cos(a), sa = Math.sin(a);
    g.moveTo(cx + ca * (R + 6), cy + sa * (R + 6));
    g.lineTo(cx + ca * (R + 6 + len), cy + sa * (R + 6 + len));
  }
  g.stroke();

  // Обод
  g.lineWidth = 3;
  g.strokeStyle = c1;
  g.shadowBlur = 24;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();

  // Спицы, вращаются быстрее при громкой музыке
  const spokeIn = hasCover ? 0.6 : 0.22;
  g.lineWidth = 2;
  g.shadowBlur = 10;
  g.strokeStyle = alpha(c1, 0.7);
  g.beginPath();
  for (let s = 0; s < 6; s++) {
    const a = rot + (s / 6) * Math.PI * 2;
    for (const off of [-0.09, 0.09]) {
      g.moveTo(cx + Math.cos(a) * R * spokeIn, cy + Math.sin(a) * R * spokeIn);
      g.lineTo(cx + Math.cos(a + off) * R * 0.86, cy + Math.sin(a + off) * R * 0.86);
    }
  }
  g.stroke();

  // Волна по окружности внутри
  g.strokeStyle = alpha(c3, 0.8);
  g.lineWidth = 1.5;
  g.shadowColor = c3;
  g.beginPath();
  const segs = 180;
  const waveR = hasCover ? R * 0.72 : R * 0.62;
  for (let s = 0; s <= segs; s++) {
    const a = (s / segs) * Math.PI * 2;
    const v = waveData[Math.floor(((s % segs) / segs) * waveData.length)];
    const r = waveR + v * R * (hasCover ? 0.25 : 0.5) * state.sens;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    s ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();

  if (hasCover) {
    // Обложка крутится в ступице, как диск
    const cr = R * 0.55;
    g.save();
    g.shadowBlur = 0;
    g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2); g.clip();
    g.translate(cx, cy);
    g.rotate(rot * 0.25);
    g.drawImage(coverArt, -cr, -cr, cr * 2, cr * 2);
    g.restore();
    g.strokeStyle = c1;
    g.lineWidth = 2;
    g.shadowColor = c1;
    g.shadowBlur = 16 + bassSmooth * 20;
    g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2); g.stroke();
  } else {
    // Ступица
    const hub = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.3);
    hub.addColorStop(0, '#ffffff');
    hub.addColorStop(0.35, alpha(c1, 0.6 + bassSmooth * 0.4));
    hub.addColorStop(1, alpha(c1, 0));
    g.shadowBlur = 0;
    g.fillStyle = hub;
    g.beginPath(); g.arc(cx, cy, R * 0.3, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

// ---------- Частицы ----------
const particles = [];
function spawnBurst(count) {
  const m = state.mode;
  if (m !== 'bars' && m !== 'circle') return; // в остальных режимах искры только мешают
  for (let n = 0; n < count && particles.length < 260; n++) {
    let x, y, vx, vy;
    if (m === 'circle') {
      const a = Math.random() * TAU;
      const R0 = Math.min(W, H) * 0.17 * state.scale;
      x = W / 2 + Math.cos(a) * R0; y = H * 0.46 + Math.sin(a) * R0;
      const sp = 120 + Math.random() * 260;
      vx = Math.cos(a) * sp; vy = Math.sin(a) * sp;
    } else {
      x = W / 2 + (Math.random() - 0.5) * W * 0.9;
      y = m === 'bars' ? H * 0.74 : H * 0.45;
      vx = (Math.random() - 0.5) * 80;
      vy = -(80 + Math.random() * 240);
    }
    particles.push({ x, y, vx, vy, life: 1, size: 1 + Math.random() * 2.2, hot: Math.random() >= 0.7 });
  }
}

function drawParticles(dt) {
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt * 0.9;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 1 - dt * 0.9; p.vy = p.vy * (1 - dt * 0.9) + 40 * dt;
    g.fillStyle = alpha(p.hot ? state.colors.c3 : state.colors.c1, p.life);
    g.beginPath(); g.arc(p.x, p.y, p.size * (0.5 + p.life), 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

// ---------- Боковые LED-эквалайзеры на «кузове» ----------
function drawGrilles(colors) {
  const { c1, c2, c3 } = colors;
  const cols = 6, rows = 7;
  grilles.forEach(({ c, g: gg }, side) => {
    const w = c.width, h = c.height;
    gg.clearRect(0, 0, w, h);
    const cw = (w - 12) / cols, rh = (h - 10) / rows;
    for (let col = 0; col < cols; col++) {
      // Левый блок — низы, правый — верха
      const from = side === 0 ? col * 4 : 28 + col * 5;
      let v = 0;
      for (let b = from; b < from + 4; b++) v = Math.max(v, disp[b] || 0);
      const lit = Math.round(v * rows * 1.1);
      for (let r = 0; r < rows; r++) {
        const on = r < lit;
        const color = r >= rows - 1 ? c3 : r >= rows - 3 ? c1 : c2;
        gg.fillStyle = on ? color : 'rgba(255,255,255,.06)';
        gg.fillRect(6 + col * cw + 1.5, h - 5 - (r + 1) * rh + 1.5, cw - 3, rh - 3);
      }
    }
  });
}

// ---------- Главный цикл ----------
function drawMode(mode, dt, k) {
  if (k <= 0) return;
  g.globalAlpha = Math.min(1, k * 1.5);
  switch (mode) {
    case 'bars': drawBars(k); break;
    case 'wave': drawWave(dt, k); break;
    case 'circle': drawCircle(dt, k); break;
    case 'dash': drawDash(dt, k); break;
  }
  g.globalAlpha = 1;
}

function renderScene(dt, now) {
  // Для «воздушных» режимов (и во время перехода) оставляем лёгкий шлейф прошлых кадров
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = OPAQUE_MODES.has(state.mode) && !modeFx ? '#03040a' : 'rgba(3,4,10,0.3)';
  g.fillRect(0, 0, W, H);

  let kOld = 0, kNew = 1;
  if (modeFx) {
    const p = clamp01((now - modeFx.start) / MODE_MS);
    kOld = 1 - clamp01(p / 0.6);       // старый сворачивается
    kNew = clamp01((p - 0.3) / 0.7);   // новый вырастает с перекрытием
  }
  const road = Math.max(
    modeFx && ROAD_MODES.has(modeFx.from) ? kOld : 0,
    ROAD_MODES.has(state.mode) ? (modeFx ? kNew : 1) : 0,
  );
  if (road > 0) {
    g.globalAlpha = road;
    drawRoad();
    g.globalAlpha = 1;
  }

  if (modeFx) drawMode(modeFx.from, dt, kOld);
  drawMode(state.mode, dt, kNew);
  drawParticles(dt);
}

// Новая палитра заливает сцену кругом, растущим из центра; по фронту идёт светящееся кольцо
function renderColorWave(dt, now, p) {
  p = clamp01(p); // клик может прийти позже метки кадра — тогда p чуть меньше нуля
  const target = state.colors;
  const cx = W / 2, cy = H * 0.46;
  const r = easeInOut(p) * Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.05;

  state.colors = colorFx.from;
  renderScene(dt, now);
  state.colors = target;

  g.save();
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
  renderScene(0, now);
  g.restore();

  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = alpha(target.c1, 0.14 * (1 - p));
  g.lineWidth = 40;
  g.beginPath(); g.arc(cx, cy, Math.max(0, r - 20), 0, Math.PI * 2); g.stroke();
  g.strokeStyle = alpha(target.c1, 0.9 * (1 - p));
  g.shadowColor = target.c1;
  g.shadowBlur = 30;
  g.lineWidth = 3;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.restore();
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock = now / 1000;

  sample(clock, now);
  trackPitch();
  roadPos = (roadPos + dt * (0.35 + energy * 3.5)) % 1;

  if (modeFx && now - modeFx.start >= MODE_MS) modeFx = null;
  const cp = colorFx ? (now - colorFx.start) / COLOR_MS : 1;
  if (cp >= 1) colorFx = null;

  let deckColors = state.colors;
  if (colorFx) {
    renderColorWave(dt, now, cp);
    // LED-эквалайзеры на кузове перекрашиваются, когда волна до них «доезжает»
    deckColors = lerpPalette(colorFx.from, state.colors, clamp01(cp * 1.4 - 0.4));
  } else {
    renderScene(dt, now);
  }

  // Небольшой поток искр в зависимости от громкости
  if (isPlaying() && Math.random() < energy * 0.8) spawnBurst(1);

  drawGrilles(deckColors);
  deck.style.setProperty('--bass', bassSmooth.toFixed(3));
  bpmBox.style.setProperty('--pulse', beatPulse.toFixed(3));
  updateProgress();
}

// ---------- Утилиты ----------
function fmt(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isAudioFile = (f) => f && (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i.test(f.name));
const NOTE_SVG = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function probeDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(isFinite(d) ? d : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(a.duration);
    a.onerror = () => finish(0);
    setTimeout(() => finish(0), 5000);
    a.src = url;
  });
}

// ---------- Хранилище плейлиста (IndexedDB) ----------
// Сами аудиофайлы и обложки лежат в браузере, поэтому плейлист переживает перезапуск
const DB = {
  conn: null,
  open() {
    this.conn ??= new Promise((resolve, reject) => {
      const r = indexedDB.open('music-visualizer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tracks', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.conn;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', mode);
      const req = fn(tx.objectStore('tracks'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  all() { return this.run('readonly', (s) => s.getAll()); },
  put(rec) { return this.run('readwrite', (s) => s.put(rec)); },
  del(id) { return this.run('readwrite', (s) => s.delete(id)); },
  clear() { return this.run('readwrite', (s) => s.clear()); },
};

const toRecord = ({ id, added, name, title, artist, album, duration, file, cover }) =>
  ({ id, added, name, title, artist, album, duration, file, cover });
const withUrls = (rec) => ({ ...rec, coverUrl: rec.cover ? URL.createObjectURL(rec.cover) : '' });

// ---------- Плейлист ----------
let tracks = [];
let cur = -1;
const player = { shuffle: false, repeat: 'all' }; // repeat: off | all | one
let objectUrl = null;

async function addFiles(list) {
  const files = [...list].filter(isAudioFile);
  if (!files.length) return;
  for (const file of files) {
    const tags = await readTags(file);
    const fallback = tagsFromName(file.name);
    const rec = withUrls({
      id: uid(),
      added: Date.now() + Math.random(),
      name: file.name,
      title: tags.title || fallback.title,
      artist: tags.artist || fallback.artist,
      album: tags.album || '',
      duration: await probeDuration(file),
      file,
      cover: tags.cover || null,
    });
    tracks.push(rec);
    renderPlaylist();
    // Первый добавленный трек сразу заводим, если ничего не играет
    if (!state.loaded && !isLive()) playIndex(tracks.length - 1);
    try { await DB.put(toRecord(rec)); } catch (e) { console.warn('Не удалось сохранить трек в браузере', e); }
  }
  updateDropzone();
}

function playIndex(i, autoplay = true) {
  const t = tracks[i];
  if (!t) return;
  if (isLive()) stopLive();
  cur = i;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(t.file);
  audio.src = objectUrl;
  state.loaded = true;
  resetTempo();
  setNowPlaying(t);
  renderPlaylist();
  updateDropzone();
  save();
  if (autoplay) play();
}

function next(auto = false) {
  if (!tracks.length) return;
  if (auto && player.repeat === 'one') { audio.currentTime = 0; play(); return; }
  let n;
  if (player.shuffle && tracks.length > 1) {
    do n = Math.floor(Math.random() * tracks.length); while (n === cur);
  } else {
    n = cur + 1;
  }
  if (n >= tracks.length) {
    if (auto && player.repeat === 'off') { audio.currentTime = 0; return; }
    n = 0;
  }
  playIndex(n);
}

function prev() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playIndex(cur > 0 ? cur - 1 : tracks.length - 1);
}

async function removeTrack(i) {
  const [t] = tracks.splice(i, 1);
  if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
  DB.del(t.id).catch(() => {});
  if (i === cur) {
    const wasPlaying = !audio.paused;
    cur = -1;
    stopFile();
    if (tracks.length) playIndex(Math.min(i, tracks.length - 1), wasPlaying);
  } else if (i < cur) {
    cur--;
  }
  renderPlaylist();
  updateDropzone();
}

async function clearPlaylist() {
  if (!tracks.length || !confirm('Очистить плейлист? Треки удалятся из памяти браузера.')) return;
  tracks.forEach((t) => t.coverUrl && URL.revokeObjectURL(t.coverUrl));
  tracks = [];
  cur = -1;
  stopFile();
  DB.clear().catch(() => {});
  renderPlaylist();
  updateDropzone();
}

function stopFile() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.loaded = false;
  resetTempo();
  if (!isLive()) clearNowPlaying();
}

function renderPlaylist() {
  $('#plList').innerHTML = tracks.map((t, i) => `
    <li class="pl-item${i === cur ? ' current' : ''}" data-i="${i}">
      <div class="pl-thumb">${t.coverUrl ? `<img src="${t.coverUrl}" alt="">` : NOTE_SVG}<div class="pl-eq"><i></i><i></i><i></i></div></div>
      <div class="pl-meta"><span class="pl-title">${esc(t.title)}</span><span class="pl-artist">${esc(t.artist || 'Неизвестный исполнитель')}</span></div>
      <span class="pl-dur">${t.duration ? fmt(t.duration) : ''}</span>
      <button class="pl-del" data-del="${i}" title="Убрать из плейлиста" aria-label="Убрать из плейлиста">${X_SVG}</button>
    </li>`).join('');
  const n = tracks.length;
  $('#plCount').textContent = n ? `${n} ${plural(n, 'трек', 'трека', 'треков')}` : 'Пусто';
  $('#plEmpty').hidden = n > 0;
  const badge = $('#plBadge');
  badge.hidden = !n;
  badge.textContent = n;
}

$('#plList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { removeTrack(+del.dataset.del); return; }
  const li = e.target.closest('.pl-item');
  if (li) {
    const i = +li.dataset.i;
    if (i === cur && state.loaded) togglePlay(); else playIndex(i);
  }
});
$('#plAdd').addEventListener('click', () => fileInput.click());
$('#plClear').addEventListener('click', clearPlaylist);

// ---------- «Сейчас играет» ----------
function setCover(url) {
  const img = $('#coverImg');
  img.hidden = !url;
  if (url) img.src = url; else img.removeAttribute('src');
  coverArt = null;
  if (url) { const im = new Image(); im.src = url; coverArt = im; }
}

function setNowPlaying(t) {
  $('#trackLabel').textContent = 'Сейчас играет';
  $('#title').textContent = t.title;
  $('#artist').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
  $('#dur').textContent = fmt(t.duration);
  setCover(t.coverUrl);
  document.title = `▶ ${t.title} — Music Visualizer`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || '',
      album: t.album || '',
      artwork: t.coverUrl ? [{ src: t.coverUrl }] : [],
    });
  }
}

function clearNowPlaying() {
  $('#trackLabel').textContent = 'Сейчас играет';
  $('#title').textContent = 'Трек не загружен';
  $('#artist').textContent = '';
  $('#cur').textContent = '0:00';
  $('#dur').textContent = '0:00';
  setCover('');
  document.title = 'Music Visualizer';
}

function setNowPlayingLive() {
  const label = liveStream?.getAudioTracks()[0]?.label || '';
  $('#trackLabel').textContent = '● LIVE';
  $('#title').textContent = state.source === 'mic' ? 'Микрофон' : 'Звук вкладки';
  $('#artist').textContent = label;
  setCover('');
  document.title = `● LIVE — Music Visualizer`;
}

// ---------- Плеер ----------
let lastTimeText = '';
function updateProgress() {
  if (isLive()) {
    if (lastTimeText !== 'LIVE') { $('#cur').textContent = 'LIVE'; $('#durWrap').hidden = true; lastTimeText = 'LIVE'; }
    return;
  }
  const d = audio.duration || 0;
  if (!state.seeking && d) {
    const v = (audio.currentTime / d) * 1000;
    progress.value = v;
    progress.style.setProperty('--p', v / 10 + '%');
  } else if (!state.loaded) {
    progress.value = 0;
    progress.style.setProperty('--p', '0%');
  }
  const txt = fmt(audio.currentTime);
  if (txt !== lastTimeText) { $('#cur').textContent = txt; $('#durWrap').hidden = false; lastTimeText = txt; }
}

async function play() {
  if (isLive()) return;
  if (!state.loaded) {
    if (tracks.length) { playIndex(cur >= 0 ? cur : 0); return; }
    fileInput.click();
    return;
  }
  if (actx.state === 'suspended') await actx.resume();
  try { await audio.play(); } catch (e) { console.warn(e); }
}

function togglePlay() {
  if (isLive()) { stopLive(); return; }
  if (!state.loaded || audio.paused) play();
  else audio.pause();
}

audio.addEventListener('play', () => app.classList.add('playing'));
audio.addEventListener('pause', () => app.classList.remove('playing'));
audio.addEventListener('ended', () => { app.classList.remove('playing'); next(true); });
audio.addEventListener('loadedmetadata', () => {
  $('#dur').textContent = fmt(audio.duration);
  const t = tracks[cur];
  if (t && !t.duration && isFinite(audio.duration)) {
    t.duration = audio.duration;
    renderPlaylist();
    DB.put(toRecord(t)).catch(() => {});
  }
});

progress.addEventListener('input', () => {
  state.seeking = true;
  progress.style.setProperty('--p', progress.value / 10 + '%');
  if (audio.duration) $('#cur').textContent = fmt((progress.value / 1000) * audio.duration);
});
progress.addEventListener('change', () => {
  if (audio.duration) audio.currentTime = (progress.value / 1000) * audio.duration;
  state.seeking = false;
});

$('#playBtn').addEventListener('click', togglePlay);
$('#nextBtn').addEventListener('click', () => next());
$('#prevBtn').addEventListener('click', prev);
$('#pickBtn').addEventListener('click', () => fileInput.click());
$('#dropSourceBtn').addEventListener('click', () => openDrawer('source'));
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

function renderPlayerModes() {
  const sh = $('#shuffleBtn'), rp = $('#repeatBtn');
  sh.classList.toggle('on', player.shuffle);
  sh.title = player.shuffle ? 'Перемешивание включено' : 'Перемешать';
  rp.classList.toggle('on', player.repeat !== 'off');
  rp.classList.toggle('one', player.repeat === 'one');
  rp.classList.toggle('off', player.repeat === 'off');
  rp.title = { off: 'Повтор выключен', all: 'Повтор: весь плейлист', one: 'Повтор: один трек' }[player.repeat];
}
$('#shuffleBtn').addEventListener('click', () => { player.shuffle = !player.shuffle; renderPlayerModes(); save(); });
$('#repeatBtn').addEventListener('click', () => {
  player.repeat = { all: 'one', one: 'off', off: 'all' }[player.repeat];
  renderPlayerModes();
  save();
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => play(),
    pause: () => audio.pause(),
    nexttrack: () => next(),
    previoustrack: () => prev(),
    seekto: (d) => { audio.currentTime = d.seekTime; },
  };
  for (const [k, fn] of Object.entries(handlers)) { try { ms.setActionHandler(k, fn); } catch {} }
}

// ---------- Источники звука ----------
async function useSource(kind) {
  const note = $('#srcNote');
  note.textContent = '';
  note.classList.remove('error');
  if (kind === 'file') { stopLive(); return; }
  const fail = (text) => { note.textContent = text; note.classList.add('error'); };
  if (!window.isSecureContext || !navigator.mediaDevices) {
    fail('Захват звука доступен только по https или на localhost.');
    return;
  }
  if (kind === 'tab' && !navigator.mediaDevices.getDisplayMedia) {
    fail('Этот браузер не умеет захватывать звук вкладки (на телефонах такого нет). Попробуй микрофон или Chrome/Edge на компьютере.');
    return;
  }
  // Без обработки речи: шумодав и автогромкость портят музыку
  const clean = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
    let stream;
    if (kind === 'mic') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: clean });
    } else {
      note.textContent = 'В окне выбора открой «Вкладка Chrome», выбери вкладку с музыкой и проверь, что включено «Поделиться звуком».';
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },  // по умолчанию предлагаем вкладку — у неё звук есть всегда
        audio: { ...clean, suppressLocalAudioPlayback: false },
        systemAudio: 'include',                // для «Весь экран» — звук системы
        selfBrowserSurface: 'exclude',         // эту вкладку выбирать бессмысленно
        surfaceSwitching: 'include',
      });
      const video = stream.getVideoTracks()[0];
      const surface = video?.getSettings().displaySurface;
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        throw Object.assign(new Error('noaudio'), { surface });
      }
      // Картинка не нужна — экономим ресурсы, звук продолжает идти
      if (video) video.enabled = false;
    }
    startLive(stream, kind);
    note.textContent = kind === 'mic'
      ? 'Слушаю микрофон. Нажми ■ на деке, чтобы вернуться к плейлисту.'
      : 'Слушаю звук. Остановить можно кнопкой ■ на деке или «Закрыть доступ» в браузере.';
  } catch (e) {
    if (e.message === 'noaudio') {
      fail(e.surface === 'window'
        ? 'Ты выбрал отдельное окно — Windows не отдаёт его звук. Выбери вкладку браузера или «Весь экран» и включи «Поделиться системным звуком».'
        : e.surface === 'monitor'
          ? 'Звук не передан: при выборе «Весь экран» включи внизу «Поделиться системным звуком» (работает в Windows).'
          : 'Звук не передан: в окне выбора включи «Поделиться звуком вкладки». В Brave и других браузерах его может не быть — тогда попробуй Chrome или Edge.');
    } else if (e.name === 'NotAllowedError') {
      fail(kind === 'mic'
        ? 'Доступ к микрофону запрещён. Нажми на значок слева от адреса сайта, разреши микрофон и попробуй снова.'
        : 'Захват отменён или запрещён браузером. Попробуй ещё раз и выбери вкладку с музыкой.');
    } else if (e.name === 'NotFoundError') {
      fail('Микрофон не найден. Подключи его и попробуй снова.');
    } else if (e.name === 'NotReadableError') {
      fail('Микрофон занят другим приложением или заблокирован системой (Параметры Windows → Конфиденциальность → Микрофон).');
    } else {
      fail('Не получилось: ' + (e.message || e.name));
    }
  }
}

function startLive(stream, kind) {
  stopLive(true);
  audio.pause();
  liveStream = stream;
  liveNode = actx.createMediaStreamSource(stream);
  liveNode.connect(analyser);
  outGain.gain.value = 0;
  state.source = kind;
  actx.resume();
  resetTempo();
  // «Закрыть доступ» в браузере завершает дорожки — возвращаемся к плейлисту
  stream.getTracks().forEach((t) => t.addEventListener('ended', () => { if (liveStream === stream) stopLive(); }));
  updateSourceUI();
  setNowPlayingLive();
}

function stopLive(silent = false) {
  if (liveNode) liveNode.disconnect();
  if (liveStream) liveStream.getTracks().forEach((t) => t.stop());
  liveNode = null;
  liveStream = null;
  if (!isLive()) return;
  state.source = 'file';
  outGain.gain.value = state.volume;
  resetTempo();
  if (silent) return;
  if (tracks[cur] && state.loaded) setNowPlaying(tracks[cur]); else clearNowPlaying();
  $('#srcNote').textContent = '';
  lastTimeText = '';
  updateSourceUI();
}

function updateSourceUI() {
  app.classList.toggle('live', isLive());
  $$('.src-card').forEach((c) => c.classList.toggle('active', c.dataset.source === state.source));
  updateDropzone();
}
$$('.src-card').forEach((c) => c.addEventListener('click', () => useSource(c.dataset.source)));

function updateDropzone() {
  dropzone.classList.toggle('hidden', isLive() || tracks.length > 0);
}

// ---------- Боковая панель ----------
function openDrawer(tab) {
  if (drawer.classList.contains('open') && drawer.dataset.tab === tab) { closeDrawer(); return; }
  drawer.dataset.tab = tab;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $$('.drawer-tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.drawer .tab').forEach((s) => s.classList.toggle('active', s.dataset.tab === tab));
  $$('.deck-btn').forEach((b) => b.classList.toggle('active', b.dataset.open === tab));
  if (tab === 'eq') drawEqCurve();
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $$('.deck-btn').forEach((b) => b.classList.remove('active'));
}
$$('.drawer-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.tab)));
$$('.deck-btn').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.open)));
$('#drawerClose').addEventListener('click', closeDrawer);
// Тап мимо панели закрывает её — на телефоне это основной способ
document.addEventListener('pointerdown', (e) => {
  if (!drawer.classList.contains('open')) return;
  if (drawer.contains(e.target) || e.target.closest('[data-open], #dropSourceBtn')) return;
  closeDrawer();
});

// ---------- Эквалайзер-магнитола ----------
const faders = [];
function buildEq() {
  const wrap = $('#eqFaders');
  EQ_BANDS.forEach((b, i) => {
    const col = document.createElement('div');
    col.className = 'eq-col';
    col.innerHTML = `<b class="eq-val"></b>
      <div class="eq-fader" role="slider" tabindex="0" aria-label="${b.label} Гц" aria-valuemin="-12" aria-valuemax="12">${'<i></i>'.repeat(25)}</div>
      <span>${b.label}</span>`;
    const f = col.querySelector('.eq-fader');
    const fromY = (y) => {
      const r = f.getBoundingClientRect();
      setEq(i, Math.round(12 - clamp01((y - r.top) / r.height) * 24));
    };
    f.addEventListener('pointerdown', (e) => { f.setPointerCapture(e.pointerId); fromY(e.clientY); });
    f.addEventListener('pointermove', (e) => { if (f.hasPointerCapture(e.pointerId)) fromY(e.clientY); });
    f.addEventListener('dblclick', () => setEq(i, 0));
    f.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); e.stopPropagation(); setEq(i, state.eq[i] + d); }
      else if (e.key === 'Home' || e.key === '0') { e.stopPropagation(); setEq(i, 0); }
    });
    wrap.append(col);
    faders.push(col);
  });

  $('#eqPresets').innerHTML = Object.entries(EQ_PRESETS)
    .map(([key, p]) => `<button class="chip ghost" data-eq="${key}">${p.name}</button>`).join('');
  $$('#eqPresets .chip').forEach((c) => c.addEventListener('click', () => applyEqPreset(c.dataset.eq)));
}

function setEq(i, v) {
  v = Math.max(-12, Math.min(12, v));
  if (v === state.eq[i]) return;
  state.eq[i] = v;
  state.eqPreset = Object.keys(EQ_PRESETS).find((k) => EQ_PRESETS[k].gains.every((x, j) => x === state.eq[j])) || 'custom';
  applyEq();
}
function applyEqPreset(key) {
  state.eq = [...EQ_PRESETS[key].gains];
  state.eqPreset = key;
  applyEq();
}

let eqRedraw = 0;
function applyEq() {
  eqNodes.forEach((f, i) => f.gain.setTargetAtTime(state.eq[i], actx.currentTime, 0.02));
  renderEq();
  drawEqCurve();
  // Фильтры сглаживают изменение усиления — перерисуем кривую, когда они «доедут»
  clearTimeout(eqRedraw);
  eqRedraw = setTimeout(drawEqCurve, 150);
  save();
}

function renderEq() {
  faders.forEach((col, i) => {
    const v = state.eq[i];
    col.querySelector('.eq-val').textContent = (v > 0 ? '+' : '') + v;
    col.querySelector('.eq-fader').setAttribute('aria-valuenow', v);
    col.querySelectorAll('.eq-fader i').forEach((seg, j) => {
      const lvl = 12 - j;
      const on = (v > 0 && lvl > 0 && lvl <= v) || (v < 0 && lvl < 0 && lvl >= v);
      seg.className = [lvl === 0 && 'zero', on && 'on', on && lvl < 0 && 'neg', on && lvl >= 9 && 'hot'].filter(Boolean).join(' ');
    });
  });
  $('#eqName').textContent = state.eqPreset === 'custom' ? 'СВОЙ' : EQ_PRESETS[state.eqPreset].name.toUpperCase();
  $$('#eqPresets .chip').forEach((c) => c.classList.toggle('active', c.dataset.eq === state.eqPreset));
}

// Итоговая АЧХ эквалайзера на «экране магнитолы»
const eqCanvas = $('#eqCurve');
const ec = eqCanvas.getContext('2d');
const EQ_POINTS = 150;
const eqFreqs = Float32Array.from({ length: EQ_POINTS }, (_, i) => 20 * Math.pow(1000, i / (EQ_POINTS - 1)));
const eqMag = new Float32Array(EQ_POINTS);
const eqPhase = new Float32Array(EQ_POINTS);

function drawEqCurve() {
  if (!actx) return;
  const { c1, c2 } = state.colors;
  const w = eqCanvas.width, h = eqCanvas.height;
  const db = new Float32Array(EQ_POINTS);
  for (const f of eqNodes) {
    f.getFrequencyResponse(eqFreqs, eqMag, eqPhase);
    for (let i = 0; i < EQ_POINTS; i++) db[i] += 20 * Math.log10(eqMag[i]);
  }
  const yOf = (v) => h / 2 - (v / 15) * (h / 2 - 8);

  ec.clearRect(0, 0, w, h);
  ec.strokeStyle = 'rgba(255,255,255,.08)';
  ec.lineWidth = 1;
  ec.beginPath();
  for (const v of [-12, -6, 6, 12]) { ec.moveTo(0, yOf(v)); ec.lineTo(w, yOf(v)); }
  for (const f of [100, 1000, 10000]) { const x = (Math.log10(f / 20) / 3) * w; ec.moveTo(x, 0); ec.lineTo(x, h); }
  ec.stroke();
  ec.strokeStyle = 'rgba(255,255,255,.25)';
  ec.beginPath(); ec.moveTo(0, yOf(0)); ec.lineTo(w, yOf(0)); ec.stroke();

  ec.beginPath();
  for (let i = 0; i < EQ_POINTS; i++) {
    const x = (i / (EQ_POINTS - 1)) * w;
    i ? ec.lineTo(x, yOf(db[i])) : ec.moveTo(x, yOf(db[i]));
  }
  ec.save();
  ec.lineTo(w, yOf(0)); ec.lineTo(0, yOf(0)); ec.closePath();
  const fill = ec.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, alpha(c1, 0.35));
  fill.addColorStop(0.5, alpha(c1, 0.05));
  fill.addColorStop(1, alpha(c2, 0.35));
  ec.fillStyle = fill;
  ec.fill();
  ec.restore();
  ec.strokeStyle = c1;
  ec.lineWidth = 3;
  ec.shadowColor = c1;
  ec.shadowBlur = 12;
  ec.stroke();
  ec.shadowBlur = 0;
}

// ---------- Режимы и пресеты ----------
function setMode(mode, animate = true) {
  if (animate && mode !== state.mode) modeFx = { from: state.mode, start: performance.now() };
  state.mode = mode;
  $$('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  // На узком экране подкручиваем ленту режимов к активной кнопке
  const bar = $('#modes'), btn = $('#modes .active');
  if (btn && bar.scrollWidth > bar.clientWidth) {
    const b = btn.getBoundingClientRect(), r = bar.getBoundingClientRect();
    bar.scrollLeft += b.left + b.width / 2 - (r.left + r.width / 2);
  }
  save();
}
$$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function setPreset(name, animate = true) {
  if (animate && name !== document.body.dataset.preset) {
    colorFx = { from: state.colors, start: performance.now() };
  }
  state.colors = { ...PALETTES[name] };
  document.body.dataset.preset = name;
  $$('#presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
  drawEqCurve();
  save();
}
$$('#presets button').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));

function bindKnob(id, key, format, onChange) {
  const input = $('#' + id);
  const out = $('#' + id + 'Val');
  const update = () => {
    state[key] = parseFloat(input.value);
    out.textContent = format(state[key]);
    const p = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', p + '%');
    onChange?.();
  };
  input.addEventListener('input', () => { update(); save(); });
  return { input, update };
}
const knobs = {
  volume: bindKnob('volume', 'volume', (v) => Math.round(v * 100), () => { if (outGain && !isLive()) outGain.gain.value = state.volume; }),
  sens: bindKnob('sens', 'sens', (v) => v.toFixed(1)),
  scale: bindKnob('scale', 'scale', (v) => v.toFixed(1)),
};

// ---------- Полноэкранный режим ----------
$('#fsBtn').addEventListener('click', toggleFullscreen);
$('#fsBtn').hidden = !document.fullscreenEnabled; // на iPhone полноэкранный режим для страниц недоступен
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else app.requestFullscreen?.().catch(() => {});
}
let idleTimer = null;
function wake() {
  app.classList.remove('idle');
  clearTimeout(idleTimer);
  if (document.fullscreenElement && !drawer.classList.contains('open')) idleTimer = setTimeout(() => app.classList.add('idle'), 2500);
}
document.addEventListener('mousemove', wake);
document.addEventListener('fullscreenchange', () => { wake(); setTimeout(resize, 50); });

// ---------- Клавиатура ----------
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches('input[type="range"]') && e.key.startsWith('Arrow')) return;
  const digit = /^Digit([1-4])$/.exec(e.code);
  if (digit) { setMode(MODES[+digit[1] - 1]); wake(); return; }
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'KeyN': next(); break;
    case 'KeyB': prev(); break;
    case 'KeyL': openDrawer('playlist'); break;
    case 'KeyE': openDrawer('eq'); break;
    case 'Escape': closeDrawer(); break;
    case 'KeyP': setPreset(PRESETS[(PRESETS.indexOf(document.body.dataset.preset) + 1) % PRESETS.length]); break;
    case 'ArrowRight': if (audio.duration && !isLive()) { e.preventDefault(); audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); } break;
    case 'ArrowLeft': if (audio.duration && !isLive()) { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 5); } break;
    default: return;
  }
  wake();
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') e.preventDefault(); });

// ---------- Drag & drop на всё окно ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropzone.classList.remove('hidden');
  dropzone.classList.add('drag');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropzone.classList.remove('drag'); updateDropzone(); }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('drag');
  updateDropzone();
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// ---------- Настройки между сессиями ----------
const SETTINGS_KEY = 'mv-settings';
function save() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode: state.mode, sens: state.sens, scale: state.scale, volume: state.volume,
      preset: document.body.dataset.preset, eq: state.eq, eqPreset: state.eqPreset,
      shuffle: player.shuffle, repeat: player.repeat, lastId: tracks[cur]?.id,
    }));
  } catch {}
}
function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}

async function loadLibrary(lastId) {
  try {
    const recs = await DB.all();
    recs.sort((a, b) => a.added - b.added);
    tracks = recs.map(withUrls);
  } catch (e) {
    console.warn('Плейлист из браузера не загрузился', e);
  }
  renderPlaylist();
  if (tracks.length && !state.loaded) {
    const i = tracks.findIndex((t) => t.id === lastId);
    playIndex(i >= 0 ? i : 0, false);
  }
  updateDropzone();
}

function boot() {
  const s = readSettings();
  if (Array.isArray(s.eq) && s.eq.length === EQ_BANDS.length) state.eq = s.eq.map(Number);
  if (s.eqPreset) state.eqPreset = s.eqPreset;
  if (typeof s.shuffle === 'boolean') player.shuffle = s.shuffle;
  if (['off', 'all', 'one'].includes(s.repeat)) player.repeat = s.repeat;
  if (s.volume != null) knobs.volume.input.value = s.volume;
  if (s.sens) knobs.sens.input.value = s.sens;
  if (s.scale) knobs.scale.input.value = s.scale;
  knobs.volume.update();
  knobs.sens.update();
  knobs.scale.update();

  initAudio();
  setPreset(PRESETS.includes(s.preset) ? s.preset : 'neon', false);
  if (MODES.includes(s.mode)) setMode(s.mode, false);

  buildEq();
  renderEq();
  drawEqCurve();
  renderPlayerModes();
  renderPlaylist();
  updateSourceUI();
  loadLibrary(s.lastId);

  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(stage);
  resize();
  requestAnimationFrame(frame);
  // Включаем CSS-переходы только после первой отрисовки, чтобы сохранённый пресет не «въезжал» при загрузке
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('preload')));
}

boot();
