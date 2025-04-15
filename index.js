require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const app = express();

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_USERNAME,
  TWITCH_CALLBACK_URL,
  TWITCH_REWARD_NAME,
  APP_ACCESS_TOKEN
} = process.env;

let userToken = "";
let userId = "";
let allowedUsers = new Set();

// CORS para Vercel
app.use(cors({
  origin: "https://tts-project-joanmiii.vercel.app"
}));

// JSON parser con verificación opcional
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));

app.get("/", (req, res) => {
  res.send("TTS Backend is running!");
});

app.get("/auth/login", (req, res) => {
  const redirectUri = TWITCH_CALLBACK_URL;
  const scope = "channel:read:redemptions";
  const authUrl = \`https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=\${TWITCH_CLIENT_ID}&redirect_uri=\${redirectUri}&scope=\${scope}\`;
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
        "Authorization": \`Bearer \${userToken}\`
      }
    });

    userId = userRes.data.data[0].id;

    console.log("✅ Token de Twitch recibido");
    await subscribeToEventSub();
    res.send("✅ Token de Twitch recibido. Ya puedes cerrar esta pestaña.");
  } catch (err) {
    console.error("❌ Error al obtener token de usuario:", err.response?.data || err.message);
    res.send("❌ Error al obtener token de usuario");
  }
});

// CORREGIDO: Añadir JSON parser específico a esta ruta
app.post("/twitch/callback", express.json(), async (req, res) => {
  const type = req.header("Twitch-Eventsub-Message-Type");

  if (type === "webhook_callback_verification") {
    return res.status(200).send(req.body.challenge);
  }

  if (type === "notification") {
    const event = req.body.event;
    console.log("🔔 Evento recibido:", event);

    if (event.reward.title === TWITCH_REWARD_NAME) {
      console.log(\`🎁 \${event.user_name} canjeó: \${event.reward.title}\`);
      allowedUsers.add(event.user_name.toLowerCase());
    }

    return res.status(200).end();
  }

  return res.status(200).end();
});

app.get("/api/allowed/:username", (req, res) => {
  const user = req.params.username.toLowerCase();
  res.json({ allowed: allowedUsers.has(user) });
});

app.post("/api/tts-fakeyou", async (req, res) => {
  const { voice, message } = req.body;

  try {
    const gen = await axios.post("https://api.fakeyou.com/tts/inference", {
      tts_model_token: voice,
      inference_text: message
    });

    const jobToken = gen.data.inference_job_token;

    let audioUrl = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const status = await axios.get(\`https://api.fakeyou.com/tts/job/\${jobToken}\`);
      if (status.data.state.status === "complete_success") {
        audioUrl = status.data.state.maybe_public_bucket_wav_audio_path;
        break;
      }
    }

    if (audioUrl) {
      const audioStream = await axios.get("https://storage.googleapis.com" + audioUrl, { responseType: "stream" });
      res.setHeader("Content-Type", "audio/wav");
      return audioStream.data.pipe(res);
    } else {
      return res.status(408).send("Tiempo de espera agotado.");
    }
  } catch (err) {
    console.error("❌ Error TTS:", err.response?.data || err.message);
    res.status(500).send("Error generando voz");
  }
});

async function subscribeToEventSub() {
  try {
    const response = await axios.post("https://api.twitch.tv/helix/eventsub/subscriptions", {
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
        "Authorization": \`Bearer \${APP_ACCESS_TOKEN}\`,
        "Content-Type": "application/json"
      }
    });

    console.log("🔔 Suscripción a recompensas activada");
  } catch (err) {
    console.error("❌ Error al configurar EventSub:", err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(\`🟢 Servidor escuchando en http://localhost:\${PORT}\`);
});