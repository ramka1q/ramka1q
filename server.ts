import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import http from "http";
import { Server } from "socket.io";

async function startServer() {
  const app = express();
  const PORT = 3000;

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB limit for audio files
  });

  const rooms: Record<string, { players: any[], beatmap: any, energyData: any, audioBuffer: Buffer | null, mimeType?: string, state: string }> = {};

  io.on("connection", (socket) => {
    console.log("A user connected", socket.id);

    socket.on("createRoom", ({ beatmap, energyData, audioBuffer, mimeType }) => {
      const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
      rooms[roomId] = { players: [{ id: socket.id, score: 0, combo: 0 }], beatmap, energyData, audioBuffer, mimeType, state: "waiting" };
      socket.join(roomId);
      socket.emit("roomCreated", roomId);
    });

    socket.on("joinRoom", (roomId) => {
      roomId = roomId.toUpperCase();
      if (rooms[roomId] && rooms[roomId].players.length < 2) {
        rooms[roomId].players.push({ id: socket.id, score: 0, combo: 0 });
        socket.join(roomId);
        socket.emit("roomJoined", { roomId, beatmap: rooms[roomId].beatmap, energyData: rooms[roomId].energyData, audioBuffer: rooms[roomId].audioBuffer, mimeType: rooms[roomId].mimeType });
        io.to(roomId).emit("playerJoined", rooms[roomId].players.length);
      } else {
        socket.emit("roomError", "Room not found or full");
      }
    });

    socket.on("playerReady", (roomId) => {
      if (rooms[roomId]) {
        rooms[roomId].state = "playing";
        io.to(roomId).emit("startGame", Date.now() + 4000);
      }
    });

    socket.on("updateScore", ({ roomId, score, combo, misses }) => {
      if (rooms[roomId]) {
        const player = rooms[roomId].players.find(p => p.id === socket.id);
        if (player) {
          player.score = score;
          player.combo = combo;
          socket.to(roomId).emit("opponentScore", { score, combo, misses });
        }
      }
    });

    socket.on("opponentHit", ({ roomId, lane }) => {
      socket.to(roomId).emit("opponentHit", { lane });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected", socket.id);
      for (const roomId in rooms) {
        const index = rooms[roomId].players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
          rooms[roomId].players.splice(index, 1);
          io.to(roomId).emit("playerLeft");
          if (rooms[roomId].players.length === 0) {
            delete rooms[roomId];
          }
        }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
