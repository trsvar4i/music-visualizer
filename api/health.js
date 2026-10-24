// Проверка, что облако настроено: страница по этому ответу решает,
// хранить данные в Turso/Blob или по-старому в браузере.
import { db, json, route } from './_lib.js';

export const { GET } = route({
  async GET() {
    const blob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    try {
      const client = await db();
      await client.execute('SELECT 1');
      return json({ cloud: blob, db: true, blob });
    } catch (e) {
      return json({ cloud: false, db: false, blob, error: e.message }, 503);
    }
  },
});
