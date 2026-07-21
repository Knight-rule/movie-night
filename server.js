require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { URL } = require('url');
const os = require('os');

// ─────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
const MAX_ROOMS = 100;
const MAX_PARTICIPANTS_PER_ROOM = 10;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const MAX_STORAGE_BYTES = 20 * 1024 * 1024 * 1024; // 20GB
const CHAT_HISTORY_LIMIT = 200;
const RATE_LIMIT_CLEANUP_INTERVAL = 300_000; // 5 minutes

const VIDEO_EXTENSIONS = /mp4|webm|ogg|mkv|avi|mov/;

const PROXY_ALLOWED_HOSTS = [
  'drive.google.com',
  'drive.usercontent.google.com',
  'docs.google.com',
  'example.com',
  'sample-videos.com',
];

if (process.env.PROXY_ALLOWED_HOSTS) {
  process.env.PROXY_ALLOWED_HOSTS
    .split(',')
    .forEach(h => PROXY_ALLOWED_HOSTS.push(h.trim()));
}

// ─────────────────────────────────────────────────────
// Detect LAN IP and build CORS allowlist
// ─────────────────────────────────────────────────────

function detectLanIp() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const lanIp = detectLanIp();

const ALLOWED_ORIGINS = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://${lanIp}:${PORT}`,
  `https://localhost:${PORT}`,
  `https://127.0.0.1:${PORT}`,
  `https://${lanIp}:${PORT}`,
];

if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS
    .split(',')
    .forEach(o => ALLOWED_ORIGINS.push(o.trim()));
}

if (process.env.RENDER_EXTERNAL_URL) {
  ALLOWED_ORIGINS.push(process.env.RENDER_EXTERNAL_URL);
}

// ─────────────────────────────────────────────────────
// Express + Socket.IO setup
// ─────────────────────────────────────────────────────

const app = express();

const certPath = path.join(__dirname, 'certs');
const keyFile = path.join(certPath, 'key.pem');
const certFile = path.join(certPath, 'cert.pem');

function createServer() {
  const certsExist = fs.existsSync(keyFile) && fs.existsSync(certFile);
  if (certsExist) {
    const options = {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile),
    };
    console.log('HTTPS enabled (local dev)');
    return https.createServer(options, app);
  }
  console.log('HTTP only — no certs found (run: node generate-cert.js for local HTTPS)');
  return http.createServer(app);
}

const server = createServer();

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
        callback(null, true);
      } else {
        console.warn('CORS blocked:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
  },
  pingInterval: 25000,
  pingTimeout: 30000,
});

// ─────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────

app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ─────────────────────────────────────────────────────
// Rate limiting (in-memory)
// ─────────────────────────────────────────────────────

const rateLimits = new Map();

function checkRateLimit(key, maxRequests = 30, windowMs = 60_000) {
  const now = Date.now();
  const entry = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  rateLimits.set(key, entry);
  return entry.count <= maxRequests;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL);

// ─────────────────────────────────────────────────────
// File uploads
// ─────────────────────────────────────────────────────

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (VIDEO_EXTENSIONS.test(ext)) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
});

// Storage cap check (cached for 10s)
let cachedUploadsSize = 0;
let lastSizeCheck = 0;

async function getUploadsSize() {
  const now = Date.now();
  if (now - lastSizeCheck < 10_000) return cachedUploadsSize;

  try {
    const files = await fs.promises.readdir(uploadsDir);
    let total = 0;
    for (const f of files) {
      const stat = await fs.promises.stat(path.join(uploadsDir, f));
      total += stat.size;
    }
    cachedUploadsSize = total;
    lastSizeCheck = now;
    return total;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// Upload endpoint
app.post('/upload', async (req, res, next) => {
  if (!checkRateLimit(`upload:${req.ip}`, 5, 300_000)) {
    return res.status(429).json({ error: 'Too many uploads. Try again later.' });
  }
  if (await getUploadsSize() > MAX_STORAGE_BYTES) {
    return res.status(507).json({ error: 'Server storage full' });
  }
  next();
}, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname });
});

// Video proxy endpoint
app.get('/proxy', async (req, res) => {
  if (!checkRateLimit(`proxy:${req.ip}`, 20, 60_000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'Missing url param' });

  let parsed;
  try {
    parsed = new URL(videoUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only HTTPS URLs allowed' });
  }

  if (!PROXY_ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    return res.status(403).json({ error: 'Domain not allowed for proxy' });
  }

  if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(parsed.hostname)) {
    return res.status(403).json({ error: 'Internal URLs not allowed' });
  }

  try {
    const proxyRes = await fetch(videoUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/mp4,video/webm,video/*,*/*',
      },
    });

    if (!proxyRes.ok) {
      return res.status(proxyRes.status).json({ error: `Upstream returned ${proxyRes.status}` });
    }

    res.setHeader('Content-Type', proxyRes.headers.get('content-type') || 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const contentLength = proxyRes.headers.get('content-length');
    const contentRange = proxyRes.headers.get('content-range');

    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
      res.setHeader('Accept-Ranges', 'bytes');
    }

    const reader = proxyRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      if (!res.write(value)) {
        await new Promise(r => res.once('drain', r));
      }
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to fetch video: ' + err.message });
    }
  }
});

// ─────────────────────────────────────────────────────
// Google Drive integration
// ─────────────────────────────────────────────────────

const GDRIVE_CACHE_TTL = 3_600_000; // 1 hour
const gdriveCache = new Map();

function extractGDriveFileId(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/open\?id=([a-zA-Z0-9_-]+)/,
    /\/uc\?id=([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function isValidGDriveRedirect(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return PROXY_ALLOWED_HOSTS.some(
      host => parsed.hostname === host || parsed.hostname.endsWith('.' + host)
    );
  } catch {
    return false;
  }
}

function fetchGDriveConfirmedUrl(fileId) {
  return new Promise((resolve, reject) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return reject(new Error('Invalid file ID format'));
    }

    const get = (url, redirects = 0) => {
      if (redirects > 10) return reject(new Error('Too many redirects'));
      if (!isValidGDriveRedirect(url)) {
        return reject(new Error('Redirect to non-Google Drive host blocked'));
      }

      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      }, (resp) => {
        if ([301, 302, 303].includes(resp.statusCode)) {
          const next = resp.headers.location;
          resp.resume();
          const nextUrl = next.startsWith('http') ? next : new URL(next, url).href;
          return get(nextUrl, redirects + 1);
        }

        const ct = resp.headers['content-type'] || '';
        if (!ct.includes('text/html')) {
          resp.resume();
          return resolve({ url, contentType: ct, contentLength: resp.headers['content-length'] });
        }

        // Large file — parse confirmation page
        let body = '';
        resp.on('data', (c) => body += c);
        resp.on('end', () => {
          const uuidMatch = body.match(/name="uuid"\s+value="([^"]+)"/);
          const uuid = uuidMatch ? uuidMatch[1] : '';
          const confirmed = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t${uuid ? '&uuid=' + encodeURIComponent(uuid) : ''}`;
          resolve({ url: confirmed, contentType: null, contentLength: null });
        });
      }).on('error', reject);
    };

    get(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`);
  });
}

// Pre-resolve Google Drive URL
app.get('/gdrive/resolve', async (req, res) => {
  const fileId = req.query.id;
  if (!fileId) return res.status(400).json({ error: 'Missing id' });

  try {
    const cached = gdriveCache.get(fileId);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ ok: true, url: cached.url });
    }

    const result = await fetchGDriveConfirmedUrl(fileId);
    gdriveCache.set(fileId, { url: result.url, expiresAt: Date.now() + GDRIVE_CACHE_TTL });
    res.json({ ok: true, url: result.url });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Stream video from Google Drive
app.get('/gdrive', async (req, res) => {
  const fileId = req.query.id;
  if (!fileId) return res.status(400).json({ error: 'Missing id param' });

  try {
    let downloadUrl = null;
    const cached = gdriveCache.get(fileId);

    if (cached && cached.expiresAt > Date.now()) {
      downloadUrl = cached.url;
    } else {
      const result = await fetchGDriveConfirmedUrl(fileId);
      downloadUrl = result.url;
      gdriveCache.set(fileId, { url: downloadUrl, expiresAt: Date.now() + GDRIVE_CACHE_TTL });
    }

    const streamFromGDrive = (url, redirects = 0) => {
      if (redirects > 10) {
        if (!res.headersSent) return res.status(502).json({ error: 'Too many redirects' });
        return;
      }
      if (!isValidGDriveRedirect(url)) {
        if (!res.headersSent) return res.status(502).json({ error: 'Invalid redirect destination' });
        return;
      }

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'video/mp4,video/webm,video/*,*/*',
      };
      if (req.headers.range) headers['Range'] = req.headers.range;

      https.get(url, { headers }, (resp) => {
        if ([301, 302, 303].includes(resp.statusCode)) {
          const next = resp.headers.location;
          resp.resume();
          return streamFromGDrive(next.startsWith('http') ? next : new URL(next, url).href, redirects + 1);
        }

        if (resp.statusCode !== 200 && resp.statusCode !== 206) {
          if (!res.headersSent) return res.status(resp.statusCode).json({ error: `Google Drive returned ${resp.statusCode}` });
          return;
        }

        const contentType = resp.headers['content-type'] || 'video/mp4';
        if (contentType.includes('text/html')) {
          gdriveCache.delete(fileId);
          if (!res.headersSent) return res.status(502).json({ error: 'Session expired, retry in a moment' });
          return;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');

        const cl = resp.headers['content-length'];
        const cr = resp.headers['content-range'];
        if (cl) res.setHeader('Content-Length', cl);
        if (cr) {
          res.setHeader('Content-Range', cr);
          res.setHeader('Accept-Ranges', 'bytes');
        }
        if (resp.statusCode === 206) res.writeHead(206);
        resp.pipe(res);
      }).on('error', (err) => {
        if (!res.headersSent) res.status(502).json({ error: 'Stream error: ' + err.message });
      });
    };

    streamFromGDrive(downloadUrl);
  } catch (err) {
    console.error('GDRIVE error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Google Drive error: ' + err.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (max 2GB)' });
    }
    return res.status(400).json({ error: 'Upload error' });
  }
  if (err) return res.status(500).json({ error: 'Internal server error' });
  next();
});

// ─────────────────────────────────────────────────────
// Room state
// ─────────────────────────────────────────────────────

const rooms = new Map();
const socketRooms = new Map(); // socketId -> roomId

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

// ─────────────────────────────────────────────────────
// Socket.IO event handlers
// ─────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('User connected:', socket.id, '| transport:', socket.conn.transport.name);

  function getSocketRoomId() {
    return socketRooms.get(socket.id);
  }

  function socketRateLimit(event, max = 30, window = 60_000) {
    return checkRateLimit(`${socket.id}:${event}`, max, window);
  }

  function sanitize(str, maxLen = 50) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>"'&]/g, '').trim().slice(0, maxLen);
  }

  // ── Create room ──
  socket.on('create-room', ({ username, avatar }, callback) => {
    if (typeof callback !== 'function') return;
    if (!socketRateLimit('create-room', 5, 60_000)) {
      return callback({ error: 'Slow down! Try again in a minute.' });
    }
    if (rooms.size >= MAX_ROOMS) {
      return callback({ error: 'Server is at capacity. Try again later.' });
    }

    username = sanitize(username, 20);
    avatar = sanitize(avatar, 4);
    if (!username) return callback({ error: 'Name is required' });

    const roomId = generateRoomCode();
    const room = {
      id: roomId,
      host: socket.id,
      videoUrl: '',
      videoType: 'url',
      playing: false,
      currentTime: 0,
      participants: [],
      chat: [],
    };
    rooms.set(roomId, room);

    socket.join(roomId);
    socketRooms.set(socket.id, roomId);
    socket.data = { roomId, username, avatar };

    room.participants.push({ id: socket.id, username, avatar, isHost: true });

    callback({ roomId, room });
    io.to(roomId).emit('room-updated', room);
    console.log(`Room ${roomId} created by ${username}`);
  });

  // ── Join room ──
  socket.on('join-room', ({ roomId, username, avatar }, callback) => {
    if (typeof callback !== 'function') return;
    if (!socketRateLimit('join-room', 10, 60_000)) {
      return callback({ error: 'Slow down! Try again in a minute.' });
    }

    username = sanitize(username, 20);
    avatar = sanitize(avatar, 4);
    roomId = sanitize(roomId, 6).toUpperCase();
    if (!username) return callback({ error: 'Name is required' });
    if (!roomId || roomId.length < 4) return callback({ error: 'Invalid room code' });

    const room = getRoom(roomId);
    if (!room) return callback({ error: 'Room not found' });
    if (room.participants.length >= MAX_PARTICIPANTS_PER_ROOM) {
      return callback({ error: 'Room is full (max 10)' });
    }

    // Clean up stale entries from same username (reconnect scenario)
    const staleIdx = room.participants.findIndex(p => p.username === username && p.id !== socket.id);
    if (staleIdx !== -1) room.participants.splice(staleIdx, 1);

    // Don't add duplicate if same socket somehow joins twice
    if (room.participants.some(p => p.id === socket.id)) {
      return callback({ roomId, room });
    }

    socket.join(roomId);
    socketRooms.set(socket.id, roomId);
    socket.data = { roomId, username, avatar };

    room.participants.push({ id: socket.id, username, avatar, isHost: false });

    callback({ roomId, room });
    io.to(roomId).emit('room-updated', room);
    io.to(roomId).emit('chat-message', {
      username: 'System',
      avatar: '🎬',
      message: `${username} joined the party!`,
      timestamp: Date.now(),
    });

    // Sync new user to current playback state
    if (room.videoUrl && room.playing) {
      socket.emit('sync-play', { currentTime: room.currentTime });
    } else if (room.videoUrl) {
      socket.emit('sync-pause', { currentTime: room.currentTime });
    }

    console.log(`${username} joined room ${roomId}`);
  });

  // ── Set video ──
  socket.on('set-video', ({ videoUrl, videoType }) => {
    if (!socketRateLimit('set-video', 10, 60_000)) {
      return socket.emit('chat-message', {
        username: 'System', avatar: '⚠️',
        message: 'Video change rate limited.', timestamp: Date.now(),
      });
    }

    const roomId = getSocketRoomId();
    const room = getRoom(roomId);
    if (!room || room.host !== socket.id) return;

    // Validate video URL by type
    if (videoType === 'gdrive') {
      const fileId = extractGDriveFileId(videoUrl);
      if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
        return socket.emit('chat-message', {
          username: 'System', avatar: '⚠️',
          message: 'Invalid Google Drive link.', timestamp: Date.now(),
        });
      }
      videoUrl = `/gdrive?id=${fileId}`;
    } else if (videoType === 'youtube') {
      const videoId = videoUrl.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (!videoId) {
        return socket.emit('chat-message', {
          username: 'System', avatar: '⚠️',
          message: 'Invalid YouTube link.', timestamp: Date.now(),
        });
      }
    } else if (videoUrl && !videoUrl.startsWith('/uploads/')) {
      let parsed;
      try { parsed = new URL(videoUrl); } catch {
        return socket.emit('chat-message', {
          username: 'System', avatar: '⚠️',
          message: 'Invalid video URL.', timestamp: Date.now(),
        });
      }
      if (parsed.protocol !== 'https:' || !PROXY_ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
        return socket.emit('chat-message', {
          username: 'System', avatar: '⚠️',
          message: 'URL not allowed.', timestamp: Date.now(),
        });
      }
    }

    room.videoUrl = videoUrl;
    room.videoType = videoType || 'url';
    room.playing = false;
    room.currentTime = 0;

    io.to(room.id).emit('video-changed', { videoUrl, videoType });
    io.to(room.id).emit('room-updated', room);
  });

  // ── Playback controls ──
  socket.on('play', () => {
    const room = getRoom(getSocketRoomId());
    if (!room) return;
    room.playing = true;
    room.currentTime = room.currentTime || 0;
    socket.to(room.id).emit('sync-play', { currentTime: room.currentTime });
  });

  socket.on('pause', () => {
    const room = getRoom(getSocketRoomId());
    if (!room) return;
    room.playing = false;
    socket.to(room.id).emit('sync-pause', { currentTime: room.currentTime });
  });

  socket.on('seek', ({ currentTime }) => {
    const room = getRoom(getSocketRoomId());
    if (!room) return;
    room.currentTime = currentTime;
    socket.to(room.id).emit('sync-seek', { currentTime });
  });

  socket.on('time-update', ({ currentTime }) => {
    const room = getRoom(getSocketRoomId());
    if (!room) return;
    room.currentTime = currentTime;
  });

  // Drift correction — host broadcasts current time every 5s
  const driftInterval = setInterval(() => {
    const room = getRoom(getSocketRoomId());
    if (!room || room.host !== socket.id || !room.playing) return;
    io.to(room.id).emit('sync-time', { currentTime: room.currentTime });
  }, 5000);

  // ── WebRTC signaling ──
  socket.on('call-join', () => {
    const roomId = getSocketRoomId();
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;
    socket.to(roomId).emit('call-user-joined', { socketId: socket.id, username: socket.data?.username });
  });

  socket.on('call-offer', ({ to, offer }) => {
    io.to(to).emit('call-offer', { from: socket.id, offer });
  });

  socket.on('call-answer', ({ to, answer }) => {
    io.to(to).emit('call-answer', { from: socket.id, answer });
  });

  socket.on('call-ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('call-ice-candidate', { from: socket.id, candidate });
  });

  socket.on('call-leave', () => {
    const roomId = getSocketRoomId();
    if (!roomId) return;
    socket.to(roomId).emit('call-user-left', { socketId: socket.id });
  });

  // ── Chat ──
  socket.on('chat-message', ({ message }) => {
    if (!socketRateLimit('chat', 20, 30_000)) {
      return socket.emit('chat-message', {
        username: 'System', avatar: '⚠️',
        message: 'Slow down! Chat rate limit.', timestamp: Date.now(),
      });
    }

    const room = getRoom(getSocketRoomId());
    if (!room) return;

    message = sanitize(message, 500);
    if (!message) return;

    const chatMsg = {
      username: socket.data?.username || 'Anonymous',
      avatar: socket.data?.avatar || '🍿',
      message,
      timestamp: Date.now(),
    };
    room.chat.push(chatMsg);
    if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.shift();

    io.to(room.id).emit('chat-message', chatMsg);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    clearInterval(driftInterval);
    const roomId = getSocketRoomId();
    const room = getRoom(roomId);
    socketRooms.delete(socket.id);
    if (!room) return;

    const idx = room.participants.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const user = room.participants[idx];
    room.participants.splice(idx, 1);

    io.to(room.id).emit('chat-message', {
      username: 'System',
      avatar: '🎬',
      message: `${user.username} left the party`,
      timestamp: Date.now(),
    });

    if (room.participants.length === 0) {
      rooms.delete(room.id);
      console.log(`Room ${room.id} deleted (empty)`);
      return;
    }

    // Transfer host if needed
    if (room.host === socket.id) {
      room.host = room.participants[0].id;
      room.participants[0].isHost = true;
      io.to(room.id).emit('new-host', {
        hostId: room.host,
        username: room.participants[0].username,
      });
    }

    io.to(room.id).emit('room-updated', room);
    console.log('User disconnected:', socket.id);
  });
});

// ─────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────

const isHttps = fs.existsSync(keyFile) && fs.existsSync(certFile);
const protocol = isHttps ? 'https' : 'http';

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🎬 Movie Night server running:`);
  console.log(`  Local:    ${protocol}://localhost:${PORT}`);
  console.log(`  Network:  ${protocol}://${lanIp}:${PORT}`);
  if (isHttps) {
    console.log(`  (Browser may warn about self-signed cert — click Advanced > Proceed)`);
  }
  console.log();
});
