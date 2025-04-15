
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const app = express();

app.use(cors());
app.use(express.json());

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_CALLBACK_URL,
  TWITCH_USERNAME,
  TWITCH_REWARD_NAME,
  APP_ACCESS_TOKEN
} = process.env;

const allowedUsers = new Set();
let broadcasterId = null;

// ========= AUTH ==========

// Redirección a Twitch
app.get("/auth/login", (req, res) => {
  const scope = "channel:read:redemptions";
  const redirectUri = TWITCH_CALLBACK_URL;
  const authUrl = `https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=${TWITCH_CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}`;
  res.redirect(authUrl);
});

// Callback de Twitch tras login
app.get("/twitch/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const tokenRes = await axios.post(`https://id.twitch.tv/oauth2/token`, null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TWITCH_CALLBACK_URL
      }
    });

    const token = tokenRes.data.access_token;
    console.log("✅ Token de Twitch recibido");
    res.send("✅ Token de Twitch recibido. Ya puedes cerrar esta pestaña.");

  } catch (error) {
    console.error("❌ Error al obtener token de usuario:", error.response?.data || error.message);
    res.status(500).send("Error al obtener token de usuario");
  }
});

// ========= EVENTSUB & BACKEND ==========

async function getBroadcasterId() {
  const res = await axios.get("https://api.twitch.tv/helix/users", {
    headers: {
      "Client-ID": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${APP_ACCESS_TOKEN}`,
    },
    params: { login: TWITCH_USERNAME }
  });
  return res.data.data[0]?.id;
}

async function subscribeToEventSub(broadcasterId) {
  await axios.post("https://api.twitch.tv/helix/eventsub/subscriptions", {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: {
      broadcaster_user_id: broadcasterId,
      reward_title: TWITCH_REWARD_NAME
    },
    transport: {
      method: "webhook",
      callback: `${TWITCH_CALLBACK_URL}`,
      secret: "joanmiii-secret"
    }
  }, {
    headers: {
      "Client-ID": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${APP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

// Webhook de Twitch
app.post("/twitch/callback", express.json(), (req, res) => {
  const messageType = req.header("Twitch-Eventsub-Message-Type");

  if (messageType === "webhook_callback_verification") {
    return res.status(200).send(req.body.challenge);
  }

  if (messageType === "notification") {
    const event = req.body.event;
    const username = event.user_login.toLowerCase();
    if (event.reward.title === TWITCH_REWARD_NAME) {
      allowedUsers.add(username);
      console.log(`🎁 ${event.user_name} canjeó: ${event.reward.title}`);
    }
  }

  res.sendStatus(200);
});

// ========= API para el frontend =========

app.get("/api/allowed/:username", (req, res) => {
  const username = req.params.username.toLowerCase();
  res.json({ allowed: allowedUsers.has(username) });
});

app.post("/api/consume/:username", (req, res) => {
  const username = req.params.username.toLowerCase();
  allowedUsers.delete(username);
  res.sendStatus(200);
});

app.post("/api/fake-reward", (req, res) => {
  const { username } = req.body;
  allowedUsers.add(username.toLowerCase());
  res.json({ message: "Permiso otorgado manualmente" });
});

app.post("/api/tts-fakeyou", async (req, res) => {
  const { voice, message } = req.body;
  try {
    const session = await axios.post("https://api.fakeyou.com/tts/inference", {
      tts_model_token: voice,
      uuid_idempotency_token: Math.random().toString().substring(2),
      inference_text: message
    });

    const job = session.data.inference_job_token;
    let audioUrl = null;

    for (let i = 0; i < 20; i++) {
      const check = await axios.get(`https://api.fakeyou.com/tts/job/${job}`);
      if (check.data.state.status === "complete_success") {
        audioUrl = check.data.audio_url;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!audioUrl) return res.status(500).send("Audio no generado");

    const audio = await axios.get(audioUrl, { responseType: "arraybuffer" });
    res.set("Content-Type", "audio/mpeg");
    res.send(audio.data);
  } catch (err) {
    console.error("❌ Error en /tts-fakeyou:", err.message);
    res.status(500).send("Error generando audio");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`🟢 Servidor escuchando en http://localhost:${PORT}`);
  try {
    broadcasterId = await getBroadcasterId();
    await subscribeToEventSub(broadcasterId);
    console.log("🔔 Suscripción a recompensas activada");
  } catch (e) {
    console.error("❌ Error al configurar EventSub:", e.message);
  }
});
