// Выдаёт браузеру одноразовый токен на загрузку файла прямо в Vercel Blob.
// Файл идёт из браузера в хранилище напрямую, минуя функцию (у функций лимит ~4.5 МБ на запрос).
import { handleUpload } from '@vercel/blob/client';
import { body, HttpError, isUserId, json, route } from './_lib.js';

const MAX_SIZE = 60 * 1024 * 1024; // 60 МБ — с запасом для FLAC

export const { POST } = route({
  async POST(request) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, 'Хранилище не настроено: нет BLOB_READ_WRITE_TOKEN');
    const payload = await body(request);
    const result = await handleUpload({
      body: payload,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // clientPayload — id пользователя; класть файлы можно только в свою папку
        if (!isUserId(clientPayload) || !pathname.startsWith(`u/${clientPayload.toLowerCase()}/`)) {
          throw new HttpError(403, 'Загрузка в чужую папку запрещена');
        }
        return {
          allowedContentTypes: ['audio/*', 'image/*', 'video/ogg', 'video/webm', 'application/octet-stream'],
          maximumSizeInBytes: MAX_SIZE,
          addRandomSuffix: true,
        };
      },
    });
    return json(result);
  },
});
