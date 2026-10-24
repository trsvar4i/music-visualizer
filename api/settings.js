// Настройки пользователя (режим, пресет, эквалайзер, громкость…) — одна JSON-запись на пользователя
import { body, db, HttpError, json, owner, route } from './_lib.js';

export const { GET, PUT } = route({
  async GET(request) {
    const user = owner(request);
    const client = await db();
    const { rows } = await client.execute({ sql: 'SELECT data FROM settings WHERE owner = ?', args: [user] });
    return json({ settings: rows.length ? JSON.parse(rows[0].data) : null });
  },

  async PUT(request) {
    const user = owner(request);
    const data = await body(request);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Ожидается объект настроек');
    const str = JSON.stringify(data);
    if (str.length > 4000) throw new HttpError(413, 'Слишком большие настройки');
    const client = await db();
    await client.execute({
      sql: `INSERT INTO settings (owner, data, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (owner) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      args: [user, str, Date.now()],
    });
    return json({ ok: true });
  },
});
