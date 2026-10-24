// Плейлист пользователя: метаданные треков в Turso, сами файлы — по ссылкам Vercel Blob
import { del } from '@vercel/blob';
import { body, db, HttpError, isBlobUrl, json, owner, route, text } from './_lib.js';

const ID = /^[\w-]{8,64}$/;

const toTrack = (r) => ({
  id: r.id,
  name: r.name,
  title: r.title,
  artist: r.artist,
  album: r.album,
  duration: r.duration,
  audioUrl: r.audio_url,
  coverUrl: r.cover_url,
});

async function removeBlobs(urls) {
  const list = urls.filter(isBlobUrl);
  if (!list.length) return;
  try {
    await del(list);
  } catch (e) {
    console.error('Не удалось удалить файлы из Blob', e); // запись в базе уже удалена — это не критично
  }
}

export const { GET, POST, PATCH, DELETE } = route({
  async GET(request) {
    const user = owner(request);
    const client = await db();
    const { rows } = await client.execute({
      sql: 'SELECT * FROM tracks WHERE owner = ? ORDER BY position, created_at',
      args: [user],
    });
    return json({ tracks: rows.map(toTrack) });
  },

  async POST(request) {
    const user = owner(request);
    const t = await body(request);
    if (!ID.test(t.id || '')) throw new HttpError(400, 'Неверный id трека');
    if (!isBlobUrl(t.audioUrl)) throw new HttpError(400, 'audioUrl должен указывать на Vercel Blob');
    if (t.coverUrl && !isBlobUrl(t.coverUrl)) throw new HttpError(400, 'coverUrl должен указывать на Vercel Blob');
    const title = text(t.title) || text(t.name) || 'Без названия';
    const duration = Number.isFinite(t.duration) && t.duration > 0 ? t.duration : null;

    const client = await db();
    await client.execute({
      sql: `INSERT INTO tracks (id, owner, position, name, title, artist, album, duration, audio_url, cover_url, created_at)
            VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM tracks WHERE owner = ?), ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              title = excluded.title, artist = excluded.artist, album = excluded.album, duration = excluded.duration
            WHERE tracks.owner = excluded.owner`,
      args: [t.id, user, user, text(t.name), title, text(t.artist), text(t.album), duration, t.audioUrl, t.coverUrl || null, Date.now()],
    });
    return json({ ok: true }, 201);
  },

  // Дописываем длительность, если при загрузке её не удалось определить
  async PATCH(request) {
    const user = owner(request);
    const t = await body(request);
    if (!ID.test(t.id || '') || !(Number.isFinite(t.duration) && t.duration > 0)) throw new HttpError(400, 'Нужны id и duration');
    const client = await db();
    await client.execute({ sql: 'UPDATE tracks SET duration = ? WHERE id = ? AND owner = ?', args: [t.duration, t.id, user] });
    return json({ ok: true });
  },

  // ?id=… удаляет один трек, ?all=1 — весь плейлист пользователя
  async DELETE(request) {
    const user = owner(request);
    const params = new URL(request.url).searchParams;
    const id = params.get('id');
    const all = params.get('all') === '1';
    if (!all && !ID.test(id || '')) throw new HttpError(400, 'Нужен id или all=1');

    const client = await db();
    const where = all ? 'owner = ?' : 'owner = ? AND id = ?';
    const args = all ? [user] : [user, id];
    const { rows } = await client.execute({ sql: `SELECT audio_url, cover_url FROM tracks WHERE ${where}`, args });
    await client.execute({ sql: `DELETE FROM tracks WHERE ${where}`, args });
    await removeBlobs(rows.flatMap((r) => [r.audio_url, r.cover_url]).filter(Boolean));
    return json({ ok: true, removed: rows.length });
  },
});
