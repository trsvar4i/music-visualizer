// Общие помощники для серверных функций.
// Файлы в api/ с подчёркиванием Vercel не превращает в отдельные маршруты.
// Все секреты берутся только из переменных окружения:
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN — база Turso
//   BLOB_READ_WRITE_TOKEN               — хранилище Vercel Blob (читает сама библиотека @vercel/blob)
import { createClient } from '@libsql/client';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const json = (data, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

// Схема создаётся при первом обращении после «холодного» старта функции
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tracks (
     id         TEXT PRIMARY KEY,
     owner      TEXT NOT NULL,
     position   REAL NOT NULL,
     name       TEXT,
     title      TEXT NOT NULL,
     artist     TEXT,
     album      TEXT,
     duration   REAL,
     audio_url  TEXT NOT NULL,
     cover_url  TEXT,
     created_at INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS tracks_owner ON tracks (owner, position)',
  `CREATE TABLE IF NOT EXISTS settings (
     owner      TEXT PRIMARY KEY,
     data       TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS eq_presets (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT NOT NULL,
     gains      TEXT NOT NULL,
     author     TEXT,
     created_at INTEGER NOT NULL
   )`,
];

let client = null;
let schema = null;

export async function db() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new HttpError(503, 'База не настроена: нет переменной TURSO_DATABASE_URL');
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  schema ??= client.batch(SCHEMA, 'write').catch((e) => { schema = null; throw e; });
  await schema;
  return client;
}

// Пользователь анонимный: браузер при первом заходе придумывает себе UUID и присылает его в заголовке
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUserId = (id) => typeof id === 'string' && UUID.test(id);

export function owner(request) {
  const id = request.headers.get('x-user-id');
  if (!isUserId(id)) throw new HttpError(400, 'Нет идентификатора пользователя');
  return id.toLowerCase();
}

// Принимаем только ссылки на собственное хранилище Blob
export function isBlobUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname.endsWith('.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

export const text = (value, max = 300) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Тело запроса должно быть JSON');
  }
}

// Оборачивает обработчики методов: ошибки превращаются в JSON с понятным статусом
export function route(handlers) {
  const wrapped = {};
  for (const [method, fn] of Object.entries(handlers)) {
    wrapped[method] = async (request) => {
      try {
        return await fn(request);
      } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error(e);
        return json({ error: status >= 500 && !e.status ? 'Внутренняя ошибка сервера' : e.message }, status);
      }
    };
  }
  return wrapped;
}
