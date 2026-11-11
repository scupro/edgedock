/**
 * Preview registry: file extension -> preview kind.
 * Keep README's "支援預覽格式" table in sync with this file.
 */
export type PreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'docx'
  | 'sheet'
  | 'markdown'
  | 'code'
  | 'text'
  | 'json'
  | 'epub'
  | 'svg'
  | 'external'
  | 'none';

export const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'apng'];
export const VIDEO = ['mp4', 'webm', 'm4v', 'mov', 'ogv', 'mkv'];
export const AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'weba'];
export const SHEET = ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv', 'numbers'];
export const TEXT = ['txt', 'log', 'ini', 'conf', 'cfg', 'env', 'properties', 'gitignore', 'editorconfig', 'srt', 'vtt', 'nfo'];
export const MARKDOWN = ['md', 'markdown', 'mdown', 'mkd'];

/** extension -> highlight.js language */
export const CODE: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', vue: 'xml', svelte: 'xml',
  html: 'xml', htm: 'xml', xml: 'xml', xhtml: 'xml', css: 'css', scss: 'scss', less: 'less',
  py: 'python', rb: 'ruby', php: 'php', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'groovy',
  go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', m: 'objectivec', dart: 'dart',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', bat: 'dos', cmd: 'dos',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'ini', dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', nginx: 'nginx',
  lua: 'lua', r: 'r', pl: 'perl', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', clj: 'clojure', fs: 'fsharp', vb: 'vbnet',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf', tf: 'ini', diff: 'diff', patch: 'diff', tex: 'latex', jl: 'julia', zig: 'zig', nim: 'nim',
};

export function previewKind(name: string, externalExts: string[] = []): PreviewKind {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  if (lower === 'dockerfile' || lower === 'makefile') return 'code';
  if (IMAGE.includes(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (VIDEO.includes(ext)) return 'video';
  if (AUDIO.includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (SHEET.includes(ext)) return 'sheet';
  if (MARKDOWN.includes(ext)) return 'markdown';
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson') return 'json';
  if (ext === 'epub') return 'epub';
  if (CODE[ext]) return 'code';
  if (TEXT.includes(ext)) return 'text';
  if (externalExts.includes(ext)) return 'external';
  return 'none';
}

/** Text-like kinds are fetched as text (size-limited). */
export const TEXT_KINDS: PreviewKind[] = ['markdown', 'code', 'text', 'json'];
export const MAX_TEXT_PREVIEW = 5 * 1024 * 1024;

export function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return '📁';
  const k = previewKind(name, ['ppt', 'pptx', 'doc']);
  return (
    { image: '🖼️', svg: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', docx: '📘', sheet: '📊', markdown: '📝', code: '🧩', text: '📄', json: '🧾', epub: '📚', external: '📙', none: '📦' } as Record<string, string>
  )[k];
}
