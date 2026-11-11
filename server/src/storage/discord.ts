/**
 * Discord (bot): every file part is a message attachment in one channel; the directory tree and
 * part list are kept in D1. Attachment URLs are signed and expire (ex= / is= / hm=), so reads
 * refresh them through the API (GET message) when expired or rejected. Default part size 8 MiB
 * (bots may upload 10 MiB per message on non-boosted servers).
 */
import { ensureOk, fetchRetry, ProviderError } from './http';
import { PartStoreDriver, type PartRef } from './partstore';
import { rangeHeader } from './base';
import type { DriverContext, DriverDefinition } from './types';

export interface DiscordConfig {
  botToken: string;
  channelId: string;
  partSizeMB?: number;
  apiBase?: string;
}

const MiB = 1024 * 1024;

interface DcRef extends PartRef {
  m: string; // message id
  a: string; // attachment id
  u: string; // last known (signed) URL
}

interface DcMessage {
  id: string;
  attachments: { id: string; url: string; size: number; filename: string }[];
}

/** expiry (epoch ms) from a signed CDN URL's `ex` hex parameter; 0 if unknown */
export function discordUrlExpiry(url: string): number {
  try {
    const ex = new URL(url).searchParams.get('ex');
    return ex ? parseInt(ex, 16) * 1000 : 0;
  } catch {
    return 0;
  }
}

export class DiscordDriver extends PartStoreDriver {
  readonly type = 'discord';
  private base: string;
  private fetchFn: typeof fetch;
  private fresh = new Map<string, string>();

  constructor(
    private cfg: DiscordConfig,
    ctx: DriverContext,
  ) {
    super(ctx, Math.max(256 * 1024, Math.floor((Number(cfg.partSizeMB) || 8) * MiB)));
    if (!cfg.botToken) throw new Error('Discord bot token is required');
    if (!cfg.channelId) throw new Error('Discord channel id is required');
    this.base = (cfg.apiBase || 'https://discord.com/api/v10').replace(/\/+$/, '');
    this.fetchFn = ctx.fetch;
  }

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bot ${this.cfg.botToken}`, 'user-agent': 'DiscordBot (https://github.com/scupro/edgedock, 0.2)', ...extra };
  }

  private api(path: string, init: () => RequestInit = () => ({})): Promise<Response> {
    // fetchRetry honours 429 retry_after (JSON / headers) with backoff
    return fetchRetry(this.fetchFn, this.base + path, () => {
      const i = init();
      return { ...i, headers: this.headers((i.headers as Record<string, string>) ?? {}) };
    });
  }

  protected async putPart(bytes: Uint8Array, name: string): Promise<DcRef> {
    const res = await this.api(`/channels/${this.cfg.channelId}/messages`, () => {
      const fd = new FormData();
      fd.set('payload_json', JSON.stringify({ content: '', attachments: [{ id: 0, filename: name }], flags: 4096 }));
      fd.set('files[0]', new Blob([bytes as unknown as ArrayBuffer], { type: 'application/octet-stream' }), name);
      return { method: 'POST', body: fd };
    });
    await ensureOk(res, 'Discord upload');
    const msg = (await res.json()) as DcMessage;
    const att = msg.attachments?.[0];
    if (!att) throw new ProviderError(502, 'Discord returned no attachment');
    if (att.size !== undefined && att.size !== bytes.byteLength) throw new ProviderError(502, `Discord stored ${att.size} of ${bytes.byteLength} bytes`);
    return { size: bytes.byteLength, m: msg.id, a: att.id, u: att.url };
  }

  /** current signed URL for an attachment (refreshed through the API when expired) */
  async attachmentUrl(ref: DcRef, force = false): Promise<string> {
    const known = this.fresh.get(ref.a) ?? ref.u;
    const exp = discordUrlExpiry(known);
    if (!force && exp && exp - 60_000 > Date.now()) return known;
    const res = await this.api(`/channels/${this.cfg.channelId}/messages/${ref.m}`);
    await ensureOk(res, 'Discord message');
    const msg = (await res.json()) as DcMessage;
    const att = msg.attachments.find((x) => x.id === ref.a) ?? msg.attachments[0];
    if (!att) throw new ProviderError(404, 'Discord attachment is gone');
    this.fresh.set(ref.a, att.url);
    return att.url;
  }

  protected async openPart(ref: PartRef, range?: { start: number; end: number }) {
    const r = ref as DcRef;
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = await this.attachmentUrl(r, attempt > 0);
      const res = await fetchRetry(this.fetchFn, url, (): RequestInit => ({ headers: range ? { range: rangeHeader(range) } : ({} as Record<string, string>) }));
      if ((res.status === 403 || res.status === 404 || res.status === 410) && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        continue; // signature expired → refresh
      }
      await ensureOk(res, 'Discord download');
      return { body: res.body!, ranged: res.status === 206 };
    }
    throw new ProviderError(404, 'Discord attachment not available');
  }

  protected async deletePart(ref: PartRef): Promise<void> {
    const res = await this.api(`/channels/${this.cfg.channelId}/messages/${(ref as DcRef).m}`, () => ({ method: 'DELETE' }));
    await res.body?.cancel().catch(() => {});
  }

  async test(): Promise<void> {
    await ensureOk(await this.api(`/channels/${this.cfg.channelId}`), 'Discord channel');
  }
}

export const discordDefinition: DriverDefinition = {
  type: 'discord',
  label: 'Discord (Bot)',
  runtimes: ['workers', 'node'],
  notes:
    'Discord Developer Portal → New Application → Bot → copy the token; invite it with View Channel, Send Messages, Attach Files, Read Message History (and Manage Messages to delete). Channel id: enable Developer Mode → right-click the channel → Copy ID. Files are split into parts (default 8 MiB; bots may send 10 MiB per message) stored as attachments; expiring CDN links are refreshed automatically.',
  notesZh:
    'Discord Developer Portal → New Application → Bot → 複製 Token；邀請 Bot 時給予「檢視頻道、傳送訊息、附加檔案、讀取訊息歷史」（要刪除檔案再加「管理訊息」）。頻道 ID：開啟開發者模式 → 右鍵頻道 → 複製 ID。檔案切成分段（預設 8 MiB；Bot 每則訊息上限 10 MiB）作為附件儲存，會過期的 CDN 連結會自動重新取得。',
  fields: [
    { key: 'botToken', label: 'Bot token', labelZh: 'Bot Token', type: 'password', required: true, secret: true },
    { key: 'channelId', label: 'Channel id', labelZh: '頻道 ID', type: 'text', required: true },
    { key: 'partSizeMB', label: 'Part size (MiB, ≤ 10)', labelZh: '分段大小（MiB，最大 10）', type: 'number', default: 8 },
  ],
  create: (config, ctx) => new DiscordDriver(config as unknown as DiscordConfig, ctx),
};
