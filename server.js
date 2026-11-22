
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRIDGE_TOKEN || '';

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let clientPromise;

const torrents = new Map();
const tickets = new Map();

async function getClient() {
  if (!clientPromise) {
    clientPromise = import('webtorrent').then(
      ({ default: WebTorrent }) => new WebTorrent()
    );
  }
  return clientPromise;
}

function authenticate(req, res, next) {
  if (!TOKEN) {
    return res.status(503).json({
      error: 'BRIDGE_TOKENが未設定です'
    });
  }

  const supplied = req.get('x-bridge-token') || '';
  const a = Buffer.from(TOKEN);
  const b = Buffer.from(supplied);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: 'アクセスキーが違います'
    });
  }

  next();
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '2.1.0'
  });
});

app.use('/api', authenticate);

// Torrent登録
async function addTorrent(input, name) {
  if (
    typeof input !== 'string' &&
    !Buffer.isBuffer(input)
  ) {
    throw new Error('Torrentデータが空です');
  }

  if (Buffer.isBuffer(input) && input.length === 0) {
    throw new Error('Torrentファイルが空です');
  }

  if (typeof input === 'string' &&
      !input.startsWith('magnet:?')) {
    throw new Error('マグネットリンクが不正です');
  }

  const client = await getClient();
  const id = crypto.randomUUID();

  const entry = {
    id,
    name: name || '取得中...',
    state: '登録中',
    error: null,
    torrent: null,
    createdAt: Date.now()
  };

  torrents.set(id, entry);

  try {
    const torrent = client.add(input, {
      path: DOWNLOAD_DIR
    });

    entry.torrent = torrent;

    torrent.on('metadata', () => {
      entry.name = torrent.name;
      entry.state = 'ピア探索中';
    });

    torrent.on('ready', () => {
      entry.name = torrent.name;
      entry.state = torrent.done ? '完了' : '取得中';
    });

    torrent.on('wire', () => {
      if (!torrent.done) {
        entry.state = '取得中';
      }
    });

    torrent.on('download', () => {
      entry.state = '取得中';
    });

    torrent.on('done', () => {
      entry.state = '完了';
    });

    torrent.on('error', (err) => {
      entry.state = 'エラー';
      entry.error = err.message;
      console.error('[TORRENT]', err);
    });

    return entry;

  } catch (err) {
    torrents.delete(id);
    throw err;
  }
}

// マグネット登録
app.post('/api/add', async (req, res) => {
  try {
    const magnet = req.body?.magnetOrTorrent;

    if (typeof magnet !== 'string' ||
        !magnet.startsWith('magnet:?')) {
      return res.status(400).json({
        ok: false,
        error: 'マグネットリンクを確認してください'
      });
    }

    const parsed = new URL(magnet);
    const xt = parsed.searchParams.get('xt');

    if (!xt || !/^urn:btih:[a-zA-Z0-9]{32,40}$/i.test(xt)) {
      return res.status(400).json({
        ok: false,
        error: 'InfoHashが正しくありません'
      });
    }

    const entry = await addTorrent(
      magnet,
      'マグネット取得中...'
    );

    console.log('[MAGNET] Added:', entry.id);

    res.status(202).json({
      ok: true,
      id: entry.id
    });

  } catch (err) {
    console.error('[MAGNET ERROR]', err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// Torrentファイル受信
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  }
});

app.post(
  '/api/add-file',
  upload.single('torrent'),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          ok: false,
          error: 'Torrentファイルを受信できませんでした'
        });
      }

      const data = req.file.buffer;

      if (!Buffer.isBuffer(data) || data.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'Torrentファイルの内容が空です'
        });
      }

      const entry = await addTorrent(
        data,
        req.file.originalname
      );

      console.log(
        '[FILE] Added:',
        req.file.originalname,
        data.length,
        'bytes'
      );

      res.status(202).json({
        ok: true,
        id: entry.id
      });

    } catch (err) {
      console.error('[FILE ERROR]', err);

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

// 状態一覧
app.get('/api/status', (req, res) => {
  const result = [];

  for (const entry of torrents.values()) {
    const t = entry.torrent;

    result.push({
      id: entry.id,
      name: t?.name || entry.name,
      state: entry.state,
      error: entry.error,
      progress: t
        ? Number(((t.progress || 0) * 100).toFixed(1))
        : 0,
      peers: t?.numPeers || 0,
      speed: t?.downloadSpeed || 0,
      files: (t?.files || []).map((f, index) => ({
        index,
        name: path.basename(f.name),
        size: f.length,
        progress: Number(
          ((f.progress || 0) * 100).toFixed(1)
        ),
        done: f.done
      }))
    });
  }

  res.json({ torrents: result });
});

// ダウンロードチケット
app.post('/api/ticket', (req, res) => {
  const id = String(req.body?.id || '');
  const index = Number(req.body?.fileIndex);

  const entry = torrents.get(id);
  const file = entry?.torrent?.files?.[index];

  if (!file || !Number.isInteger(index) || index < 0) {
    return res.status(404).json({
      error: 'ファイルが見つかりません'
    });
  }

  const ticket = crypto.randomBytes(24).toString('hex');

  tickets.set(ticket, {
    id,
    index,
    expires: Date.now() + 10 * 60 * 1000
  });

  res.json({
    url: '/api/download/' + ticket
  });
});

// Safariダウンロード
app.get('/api/download/:ticket', (req, res) => {
  const data = tickets.get(req.params.ticket);

  tickets.delete(req.params.ticket);

  if (!data || data.expires < Date.now()) {
    return res.status(403).send('リンクの有効期限が切れました');
  }

  const entry = torrents.get(data.id);
  const file = entry?.torrent?.files?.[data.index];

  if (!file) {
    return res.status(404).send('ファイルがありません');
  }

  const filename = path.basename(file.name)
    .replace(/[\r\n"]/g, '_');

  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  res.setHeader(
    'Content-Type',
    'application/octet-stream'
  );

  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = file.createReadStream();

  stream.on('error', (err) => {
    console.error('[DOWNLOAD ERROR]', err);
    if (!res.headersSent) {
      res.status(500).end('Download failed');
    } else {
      res.destroy(err);
    }
  });

  stream.pipe(res);
});

// Torrent削除
app.delete('/api/torrents/:id', async (req, res) => {
  const entry = torrents.get(req.params.id);

  if (!entry) {
    return res.status(404).json({
      error: 'Torrentがありません'
    });
  }

  try {
    if (entry.torrent) {
      await new Promise((resolve) => {
        entry.torrent.destroy(
          { destroyStore: false },
          resolve
        );
      });
    }

    torrents.delete(entry.id);

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

// Multerなどのエラー
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);

  if (err instanceof multer.MulterError) {
    return res.status(413).json({
      error: 'アップロードに失敗しました: ' + err.message
    });
  }

  res.status(500).json({
    error: err.message || 'サーバーエラー'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('BitTorrent Bridge 2.1.0');
  console.log('Port:', PORT);
  console.log('Node:', process.version);
  console.log('Token configured:', Boolean(TOKEN));
});
