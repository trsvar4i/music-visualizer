// Общая галерея пресетов эквалайзера: любой пользователь может поделиться своей настройкой
import { body, db, HttpError, json, owner, route, text } from './_lib.js';

export const { GET, POST } = route({
  async GET() {
    const client = await db();
    const { rows } = await client.execute('SELECT id, name, gains, created_at FROM eq_presets ORDER BY id DESC LIMIT 40');
    return json({ presets: rows.map((r) => ({ id: r.id, name: r.name, gains: JSON.parse(r.gains), createdAt: r.created_at })) });
  },

  async POST(request) {
    const user = owner(request);
    const p = await body(request);
    const name = text(p.name, 40);
    const gains = p.gains;
    if (!name) throw new HttpError(400, 'Дай пресету название');
    if (!Array.isArray(gains) || gains.length !== 5 || !gains.every((v) => Number.isInteger(v) && v >= -12 && v <= 12)) {
      throw new HttpError(400, 'Нужно 5 значений усиления от −12 до 12 дБ');
    }
    const client = await db();
    const { rows } = await client.execute({
      sql: 'SELECT COUNT(*) AS n FROM eq_presets WHERE author = ? AND created_at > ?',
      args: [user, Date.now() - 60 * 60 * 1000],
    });
    if (Number(rows[0].n) >= 10) throw new HttpError(429, 'Не больше 10 пресетов в час');
    const res = await client.execute({
      sql: 'INSERT INTO eq_presets (name, gains, author, created_at) VALUES (?, ?, ?, ?)',
      args: [name, JSON.stringify(gains), user, Date.now()],
    });
    return json({ id: Number(res.lastInsertRowid), name, gains }, 201);
  },
});
