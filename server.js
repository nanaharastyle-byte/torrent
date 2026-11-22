
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3000;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const MAX_TORRENT_SIZE = 10 * 1024 * 1024;

const torrents = new Map();
const tickets = new Map();

let clientPromise = null;

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// WebTorrent
async function getClient() {
  if (!clientPromise) {
    clientPromise = import('webtorrent').then(
      ({ default: WebTorrent }) => new WebTorrent()
    );
  }

  return clientPromise;
}

// 認証
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
}

function auth(req, res, next) {
  if (!BRIDGE_TOKEN) {
    return res.status(503).json({
      error: 'BRIDGE_TOKENが設定されていません'
    });
  }

  const token = req.get('x-bridge-token') || '';

  if (!safeEqual(token, BRIDGE_TOKEN)) {
    return res.status(401).json({
      error: '認証キーが違います'
    });
  }

  next();
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '2.0.1'
  });
});

app.use('/api', auth);

// Torrentイベント監視
function attachEvents(entry, torrent) {

  torrent.on('infoHash', () => {
    entry.infoHash = torrent.infoHash;
    entry.state = 'metadata';
  });

  torrent.on('metadata', () => {
    entry.name = torrent.name;
    entry.state = 'finding-peers';
  });

  torrent.on('ready', () => {
    entry.name = torrent.name;
    entry.state = torrent.done
      ? 'completed'
      : 'downloading';
  });

  torrent.on('wire', () => {
    entry.peerConnections++;

    if (entry.state === 'finding-peers') {
      entry.state = 'downloading';
    }
  });

  torrent.on('noPeers', (type) => {
    entry.lastPeerNotice = String(type);
  });

  torrent.on('download', (bytes) => {
    entry.downloadedBytes += bytes;
    entry.state = 'downloading';
  });

  torrent.on('done', () => {
    entry.state = 'completed';
  });

  torrent.on('warning', (err) => {
    entry.warnings.push(err.message || String(err));
    entry.warnings = entry.warnings.slice(-5);

    console.warn('[Torrent warning]', err);
  });

  torrent.on('error', (err) => {
    entry.state = 'error';
    entry.error = err.message || String(err);

    console.error('[Torrent error]', err);
  });
}

// Torrent登録共通処理
async function addTorrent(input, sourceName) {

  const client = await getClient();

  return new Promise((resolve, reject) => {

    const id = crypto.randomUUID();

    const entry = {
      id,
      name: sourceName || 'メタデータ取得中...',
      infoHash: null,
      state: 'adding',
      error: null,
      warnings: [],
      peerConnections: 0,
      downloadedBytes: 0,
      lastPeerNotice: null,
      createdAt: Date.now(),
      torrent: null
    };

    try {

      const torrent = client.add(input, {
        path: DOWNLOAD_DIR
      });

      entry.torrent = torrent;

      torrents.set(id, entry);

      attachEvents(entry, torrent);

      resolve(entry);

    } catch (err) {

      reject(err);

    }

  });
}

// マグネットリンク追加
app.post('/api/add', async (req, res) => {

  try {

    const magnet = String(
      req.body?.magnetOrTorrent || ''
    ).trim();

    if (!magnet.startsWith('magnet:?')) {
      return res.status(400).json({
        ok: false,
        error: '有効なマグネットリンクが必要です'
      });
    }

    const entry = await addTorrent(
      magnet,
      'マグネット取得中...'
    );

    res.status(202).json({
      ok: true,
      id: entry.id,
      message: 'マグネットを登録しました'
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

// .torrentアップロード
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_TORRENT_SIZE,
    files: 1
  }
});

app.post(
  '/api/add-file',
  upload.single('torrent'),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: 'Torrentファイルを選択してください'
        });
      }

      const entry = await addTorrent(
        req.file.buffer,
        req.file.originalname
      );

      res.status(202).json({
        ok: true,
        id: entry.id,
        message: '.torrentを登録しました'
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        ok: false,
        error: err.message
      });

    }

  }
);

// 状態取得
function serialize(entry) {

  const t = entry.torrent;

  const files = t?.files?.map((f, index) => ({
    index,
    name: path.basename(
      String(f.name).replace(/\\/g, '/')
    ),
    length: f.length,
    progress: Number(
      ((f.progress || 0) * 100).toFixed(1)
    ),
    done: Boolean(f.done)
  })) || [];

  return {
    id: entry.id,
    infoHash: entry.infoHash || t?.infoHash || null,
    name: t?.name || entry.name,
    state: entry.state,
    error: entry.error,
    warnings: entry.warnings,
    progress: t
      ? Number(((t.progress || 0) * 100).toFixed(1))
      : 0,
    downloadSpeed: t?.downloadSpeed || 0,
    numPeers: t?.numPeers || 0,
    downloadedBytes: entry.downloadedBytes,
    lastPeerNotice: entry.lastPeerNotice,
    files
  };

}

app.get('/api/status', (req, res) => {

  res.json({
    torrents: Array.from(torrents.values())
      .map(serialize)
  });

});

// ダウンロード用チケット発行
app.post('/api/ticket', (req, res) => {

  const { id, fileIndex } = req.body || {};

  const entry = torrents.get(String(id));
  const index = Number(fileIndex);

  if (
    !entry ||
    !entry.torrent ||
    !Number.isInteger(index) ||
    index < 0 ||
    !entry.torrent.files[index]
  ) {
    return res.status(404).json({
      error: 'ファイルが見つかりません'
    });
  }

  const ticket = crypto.randomBytes(24).toString('hex');

  tickets.set(ticket, {
    id: entry.id,
    index,
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  res.json({
    url: '/api/download/' + ticket
  });

});

// Safari向けダウンロード
app.get('/api/download/:ticket', (req, res) => {

  const ticket = tickets.get(req.params.ticket);

  tickets.delete(req.params.ticket);

  if (!ticket || ticket.expiresAt < Date.now()) {
    return res.status(403).send(
      'Download link expired'
    );
  }

  const entry = torrents.get(ticket.id);

  const file = entry?.torrent?.files?.[ticket.index];

  if (!file) {
    return res.status(404).send(
      'File not found'
    );
  }

  const filename = path.basename(
    String(file.name).replace(/\\/g, '/')
  ).replace(/[\r\n"]/g, '_');

  res.setHeader(
    'Content-Type',
    'application/octet-stream'
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  const stream = file.createReadStream();

  stream.on('error', (err) => {

    console.error('[Download error]', err);

    if (!res.headersSent) {
      res.status(500).end('Download failed');
    } else {
      res.destroy(err);
    }

  });

  stream.pipe(res);

});

// Torrent一覧から削除
app.delete('/api/torrents/:id', async (req, res) => {

  const entry = torrents.get(req.params.id);

  if (!entry) {
    return res.status(404).json({
      error: 'Torrentが見つかりません'
    });
  }

  try {

    if (entry.torrent && !entry.torrent.destroyed) {

      await new Promise((resolve) => {
        entry.torrent.destroy(
          { destroyStore: false },
          resolve
        );
      });

    }

    torrents.delete(req.params.id);

    res.json({ ok: true });

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }

});

// アップロードエラー
app.use((err, req, res, next) => {

  console.error('[Request error]', err);

  if (
    err instanceof multer.MulterError &&
    err.code === 'LIMIT_FILE_SIZE'
  ) {
    return res.status(413).json({
      error: '.torrentは10MB以下にしてください'
    });
  }

  res.status(500).json({
    error: err.message || 'サーバーエラー'
  });

});

// 起動
app.listen(PORT, '0.0.0.0', () => {

  console.log(
    `BitTorrent Bridge 2.0.1 listening on ${PORT}`
  );

  console.log(
    `Download directory: ${DOWNLOAD_DIR}`
  );

  if (!BRIDGE_TOKEN) {
    console.warn(
      'WARNING: BRIDGE_TOKEN is not configured'
    );
  }

});
