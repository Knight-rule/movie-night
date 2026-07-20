# 🎬 Movie Night - Watch Together

Watch movies online with friends in real-time sync! Create a room, invite friends with a code, and enjoy synchronized playback with live chat.

## Features

- **Real-time Sync** - Video playback stays synced across all viewers
- **Room System** - Create or join rooms with 6-character codes
- **Live Chat** - Chat with friends while watching
- **Multi-source** - Supports MP4, WebM, YouTube, and browser-supported video formats
- **Host Controls** - Room host can load videos and sync everyone
- **Avatar System** - Choose an avatar to represent yourself
- **Up to 10 Users** per room

## Quick Start

### 1. Install Dependencies
```bash
cd MovieNight
npm install
```

### 2. Start the Server
```bash
npm start
```

### 3. Open in Browser
Go to **http://localhost:3000**

## How to Use

1. **Create a Room** - Enter your name, pick an avatar, click "Create Room"
2. **Share the Code** - Copy the room code and send it to friends
3. **Friends Join** - They enter the code and their name to join
4. **Pick a Video** - Host pastes a video URL and clicks "Load"
5. **Watch Together** - Everyone's playback stays in sync!
6. **Chat** - Use the chat sidebar to talk during the movie

## Supported Video Formats

- Direct video URLs (MP4, WebM, OGG)
- YouTube links
- Any URL that works in an HTML5 video player

## Tech Stack

- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: HTML + CSS + JavaScript
- **Real-time**: WebSocket (Socket.IO)

## Invite Friends

Copy the invite link from the room and share it - friends will be pre-filled with the room code!

```
http://localhost:3000?room=ABC123
```
