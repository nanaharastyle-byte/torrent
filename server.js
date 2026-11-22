'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
// Render Free storage is ephemeral. This directory is only a temporary working area.
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'));
const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
const torrents = new Map();
const tickets = new Map();
let clientPromise;

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function getClient() {
  if (!clientPromise) {
    clientPromise = import('webtorrent').then(({ default: WebTorrent }) => new WebTorrent());
  }
  return clientPromise;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireToken(req, res, next) {
  if (!BRIDGE_TOKEN) {
    return res.status(503).json({ error: 'サーバー管理者が BRIDGE_TOKEN を設定していません。RenderのEnvironmentで設定してください。' });
  }
  const supplied = req.get('x-bridge-token') || '';
  if (!safeEqual(supplied, BRIDGE_TOKEN)) {
    return res.status(401).json({ error: '認証トークンが違います。' });
  }
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, version: '2.0.0' }));
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  return requireToken(req, res, next);
});

function attachTorrentEvents(entry, torrent) {
  torrent.on('infoHash', () => {
    entry.infoHash = torrent.infoHash;
    entry.state = 'metadata';
  });
  torrent.on('metadata', () => {
    entry.name = torrent.name || entry.name;
    entry.state = 'finding-peers';
    entry.updatedAt = Date.now();
  });
  torrent.on('ready', () => {
    entry.name = torrent.name || entry.name;
    entry.state = torrent.done ? 'completed' : 'downloading';
    entry.updatedAt = Date.now();
  });
  torrent.on('wire', () => {
    entry.peerConnections = (entry.peerConnections || 0) + 1;
    if (entry.state === 'finding-peers') entry.state = 'downloading';
  });
  torrent.on('noPeers', (type) => {
    entry.lastPeerNotice = String(type || 'unknown');
    entry.updatedAt = Date.now();
  });
  torrent.on('download', (bytes) => {
    entry.downloadedBytes = (entry.downloadedBytes || 0) + bytes;
    entry.state = 'downloading';
    entry.updatedAt = Date.now();
  });
  torrent.on('done', () => {
    entry.state = 'completed';
    entry.updatedAt = Date.now();
  });
  torrent.on('warning', (err) => {
    entry.warnings.push(String(err && err.message ? err.message : err).slice(0, 300));
    entry.warnings = entry.warnings.slice(-5);
    entry.updatedAt = Date.now();
  });
  torrent.on('error', (err) => {
    entry.state = 'error';
    entry.error = String(err && err.message ? err.message : err).slice(0, 500);
    entry.updatedAt = Date.now();
  });
}

function addTorrent(input, sourceName) {
  return getClient().then((client) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const entry = {
      id,
      name: sourceName || 'メタデータ取得中…',
      infoHash: null,
      state: 'adding',
      error: null,
      warnings: [],
      peerConnections: 0,
      downloadedBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      torrent: null
    };
    let torrent;
    try {
      torrent = client.add(input, { path: DOWNLOAD_DIR });
      entry.torrent = torrent;
      torrents.set(id, entry);
      attachTorrentEvents(entry, torrent);
      // Return once the add request has been accepted, not when downloading completes.
      resolve(entry);
    } catch (err) {
      reject(err);
    }
  }));
}

app.post('/api/add', async (req, res) => {
  try {
    const magnet = String(req.body && req.body.magnetOrTorrent || '').trim();
    if (!magnet || !magnet.startsWith('magnet:?')) {
      return res.status(400).json({ ok: false, error: '有効なmagnet:?リンクを入力してください。' });
    }
    const entry = await addTorrent(magnet, 'マグネットのメタデータ取得中…');
    res.status(202).json({ ok: true, id: entry.id, state: entry.state, message: '登録を受け付けました。ピア探索と取得状況は一覧で確認してください。' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Torrentの追加に失敗しました。' });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TORRENT_BYTES, files: 1 } });
app.post('/api/add-file', upload.single('torrent'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '.torrentファイルを選択してください。' });
    const entry = await addTorrent(req.file.buffer, req.file.originalname);
    res.status(202).json({ ok: true, id: entry.id, state: entry.state, message: '.torrentを受け付けました。ピア探索と取得状況は一覧で確認してください。' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '.torrentの追加に失敗しました。' });
  }
});

function serialize(entry) {
  const t = entry.torrent;
  const files = t && t.files ? t.files.map((f, index) => ({
    index,
    name: path.basename(String(f.name).replace(/\\/g, '/')),
    length: f.length,
    progress: Number(((f.progress || 0) * 100).toFixed(1)),
    done: Boolean(f.done)
  })) : [];
  return {
    id: entry.id,
    infoHash: entry.infoHash || (t && t.infoHash) || null,
    name: (t && t.name) || entry.name,
    state: entry.state,
    error: entry.error,
    warnings: entry.warnings,
    progress: t ? Number(((t.progress || 0) * 100).toFixed(1)) : 0,
    downloadSpeed: t ? t.downloadSpeed : 0,
    numPeers: t ? t.numPeers : 0,
    downloadedBytes: entry.downloadedBytes,
    lastPeerNotice: entry.lastPeerNotice || null,
    files
  };
}

app.get('/api/status', (_req, res) => {
  res.json({ torrents: Array.from(torrents.values()).map(serialize) });
});

app.post('/api/ticket', (req, res) => {
  const { id, fileIndex } = req.body || {};
  const entry = torrents.get(String(id));
  const index = Number(fileIndex);
  if (!entry || !entry.torrent || !entry.torrent.files || !Number.isInteger(index) || index < 0 || !entry.torrent.files[index]) {
    return res.status(404).json({ error: '対象ファイルが見つかりません。' });
  }
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { id: entry.id, index, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ url: `/api/download/${ticket}` });
});

app.get('/api/download/:ticket', (req, res) => {
  const ticket = tickets.get(req.params.ticket);
  tickets.delete(req.params.ticket); // one-time ticket
  if (!ticket || ticket.expiresAt < Date.now()) return res.status(403).send('Download link expired. Please create a new link.');
  const entry = torrents.get(ticket.id);
  const file = entry && entry.torrent && entry.torrent.files[ticket.index];
  if (!file) return res.status(404).send('File not found');
  const filename = path.basename(String(file.name).replace(/\\/g, '/')).replace(/[\r\n"]/g, '_');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const stream = file.createReadStream();
  stream.on('error', (err) => {
    console.error('[File stream error]', err);
    if (!res.headersSent) res.status(500).end('Download stream failed');
    else res.destroy(err);
  });
  stream.pipe(res);
});

app.delete('/api/torrents/:id', async (req, res) => {
  const entry = torrents.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Torrentが見つかりません。' });
  try {
    if (entry.torrent && !entry.torrent.destroyed) await new Promise((resolve) => entry.torrent.destroy({ destroyStore: false }, resolve));
    torrents.delete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error('[Request error]', err);
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '.torrentファイルは10MB以下にしてください。' });
  }
  res.status(500).json({ error: err.message || 'サーバー内部エラー' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BitTorrent Bridge 2.0 listening on ${PORT}`);
  console.log(`Temporary download directory: ${DOWNLOAD_DIR}`);
  if (!BRIDGE_TOKEN) console.warn('WARNING: Set BRIDGE_TOKEN in Render Environment before using this public service.');
});
