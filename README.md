# FNF X-Creator

FNF X-Creator is a browser rhythm game that builds an adaptive beatmap from an audio or video file. Video files are used solely as audio sources and are never displayed. Audio analysis runs locally in the browser using Web Audio energy and peak detection; it does not use an AI service or require an API key.

You can play a generated or imported JSON beatmap in single-player mode, or create a two-player room backed by Socket.IO. Any player can create and host a room. The host chooses the audio or video, and the server relays the synchronized audio source and beatmap to the friend automatically.

Optional **Experimental events** add animated lane swaps and screen-wide arrow flights when a quiet break follows a louder section. They are visual only, do not change note timing or judgement, and can be disabled before starting or joining a game.

## Requirements

- Node.js 24 LTS
- npm

## Run locally

```sh
npm ci
npm run dev
```

The app is served at `http://localhost:3000` by default. Set `PORT` and `APP_ORIGIN` in the process environment when a different port or public origin is required; [.env.example](.env.example) documents both values.

## Play online with a friend

Both players use the same public Node/Socket.IO app URL; a `localhost` link cannot be opened by a friend on another device.

1. The host opens the public app, chooses an audio or video file, and creates a multiplayer room.
2. The host copies and sends the generated invite link.
3. The friend opens the link and clicks **Join & enable sound**. No audio or video file is needed on the friend's device.
4. The shared audio source downloads from the room server, then the game starts for both players in sync. When the host selects a video, both players hear its extracted audio; the video is never displayed.

## Deploy free on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ramka1q/ramka1q)

Deploy this repository as one Node web service so the built browser app and Socket.IO server share a single public URL. Open the generated `onrender.com` address, create a room, and send its invite link to your friend.

Render's free service can sleep while idle, so the first request after a pause may take longer. Rooms are held only in server memory and disappear when the service sleeps, restarts, or redeploys; create a new room afterward.

## Quality and production commands

```sh
npm run typecheck
npm test
npm run build
npm start
```

`npm run check` runs type checking, tests, and a production build. The build keeps browser assets in `dist/client` and the Node server bundle in `dist/server`.

## Multiplayer limits

Local audio and video files are limited to 100 MiB and 25 minutes. Audio files are optimized before multiplayer upload to mono 32 kHz PCM WAV. Video files up to 32 MiB can be relayed in their original container solely so the guest can extract the same audio; larger videos send synchronized optimized audio instead. If a video's audio track cannot be decoded or extracted, the app reports an error instead of starting silent gameplay. A relayed track is limited to 32 MiB per room, which is approximately 8 minutes 44 seconds for optimized audio. The server reserves at most 256 MiB for active room media, beatmaps, indexes, and energy data. Rooms expire after 30 minutes of inactivity (or shortly after a game ends) and are lost when the server restarts.

A room works only on the server instance that created it. Production horizontal scaling therefore requires shared room storage and a Socket.IO adapter. Set `APP_ORIGIN` to the exact public browser origin when the Socket.IO endpoint is exposed through a proxy or custom domain. Admission limits use the direct socket address by default. Set `TRUST_PROXY=true` only when a trusted reverse proxy overwrites `X-Forwarded-For` and direct access to Node is blocked; otherwise forwarded addresses can be spoofed. Without that opt-in, proxied users share one server-side address bucket.

Multiplayer is intended for casual play: the server validates membership, unique note IDs, hit timing, monotonic score snapshots, replay sequence numbers, and score ceilings derived from accepted notes. It still does not run a fully authoritative replay of every physical input.
