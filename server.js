const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let clientPromise = null;
async function getClient() {
  if (!clientPromise) {
    clientPromise = import('webtorrent').then(({ default: WebTorrent }) => new WebTorrent());
  }
  return clientPromise;
}

const torrents = new Map();

function serializeTorrent(t) {
  return {
    infoHash: t.infoHash,
    name: t.name || 'メタデータ取得中...',
    progress: Number((t.progress * 100).toFixed(1)),
    downloadSpeed: t.downloadSpeed,
    numPeers: t.numPeers,
    files: (t.files || []).map((f, idx) => ({
      index: idx,
      name: f.name,
      length: f.length,
      progress: Number((f.progress * 100).toFixed(1)),
      done: f.done
    }))
  };
}

app.post('/api/add', async (req, res) => {
  try {
    const { magnetOrTorrent } = req.body;
    if (!magnetOrTorrent) {
      return res.status(400).json({ error: 'マグネットリンクまたはトレントデータが必要です' });
    }

    const client = await getClient();
    const input = magnetOrTorrent.startsWith('base64:')
      ? Buffer.from(magnetOrTorrent.slice(7), 'base64')
      : magnetOrTorrent;

    const torrent = client.add(input, { path: DOWNLOAD_DIR });
    torrents.set(torrent.infoHash || String(Date.now()), torrent);

    torrent.on('infoHash', () => {
      torrents.set(torrent.infoHash, torrent);
    });

    res.json({ ok: true, infoHash: torrent.infoHash || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  await getClient();
  const list = [];
  for (const t of torrents.values()) {
    list.push(serializeTorrent(t));
  }
  res.json({ torrents: list });
});

app.get('/api/file/:infoHash/:fileIndex', async (req, res) => {
  const client = await getClient();
  const torrent = await client.get(req.params.infoHash);
  if (!torrent) {
    return res.status(404).send('Torrent not found');
  }
  const file = torrent.files[Number(req.params.fileIndex)];
  if (!file) {
    return res.status(404).send('File not found');
  }

  res.attachment(path.basename(file.name));
  file.createReadStream().pipe(res);
});

app.listen(PORT, () => {
  console.log(`Bridge server listening on port ${PORT}`);
});
