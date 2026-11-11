/**
 * Telegram (Bot API): every file part is a document message in a chat / channel; the directory tree
 * and part list are kept in D1. Limits of the public Bot API: uploads ≤ 50 MB per document, but
 * getFile downloads ≤ 20 MB — so parts are ≤ 20 MB (default 19 MiB) and are reassembled on read
 * (Range supported). With a self-hosted Bot API server (`apiBase`) the part size can be raised.
 */
import { ensureOk, fetchRetry, ProviderError } from './http';
import { PartStoreDriver, type PartRef } from './partstore';
import { rangeHeader } from './base';
import type { DriverContext, DriverDefinition } from './types';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  apiBase?: string;
  partSizeMB?: number;
}

const MiB = 1024 * 1024;
/** getFile limit of the public Bot API */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1000 * 1000;

interface TgRef extends PartRef {
  fileId: string;
  messageId: number;
}

export class TelegramDriver extends PartStoreDriver {
  readonly type = 'telegram';
  private base: string;
  private fetchFn: typeof fetch;
  private pathCache = new Map<string, { path: string; at: number }>();

  constructor(
    private cfg: TelegramConfig,
    ctx: DriverContext,
  ) {
    const custom = !!cfg.apiBase && !/api\.telegram\.org/.test(cfg.apiBase);
    const want = Math.floor((Number(cfg.partSizeMB) || 19) * MiB);
    // public API: never exceed the 20 MB getFile limit, whatever was configured
    super(ctx, custom ? Math.min(want, 2000 * MiB) : Math.min(want, TELEGRAM_DOWNLOAD_LIMIT));
    if (!cfg.botToken) throw new Error('Telegram bot token is required');
    if (!cfg.chatId) throw new Error('Telegram chat id is required');
    this.base = (cfg.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
    this.fetchFn = ctx.fetch;
  }

  private method(name: string): string {
    return `${this.base}/bot${this.cfg.botToken}/${name}`;
  }

  private async call<T>(name: string, init: () => RequestInit): Promise<T> {
    const res = await fetchRetry(this.fetchFn, this.method(name), init);
    const j = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; error_code?: number } | null;
    if (!j?.ok) throw new ProviderError(j?.error_code ?? res.status, `Telegram ${name}: ${j?.description ?? res.status}`);
    return j.result as T;
  }

  private json(body: unknown): () => RequestInit {
    return () => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  protected async putPart(bytes: Uint8Array, name: string): Promise<TgRef> {
    const msg = await this.call<{ message_id: number; document?: { file_id: string; file_size?: number } }>('sendDocument', () => {
      const fd = new FormData();
      fd.set('chat_id', this.cfg.chatId);
      fd.set('disable_notification', 'true');
      fd.set('disable_content_type_detection', 'true');
      fd.set('document', new Blob([bytes as unknown as ArrayBuffer], { type: 'application/octet-stream' }), name);
      return { method: 'POST', body: fd };
    });
    if (!msg.document?.file_id) throw new ProviderError(502, 'Telegram returned no document');
    return { size: bytes.byteLength, fileId: msg.document.file_id, messageId: msg.message_id };
  }

  private async filePath(fileId: string, force = false): Promise<string> {
    const hit = this.pathCache.get(fileId);
    // file_path is guaranteed valid for at least one hour
    if (!force && hit && Date.now() - hit.at < 50 * 60_000) return hit.path;
    const f = await this.call<{ file_path?: string }>('getFile', this.json({ file_id: fileId }));
    if (!f.file_path) throw new ProviderError(502, 'Telegram getFile returned no file_path (file too large for getFile?)');
    this.pathCache.set(fileId, { path: f.file_path, at: Date.now() });
    return f.file_path;
  }

  protected async openPart(ref: PartRef, range?: { start: number; end: number }) {
    const r = ref as TgRef;
    for (let attempt = 0; attempt < 2; attempt++) {
      const fp = await this.filePath(r.fileId, attempt > 0);
      const headers: Record<string, string> = range ? { range: rangeHeader(range) } : {};
      const res = await fetchRetry(this.fetchFn, `${this.base}/file/bot${this.cfg.botToken}/${fp}`, () => ({ headers }));
      if ((res.status === 404 || res.status === 403) && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        continue; // stale file_path → ask getFile again
      }
      await ensureOk(res, 'Telegram download');
      return { body: res.body!, ranged: res.status === 206 };
    }
    throw new ProviderError(404, 'Telegram file not found');
  }

  protected async deletePart(ref: PartRef): Promise<void> {
    // bots can delete their own messages in channels/groups (with permission); private chats only for 48 h
    await this.call('deleteMessage', this.json({ chat_id: this.cfg.chatId, message_id: (ref as TgRef).messageId })).catch(() => {});
  }

  async test(): Promise<void> {
    await this.call('getMe', () => ({}));
    await this.call('getChat', this.json({ chat_id: this.cfg.chatId }));
  }
}

export const telegramDefinition: DriverDefinition = {
  type: 'telegram',
  label: 'Telegram (Bot API)',
  runtimes: ['workers', 'node'],
  notes:
    'Create a bot with @BotFather (token), add it as an admin of a private channel/group (post + delete messages), and use the chat id (e.g. -100…; get it from getUpdates or @userinfobot). Files are split into ≤ 20 MB parts (Bot API getFile limit) and reassembled on download; the folder tree is stored in D1. Deleting a storage keeps the messages.',
  notesZh:
    '用 @BotFather 建立 Bot 取得 Token，把 Bot 加為私人頻道／群組的管理員（可發文、可刪除訊息），填入 Chat ID（例如 -100…，可用 getUpdates 或 @userinfobot 查詢）。檔案會切成 ≤ 20 MB 的分段（Bot API getFile 下載上限），下載時自動組回並支援 Range；目錄結構存在 D1。刪除此儲存空間不會刪除頻道訊息。',
  fields: [
    { key: 'botToken', label: 'Bot token', labelZh: 'Bot Token', type: 'password', required: true, secret: true },
    { key: 'chatId', label: 'Chat / channel id', labelZh: 'Chat ID／頻道 ID', type: 'text', required: true, placeholder: '-1001234567890' },
    { key: 'partSizeMB', label: 'Part size (MiB, ≤ 19 on the public API)', labelZh: '分段大小（MiB；官方 API 最大約 19）', type: 'number', default: 19 },
    { key: 'apiBase', label: 'Bot API base URL', labelZh: 'Bot API 位址（自架 telegram-bot-api 可解除 20 MB 限制）', type: 'text', default: 'https://api.telegram.org' },
  ],
  create: (config, ctx) => new TelegramDriver(config as unknown as TelegramConfig, ctx),
};
