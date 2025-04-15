
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const allowedUsers = new Set();

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_CALLBACK_URL,
  TWITCH_REWARD_NAME,
  APP_ACCESS_TOKEN
} = process.env;

let broadcasterId = null;
let rewardId = null;

// Obtener broadcaster ID al iniciar
async function getBroadcasterId() {
  const user = await axios.get("https://api.twitch.tv/helix/users", {
    headers: {
      "Client-ID": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${APP_ACCESS_TOKEN}`,
    },
    params: { login: process.env.TWITCH_USERNAME }
  });
  return user.data.data[0]?.id;
}

// Crear suscripción a canje de recompensa
async function createEventSubSubscription(broadcasterId) {
  await axios.post("https://api.twitch.tv/helix/eventsub/subscriptions", {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: {
      broadcaster_user_id: broadcasterId,
      reward_title: TWITCH_REWARD_NAME
    },
    transport: {
      method: "webhook",
      callback: `${process.env.TWITCH_CALLBACK_URL}`,
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
app.post("/twitch/callback", (req, res) => {
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

// Endpoints frontend
app.get("/api/allowed/:username", (req, res) => {
  const username = req.params.username.toLowerCase();
  res.json({ allowed: allowedUsers.has(username) });
});

app.post("/api/consume/:username", (req, res) => {
  const username = req.params.username.toLowerCase();
  allowedUsers.delete(username);
  res.sendStatus(200);
});

// Endpoint para usar sin Twitch (test manual)
app.post("/api/fake-reward", (req, res) => {
  const { username } = req.body;
  allowedUsers.add(username.toLowerCase());
  res.json({ message: "Permiso otorgado manualmente" });
});

// TTS de FakeYou
app.post("/api/tts-fakeyou", async (req, res) => {
  const { voice, message } = req.body;
  try {
    const sessionResp = await axios.post("https://api.fakeyou.com/tts/inference", {
      tts_model_token: voice,
      uuid_idempotency_token: Math.random().toString().substring(2),
      inference_text: message
    }, {
      headers: {
        "Content-Type": "application/json"
      }
    });

    const jobToken = sessionResp.data.inference_job_token;
    let audioUrl = null;

    for (let i = 0; i < 20; i++) {
      const check = await axios.get(`https://api.fakeyou.com/tts/job/${jobToken}`);
      if (check.data.state.status === "complete_success") {
        audioUrl = check.data.audio_url;
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!audioUrl) return res.status(500).send("Audio no generado");

    const audioResp = await axios.get(audioUrl, { responseType: "arraybuffer" });
    res.set("Content-Type", "audio/mpeg");
    res.send(audioResp.data);
  } catch (err) {
    console.error("❌ Error en /tts-fakeyou:", err.message);
    res.status(500).send("Error generando audio");
  }
});

// Iniciar servidor y suscribir al evento
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🟢 Servidor escuchando en http://localhost:${PORT}`);
  try {
    broadcasterId = await getBroadcasterId();
    await createEventSubSubscription(broadcasterId);
    console.log("🔔 Suscripción a recompensas activada");
  } catch (e) {
    console.error("❌ Error al configurar EventSub:", e.message);
  }
});
