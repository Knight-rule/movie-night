const socket = io();

// ===== CONNECTION STATUS =====
let lastRejoinTime = 0;
const REJOIN_DEBOUNCE = 3000; // min 3s between rejoin attempts

socket.on('disconnect', (reason) => {
  console.log('Socket disconnected:', reason);
  document.getElementById('conn-status').textContent = 'Disconnected — reconnecting...';
  document.getElementById('conn-status').style.background = '#c00';
  showToast('Disconnected — reconnecting...');
});

socket.on('connect', () => {
  console.log('Socket connected:', socket.id);
  document.getElementById('conn-status').textContent = 'Connected ✓';
  document.getElementById('conn-status').style.background = '#2a7d2a';
  // If we were in a room, rejoin on reconnect
  if (currentRoomId) {
    const now = Date.now();
    if (now - lastRejoinTime < REJOIN_DEBOUNCE) return;
    lastRejoinTime = now;

    const username = localStorage.getItem('movienight-username');
    if (username) {
      socket.emit('join-room', { roomId: currentRoomId, username, avatar: selectedAvatar }, (res) => {
        if (res.error) {
          showToast('Rejoin failed — ' + res.error);
        }
      });
    }
  }
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  document.getElementById('conn-status').textContent = 'Error: ' + err.message;
  document.getElementById('conn-status').style.background = '#c00';
});

// ===== DOM ELEMENTS =====
const homeScreen = document.getElementById('home-screen');
const roomScreen = document.getElementById('room-screen');
const createUsername = document.getElementById('create-username');
const joinUsername = document.getElementById('join-username');
const roomCodeInput = document.getElementById('room-code');
const createBtn = document.getElementById('create-btn');
const joinBtn = document.getElementById('join-btn');
const displayRoomCode = document.getElementById('display-room-code');
const copyCodeBtn = document.getElementById('copy-code-btn');
const leaveBtn = document.getElementById('leave-btn');
const videoSetter = document.getElementById('video-setter');
const videoPlayerContainer = document.getElementById('video-player-container');
const videoPlayer = document.getElementById('video-player');
const playbackControls = document.getElementById('playback-controls');
const videoType = document.getElementById('video-type');
const videoUrlInput = document.getElementById('video-url-input');
const loadVideoBtn = document.getElementById('load-video-btn');
const syncBtn = document.getElementById('sync-btn');
const timeDisplay = document.getElementById('time-display');
const syncIndicator = document.getElementById('sync-indicator');
const participantsList = document.getElementById('participants-list');
const participantCount = document.getElementById('participant-count');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const toast = document.getElementById('toast');
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const uploadFilename = document.getElementById('upload-filename');
const gdriveUrlInput = document.getElementById('gdrive-url-input');
const loadGdriveBtn = document.getElementById('load-gdrive-btn');

let selectedAvatar = '🍿';
let isHost = false;
let currentRoomId = null;
let syncTimeout = null;
let isSyncing = false; // Prevent feedback loop during sync

// ===== TOAST =====
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ===== AVATAR PICKER =====
document.querySelectorAll('.avatar-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.avatar-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedAvatar = btn.dataset.avatar;
  });
});

// ===== TABS =====
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ===== FILE UPLOAD =====
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
});

function uploadFile(file) {
  if (!file.type.startsWith('video/')) return showToast('Please select a video file');

  const formData = new FormData();
  formData.append('video', file);

  const xhr = new XMLHttpRequest();
  uploadProgress.style.display = 'block';
  uploadFilename.style.display = 'none';

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = pct + '%';
      progressText.textContent = `Uploading... ${pct}%`;
    }
  });

  xhr.addEventListener('load', () => {
    uploadProgress.style.display = 'none';
    if (xhr.status === 200) {
      const res = JSON.parse(xhr.responseText);
      uploadFilename.textContent = file.name;
      uploadFilename.style.display = 'flex';
      socket.emit('set-video', { videoUrl: res.url, videoType: 'url' });
      showToast('Movie uploaded!');
    } else {
      showToast('Upload failed');
    }
  });

  xhr.addEventListener('error', () => {
    uploadProgress.style.display = 'none';
    showToast('Upload failed');
  });

  xhr.open('POST', '/upload');
  xhr.send(formData);
}

// ===== FORMAT TIME =====
function formatTime(seconds) {
  if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== CREATE ROOM =====
createBtn.addEventListener('click', () => {
  const username = createUsername.value.trim();
  if (!username) return showToast('Enter your name');
  if (!socket.connected) return showToast('Not connected to server — wait or refresh');

  console.log('[DEBUG] Create button clicked, socket.connected:', socket.connected, 'socket.id:', socket.id);
  createBtn.disabled = true;
  createBtn.textContent = 'Creating...';

  const timeout = setTimeout(() => {
    createBtn.disabled = false;
    createBtn.textContent = 'Create Room';
    showToast('Connection timeout — try again');
  }, 10000);

  socket.emit('create-room', { username, avatar: selectedAvatar }, (res) => {
    console.log('[DEBUG] create-room callback:', res);
    clearTimeout(timeout);
    createBtn.disabled = false;
    createBtn.textContent = 'Create Room';
    if (res.error) return showToast(res.error);
    localStorage.setItem('movienight-username', username);
    enterRoom(res.roomId, res.room, true);
  });
});

// ===== JOIN ROOM =====
joinBtn.addEventListener('click', () => {
  const username = joinUsername.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!username) return showToast('Enter your name');
  if (!code || code.length < 4) return showToast('Enter a valid room code');
  if (!socket.connected) return showToast('Not connected to server — wait or refresh');

  console.log('[DEBUG] Join button clicked, socket.connected:', socket.connected, 'socket.id:', socket.id);
  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining...';

  const timeout = setTimeout(() => {
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Room';
    showToast('Connection timeout — try again');
  }, 10000);

  socket.emit('join-room', { roomId: code, username, avatar: selectedAvatar }, (res) => {
    console.log('[DEBUG] join-room callback:', res);
    clearTimeout(timeout);
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Room';
    if (res.error) return showToast(res.error);
    localStorage.setItem('movienight-username', username);
    enterRoom(res.roomId, res.room, false);
  });
});

// ===== ENTER ROOM =====
function enterRoom(roomId, room, amHost) {
  currentRoomId = roomId;
  isHost = amHost;

  homeScreen.classList.remove('active');
  roomScreen.classList.add('active');
  displayRoomCode.textContent = roomId;

  updateParticipants(room.participants);

  if (room.videoUrl) {
    loadVideo(room.videoUrl, room.videoType);
  }

  room.chat.forEach(msg => appendChat(msg));
}

// ===== LEAVE =====
leaveBtn.addEventListener('click', () => {
  location.reload();
});

// ===== COPY ROOM CODE =====
copyCodeBtn.addEventListener('click', () => {
  const host = window.location.hostname;
  const port = window.location.port ? `:${window.location.port}` : '';
  const link = `${window.location.protocol}//${host}${port}?room=${currentRoomId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Invite link copied!');
  }).catch(() => {
    showToast('Link: ' + link);
  });
});

// ===== LOAD VIDEO =====
loadVideoBtn.addEventListener('click', () => {
  const url = videoUrlInput.value.trim();
  if (!url) return showToast('Enter a video URL');
  socket.emit('set-video', { videoUrl: url, videoType: videoType.value });
});

// ===== GOOGLE DRIVE =====
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

loadGdriveBtn.addEventListener('click', () => {
  if (!currentRoomId) return showToast('Create or join a room first!');
  const url = gdriveUrlInput.value.trim();
  if (!url) return showToast('Paste a Google Drive link');

  const fileId = extractGDriveFileId(url);
  if (!fileId) return showToast('Invalid Google Drive link');

  loadGdriveBtn.disabled = true;
  loadGdriveBtn.textContent = 'Resolving...';

  // Pre-resolve the Google Drive URL in background
  fetch(`/gdrive/resolve?id=${fileId}`)
    .then(r => r.json())
    .then(() => {
      socket.emit('set-video', { videoUrl: `/gdrive?id=${fileId}`, videoType: 'gdrive' });
    })
    .catch(() => {
      // Still try even if pre-resolve fails (it might work on /gdrive directly)
      socket.emit('set-video', { videoUrl: `/gdrive?id=${fileId}`, videoType: 'gdrive' });
    })
    .finally(() => {
      loadGdriveBtn.disabled = false;
      loadGdriveBtn.textContent = 'Play';
    });
});

// ===== VIDEO PLAYER LOGIC =====
let videoEventsSetup = false;

function loadVideo(url, type) {
  videoSetter.style.display = 'none';
  videoPlayerContainer.style.display = 'flex';
  playbackControls.style.display = 'flex';
  videoPlayer.style.display = 'block';
  
  if (type === 'youtube') {
    loadYouTube(url);
  } else {
    let streamUrl;
    if (type === 'gdrive') {
      streamUrl = url;
    } else {
      const isLocal = url.startsWith('/uploads/');
      streamUrl = isLocal ? url : `/proxy?url=${encodeURIComponent(url)}`;
    }
    console.log('Loading video:', streamUrl);
    videoPlayer.src = streamUrl;
    videoPlayer.load();
    if (!videoEventsSetup) {
      setupVideoEvents();
      videoEventsSetup = true;
    }
  }
}

function setupVideoEvents() {
  videoPlayer.removeEventListener('play', onPlay);
  videoPlayer.removeEventListener('pause', onPause);
  videoPlayer.removeEventListener('seeked', onSeeked);
  videoPlayer.removeEventListener('timeupdate', onTimeUpdate);

  videoPlayer.addEventListener('play', onPlay);
  videoPlayer.addEventListener('pause', onPause);
  videoPlayer.addEventListener('seeked', onSeeked);
  videoPlayer.addEventListener('timeupdate', onTimeUpdate);
}

function onPlay() {
  if (!isHost || isSyncing) return;
  socket.emit('play');
}

function onPause() {
  if (!isHost || isSyncing) return;
  socket.emit('pause');
}

function onSeeked() {
  if (!isHost || isSyncing) return;
  socket.emit('seek', { currentTime: videoPlayer.currentTime });
}

let lastTimeUpdateSent = 0;
function onTimeUpdate() {
  timeDisplay.textContent = `${formatTime(videoPlayer.currentTime)} / ${formatTime(videoPlayer.duration)}`;
  if (isHost) {
    const now = Date.now();
    if (now - lastTimeUpdateSent >= 1000) {
      lastTimeUpdateSent = now;
      socket.emit('time-update', { currentTime: videoPlayer.currentTime });
    }
  }
}

function loadYouTube(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) return showToast('Invalid YouTube URL');

  videoPlayer.style.display = 'none';
  const ytContainer = document.getElementById('youtube-player');
  ytContainer.style.display = 'block';
  ytContainer.textContent = '';
  const iframe = document.createElement('iframe');
  iframe.width = '100%';
  iframe.height = '100%';
  iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`;
  iframe.setAttribute('frameborder', '0');
  iframe.allow = 'autoplay; encrypted-media';
  iframe.allowFullscreen = true;
  ytContainer.appendChild(iframe);
}

function extractYouTubeId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// ===== SYNC CONTROLS =====
syncBtn.addEventListener('click', () => {
  if (!isHost) return showToast('Only the host can sync');
  socket.emit('seek', { currentTime: videoPlayer.currentTime });
  socket.emit('play');
  showToast('Synced everyone!');
});

// ===== SOCKET EVENTS =====
socket.on('room-updated', (room) => {
  updateParticipants(room.participants);
  const me = room.participants.find(p => p.id === socket.id);
  if (me) isHost = me.isHost;
});

socket.on('video-changed', ({ videoUrl, videoType: type }) => {
  loadVideo(videoUrl, type);
  showToast('New video loaded!');
});

function showSyncIndicator(msg) {
  if (!syncIndicator) return;
  syncIndicator.textContent = msg || '✓ Synced';
  syncIndicator.style.display = 'block';
  syncIndicator.style.animation = 'none';
  syncIndicator.offsetHeight; // trigger reflow
  syncIndicator.style.animation = 'fadeSync 2s ease forwards';
}

socket.on('sync-play', ({ currentTime }) => {
  if (videoPlayer) {
    isSyncing = true;
    const drift = Math.abs(videoPlayer.currentTime - currentTime);
    if (drift > 2) {
      videoPlayer.currentTime = currentTime;
    }
    videoPlayer.play().then(() => {
      if (!isHost) showSyncIndicator('✓ Synced');
    }).catch(() => {
      showSyncIndicator('Click play to sync');
    });
    setTimeout(() => { isSyncing = false; }, 200);
  }
});

socket.on('sync-pause', ({ currentTime }) => {
  if (videoPlayer) {
    isSyncing = true;
    const drift = Math.abs(videoPlayer.currentTime - currentTime);
    if (drift > 2) {
      videoPlayer.currentTime = currentTime;
    }
    videoPlayer.pause();
    if (!isHost) showSyncIndicator('✓ Synced');
    setTimeout(() => { isSyncing = false; }, 100);
  }
});

socket.on('sync-seek', ({ currentTime }) => {
  if (videoPlayer) {
    isSyncing = true;
    videoPlayer.currentTime = currentTime;
    if (!isHost) showSyncIndicator('✓ Synced');
    setTimeout(() => { isSyncing = false; }, 100);
  }
});

socket.on('sync-time', ({ currentTime }) => {
  if (videoPlayer && !isHost) {
    const drift = Math.abs(videoPlayer.currentTime - currentTime);
    if (drift > 3) {
      isSyncing = true;
      videoPlayer.currentTime = currentTime;
      showSyncIndicator('✓ Corrected');
      setTimeout(() => { isSyncing = false; }, 100);
    }
  }
});

socket.on('new-host', ({ username }) => {
  showToast(`${username} is now the host`);
});

socket.on('chat-message', (msg) => {
  appendChat(msg);
});

// ===== PARTICIPANTS =====
function updateParticipants(participants) {
  participantCount.textContent = participants.length;
  participantsList.innerHTML = '';
  participants.forEach(p => {
    const li = document.createElement('li');
    li.className = 'participant-item';
    li.setAttribute('data-socket-id', p.id);

    const avatarSpan = document.createElement('span');
    avatarSpan.className = 'avatar';
    avatarSpan.textContent = p.avatar;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = p.username + (p.id === socket.id ? ' (you)' : '');

    li.appendChild(avatarSpan);
    li.appendChild(nameSpan);

    if (p.isHost) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }

    participantsList.appendChild(li);
  });
}

// ===== CHAT =====
function appendChat(msg) {
  const isSystem = msg.username === 'System';
  const div = document.createElement('div');
  div.className = `chat-msg${isSystem ? ' system' : ''}`;

  if (isSystem) {
    div.textContent = msg.message;
  } else {
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const header = document.createElement('div');
    header.className = 'chat-header';

    const avatarSpan = document.createElement('span');
    avatarSpan.className = 'chat-avatar';
    avatarSpan.textContent = msg.avatar;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = msg.username;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = time;

    header.appendChild(avatarSpan);
    header.appendChild(nameSpan);
    header.appendChild(timeSpan);

    const textDiv = document.createElement('div');
    textDiv.className = 'chat-text';
    textDiv.textContent = msg.message;

    div.appendChild(header);
    div.appendChild(textDiv);
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

sendChatBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat-message', { message: msg });
  chatInput.value = '';
}

// ===== AUTO-JOIN FROM URL =====
const urlParams = new URLSearchParams(window.location.search);
const autoRoom = urlParams.get('room');
if (autoRoom) {
  roomCodeInput.value = autoRoom;
  // If we have a stored username, auto-join immediately
  const storedName = localStorage.getItem('movienight-username');
  if (storedName) {
    joinUsername.value = storedName;
    joinBtn.click();
  } else {
    joinUsername.focus();
    showToast('Enter your name to join');
  }
}

// ===== WEBRTC VIDEO CALL =====
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

let localStream = null;
let callActive = false;
const peers = new Map(); // socketId -> { pc, username }

const localVideoWrap = document.getElementById('local-video-wrap');
const localVideo = document.getElementById('local-video');
const remoteVideos = document.getElementById('remote-videos');
const camToggle = document.getElementById('cam-toggle');
const micToggle = document.getElementById('mic-toggle');

camToggle.addEventListener('click', toggleCamera);
micToggle.addEventListener('click', toggleMic);

async function toggleCamera() {
  if (callActive) {
    stopCall();
  } else {
    await startCall();
  }
}

async function startCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localVideoWrap.style.display = 'block';
    camToggle.classList.add('active');
    micToggle.classList.add('active');
    callActive = true;

    // Announce to room
    socket.emit('call-join');

    showToast('Camera on!');
  } catch (err) {
    console.error('Camera error:', err);
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      showToast('Camera requires HTTPS — access via https://');
    } else {
      showToast('Camera/mic access denied');
    }
  }
}

function stopCall() {
  callActive = false;

  // Close all peer connections
  peers.forEach((peer, id) => {
    if (peer.pc) peer.pc.close();
    removeRemoteVideo(id);
  });
  peers.clear();

  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  localVideo.srcObject = null;
  localVideoWrap.style.display = 'none';
  camToggle.classList.remove('active');
  micToggle.classList.remove('active');

  socket.emit('call-leave');
  showToast('Camera off');
}

function toggleMic() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  micToggle.textContent = audioTrack.enabled ? '🎤' : '🔇';
  micToggle.classList.toggle('muted', !audioTrack.enabled);
}

function createPeerConnection(remoteSocketId, remoteUsername, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // Handle remote stream
  pc.ontrack = (event) => {
    let wrap = document.getElementById(`remote-${remoteSocketId}`);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = `remote-${remoteSocketId}`;
      wrap.className = 'remote-video-wrap';

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;

      const label = document.createElement('span');
      label.className = 'remote-video-label';
      label.textContent = remoteUsername;

      wrap.appendChild(video);
      wrap.appendChild(label);
      remoteVideos.appendChild(wrap);
    }
    const video = wrap.querySelector('video');
    if (event.streams[0]) {
      video.srcObject = event.streams[0];
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('call-ice-candidate', { to: remoteSocketId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      removeRemoteVideo(remoteSocketId);
      peers.delete(remoteSocketId);
    }
  };

  const peerData = { pc, username: remoteUsername };
  peers.set(remoteSocketId, peerData);

  if (isInitiator) {
    createAndSendOffer(remoteSocketId, pc);
  }

  return pc;
}

async function createAndSendOffer(remoteSocketId, pc) {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call-offer', { to: remoteSocketId, offer: pc.localDescription });
  } catch (err) {
    console.error('Offer error:', err);
  }
}

function removeRemoteVideo(socketId) {
  const el = document.getElementById(`remote-${socketId}`);
  if (el) el.remove();
}

// ===== SOCKET EVENTS FOR VIDEO CALL =====
socket.on('call-user-joined', ({ socketId, username }) => {
  if (!callActive) return;
  if (!peers.has(socketId)) {
    createPeerConnection(socketId, username, true);
  }
});

socket.on('call-offer', async ({ from, offer }) => {
  if (!callActive) return;
  let peer = peers.get(from);
  let pc;
  if (!peer) {
    const participantEl = document.querySelector(`[data-socket-id="${from}"] .name`);
    const username = participantEl ? participantEl.textContent.replace(' (you)', '') : 'Friend';
    pc = createPeerConnection(from, username, false);
  } else {
    pc = peer.pc;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call-answer', { to: from, answer: pc.localDescription });
  } catch (err) {
    console.error('Answer error:', err);
  }
});

socket.on('call-answer', async ({ from, answer }) => {
  const peer = peers.get(from);
  if (!peer) return;
  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error('Set answer error:', err);
  }
});

socket.on('call-ice-candidate', async ({ from, candidate }) => {
  const peer = peers.get(from);
  if (!peer) return;
  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('ICE error:', err);
  }
});

socket.on('call-user-left', ({ socketId }) => {
  removeRemoteVideo(socketId);
  const peer = peers.get(socketId);
  if (peer) {
    peer.pc.close();
    peers.delete(socketId);
  }
});
