'use strict';

// Чтение тегов и обложки прямо из аудиофайла, без библиотек:
// ID3v2 (MP3), FLAC (Vorbis comments + PICTURE), MP4/M4A (iTunes-атомы).
// Возвращает { title, artist, album, cover: Blob|null }; неизвестные форматы — пустой объект.

const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
const utf8 = (b) => new TextDecoder('utf-8').decode(b);
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const syncsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];

async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (ascii(head, 0, 3) === 'ID3') return await readId3(file);
    if (ascii(head, 0, 4) === 'fLaC') return await readFlac(file);
    if (ascii(head, 4, 4) === 'ftyp') return await readMp4(file);
  } catch (e) {
    console.warn('Не удалось прочитать теги', file.name, e);
  }
  return {};
}

// Строка из имени файла: «Исполнитель - Название.mp3»
function tagsFromName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

// ---------- ID3v2 ----------
function decodeId3String(bytes, enc) {
  let label = 'utf-8';
  if (enc === 0) {
    // Русские MP3 часто записаны в cp1251, хотя тег заявляет latin1
    label = bytes.some((b) => b >= 0xc0) ? 'windows-1251' : 'iso-8859-1';
  } else if (enc === 1) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) { label = 'utf-16be'; bytes = bytes.subarray(2); }
    else { label = 'utf-16le'; if (bytes[0] === 0xff && bytes[1] === 0xfe) bytes = bytes.subarray(2); }
  } else if (enc === 2) {
    label = 'utf-16be';
  }
  return new TextDecoder(label).decode(bytes);
}

function id3Text(data) {
  return decodeId3String(data.subarray(1), data[0]).split('\0').map((s) => s.trim()).filter(Boolean).join(', ');
}

function id3Picture(data, v22) {
  const enc = data[0];
  let p, mime;
  if (v22) {
    mime = ascii(data, 1, 3).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const end = data.indexOf(0, 1);
    mime = ascii(data, 1, end - 1).toLowerCase() || 'image/jpeg';
    p = end + 1;
  }
  if (!mime.includes('/')) mime = 'image/' + mime.replace('jpg', 'jpeg');
  const type = data[p++];
  // Описание картинки заканчивается нулём (двумя — для UTF-16)
  if (enc === 1 || enc === 2) {
    while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < data.length && data[p] !== 0) p++;
    p++;
  }
  return { type, blob: new Blob([data.slice(p)], { type: mime }) };
}

async function readId3(file) {
  const hdr = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const ver = hdr[3];
  const flags = hdr[5];
  const size = syncsafe(hdr, 6);
  const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());

  let pos = 0;
  if (flags & 0x40) pos = ver === 4 ? syncsafe(buf, 0) : u32(buf, 0) + 4; // расширенный заголовок

  const out = {};
  let coverType = -1;
  const v22 = ver === 2;
  const idLen = v22 ? 3 : 4;
  const hLen = v22 ? 6 : 10;

  while (pos + hLen <= buf.length) {
    const id = ascii(buf, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // дошли до паддинга
    const len = v22
      ? (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]
      : ver === 4 ? syncsafe(buf, pos + 4) : u32(buf, pos + 4);
    const data = buf.subarray(pos + hLen, pos + hLen + len);
    pos += hLen + len;
    if (!len) continue;

    switch (id) {
      case 'TIT2': case 'TT2': out.title ||= id3Text(data); break;
      case 'TPE1': case 'TP1': out.artist ||= id3Text(data); break;
      case 'TALB': case 'TAL': out.album ||= id3Text(data); break;
      case 'APIC': case 'PIC': {
        const pic = id3Picture(data, v22);
        // Предпочитаем лицевую обложку (тип 3)
        if (coverType !== 3 && pic.blob.size > 100) { out.cover = pic.blob; coverType = pic.type; }
        break;
      }
    }
  }
  return out;
}

// ---------- FLAC ----------
async function readFlac(file) {
  const out = {};
  let coverType = -1;
  let pos = 4;
  for (let n = 0; n < 128; n++) {
    const h = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer());
    if (h.length < 4) break;
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];

    if (type === 4 || type === 6) {
      const b = new Uint8Array(await file.slice(pos + 4, pos + 4 + len).arrayBuffer());
      const dv = new DataView(b.buffer);
      if (type === 4) {
        let p = 4 + dv.getUint32(0, true);
        const count = dv.getUint32(p, true); p += 4;
        for (let i = 0; i < count && p < b.length; i++) {
          const l = dv.getUint32(p, true); p += 4;
          const s = utf8(b.subarray(p, p + l)); p += l;
          const eq = s.indexOf('=');
          const key = s.slice(0, eq).toUpperCase();
          const val = s.slice(eq + 1).trim();
          if (key === 'TITLE') out.title ||= val;
          else if (key === 'ARTIST') out.artist ||= val;
          else if (key === 'ALBUM') out.album ||= val;
        }
      } else {
        const picType = dv.getUint32(0);
        let p = 4;
        const ml = dv.getUint32(p); p += 4;
        const mime = ascii(b, p, ml); p += ml;
        const dl = dv.getUint32(p); p += 4 + dl;
        p += 16; // ширина, высота, глубина, палитра
        const size = dv.getUint32(p); p += 4;
        if (coverType !== 3) { out.cover = new Blob([b.slice(p, p + size)], { type: mime || 'image/jpeg' }); coverType = picType; }
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

// ---------- MP4 / M4A ----------
async function readMp4(file) {
  async function atoms(start, end) {
    const list = [];
    let pos = start;
    while (pos + 8 <= end) {
      const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
      let size = h.getUint32(0);
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      let hdr = 8;
      if (size === 1) { size = Number(h.getBigUint64(8)); hdr = 16; }
      else if (size === 0) size = end - pos;
      if (size < hdr) break;
      list.push({ type, start: pos, size, hdr });
      pos += size;
    }
    return list;
  }
  const inside = async (a, skip = 0) => atoms(a.start + a.hdr + skip, a.start + a.size);
  const find = (list, t) => list.find((a) => a.type === t);

  const moov = find(await atoms(0, file.size), 'moov'); if (!moov) return {};
  const udta = find(await inside(moov), 'udta'); if (!udta) return {};
  const meta = find(await inside(udta), 'meta'); if (!meta) return {};
  const ilst = find(await inside(meta, 4), 'ilst'); if (!ilst) return {};

  const buf = new Uint8Array(await file.slice(ilst.start + ilst.hdr, ilst.start + ilst.size).arrayBuffer());
  const out = {};
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = u32(buf, p);
    if (size < 8) break;
    const type = ascii(buf, p + 4, 4);
    if (ascii(buf, p + 12, 4) === 'data') {
      const dsize = u32(buf, p + 8);
      const kind = u32(buf, p + 16) & 0xffffff;
      const val = buf.subarray(p + 24, p + 8 + dsize);
      if (type === '©nam') out.title = utf8(val);
      else if (type === '©ART') out.artist = utf8(val);
      else if (type === '©alb') out.album = utf8(val);
      else if (type === 'covr') out.cover = new Blob([val.slice()], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
    }
    p += size;
  }
  return out;
}
