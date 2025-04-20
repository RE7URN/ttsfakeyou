require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const http = require("http");
const { Server } = require("ws");
const app = express();

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_CALLBACK_URL,
  TWITCH_REWARD_NAME,
  APP_ACCESS_TOKEN,
  ELEVENLABS_API_KEY
} = process.env;

let userToken = "";
let userId = "";
let allowedUsers = new Set();
let lastTTSMessage = "";

// 🧠 WebSocket
const server = http.createServer(app);
const wss = new Server({ server });
let overlayClients = [];

wss.on("connection", (ws) => {
  console.log("🟢 Overlay conectado por WebSocket");
  overlayClients.push(ws);

  ws.on("close", () => {
    overlayClients = overlayClients.filter(client => client !== ws);
    console.log("🔴 Overlay desconectado");
  });
});

function broadcastOverlayMessage(text) {
  overlayClients.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      ws.send(text);
    }
  });
}

// 🧩 Middleware
const allowedOrigins = [
  "https://ttsjoanmiii.vercel.app",
  "https://ttsjoanmiii-nri0z0qdo-joan-miquels-projects-d1084b0e.vercel.app/"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
allowedUsers.add("joanmiii");

// 🔐 OAuth y rutas
app.get("/", (req, res) => res.send("TTS Backend is running!"));

app.get("/auth/login", (req, res) => {
  const redirectUri = TWITCH_CALLBACK_URL;
  const scope = "channel:read:redemptions";
  const authUrl = `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=${TWITCH_CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}`;
  res.redirect(authUrl);
});

app.get("/twitch/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("❌ Código no proporcionado.");

  try {
    const tokenResponse = await axios.post("https://id.twitch.tv/oauth2/token", null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TWITCH_CALLBACK_URL
      }
    });

    userToken = tokenResponse.data.access_token;

    const userRes = await axios.get("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${userToken}`
      }
    });

    userId = userRes.data.data[0].id;
    console.log("✅ Token de Twitch recibido");
    await subscribeToEventSub();
    res.send("✅ Token de Twitch recibido. Ya puedes cerrar esta pestaña.");
  } catch (err) {
    console.error("❌ Error al obtener token:", err.response?.data || err.message);
    res.send("❌ Error al obtener token de usuario");
  }
});

app.post("/twitch/callback", async (req, res) => {
  const type = req.header("Twitch-Eventsub-Message-Type");
  if (type === "webhook_callback_verification") return res.status(200).send(req.body.challenge);

  if (type === "notification") {
    const event = req.body.event;
    if (event.reward.title === TWITCH_REWARD_NAME) {
      console.log(`🎁 ${event.user_name} canjeó: ${event.reward.title}`);
      allowedUsers.add(event.user_name.toLowerCase());
    }
  }
  return res.status(200).end();
});

app.get("/api/allowed/:username", (req, res) => {
  const user = req.params.username.toLowerCase();
  res.json({ allowed: allowedUsers.has(user) });
});

app.post("/api/consume/:username", (req, res) => {
  const user = req.params.username.toLowerCase();
  if (allowedUsers.has(user)) {
    allowedUsers.delete(user);
    console.log(`🔒 Permiso consumido para: ${user}`);
    res.status(200).send({ message: "Permiso consumido" });
  } else {
    res.status(404).send({ error: "Usuario no autorizado o ya consumido" });
  }
});

app.get("/api/last-message", (req, res) => {
  res.json({ message: lastTTSMessage });
});

app.post("/api/tts", async (req, res) => {
  const { username, voice, message } = req.body;

  if (voice.startsWith("EL:")) {
    try {
      const response = await axios({
        method: "POST",
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voice.replace("EL:", "")}`,
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        data: {
          text: message,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        },
        responseType: "arraybuffer"
      });

      const audioBuffer = Buffer.from(response.data);
      const audioBase64 = audioBuffer.toString("base64");
      const audioUrl = `data:audio/mpeg;base64,${audioBase64}`;

      const payload = {
        text: `${username}: ${message}`,
        audioUrl
      };

      broadcastOverlayMessage(JSON.stringify(payload));
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audioBuffer);
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data || err.message;
      console.error("❌ Error TTS (ElevenLabs):", msg);
      res.status(status || 500).send(msg);
    }

  } else {
    res.status(400).send("Modelo de voz no reconocido o aún no implementado para audio en overlay");
  }
});


// 🔔 Suscribirse a eventos de Twitch
async function subscribeToEventSub() {
  try {
    await axios.post("https://api.twitch.tv/helix/eventsub/subscriptions", {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: {
        broadcaster_user_id: userId
      },
      transport: {
        method: "webhook",
        callback: TWITCH_CALLBACK_URL,
        secret: "joanmiiisecret"
      }
    }, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${APP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    console.log("🔔 Suscripción a recompensas activada");
  } catch (err) {
    console.error("❌ Error al suscribirse a EventSub:", err.response?.data || err.message);
  }
}

// 🔥 Escuchar en el puerto con WebSocket también
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🟢 Servidor escuchando en http://localhost:${PORT}`);
});
