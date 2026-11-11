import { extname } from './path';

const MIME: Record<string, string> = {
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', ts: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8', yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8', toml: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  pdf: 'application/pdf', epub: 'application/epub+zip', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

const TEXT_EXT = new Set(['py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'sql', 'vue', 'jsx', 'tsx', 'swift', 'dart', 'lua', 'r', 'scala', 'ini', 'conf', 'env', 'dockerfile', 'makefile', 'gradle', 'properties', 'scss', 'less', 'svelte']);

export function mimeFromPath(path: string): string {
  const ext = extname(path);
  if (MIME[ext]) return MIME[ext];
  if (TEXT_EXT.has(ext)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
