require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;

// 1. Configuração Robusta de CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,       // https://www.reidobaralho.com.br
  'http://localhost:5173',        // dev local (frontend Vite)
  'http://localhost:3001'         // dev local (backend)
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Permite requests sem origem (Postman, curl) e origens da lista
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Bloqueado: ${origin}`);
      callback(new Error('Bloqueado por CORS: Origem não permitida.'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// 2. Rota simples de Teste de Status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Motor do IceoLab online'
  });
});

// 3. Autenticação OAuth 2.0 — Facebook Graph API v19 (suporta escopos de negócio)
app.get('/api/auth/meta', (req, res) => {
  const metaAppId = process.env.META_APP_ID;
  const redirectUri = process.env.REDIRECT_URI;
  const scope = 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement';

  const authUrl =
    `https://www.facebook.com/v19.0/dialog/oauth` +
    `?client_id=${metaAppId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope}` +
    `&response_type=code`;

  console.log('[Auth] Redirecionando para:', authUrl);
  res.redirect(authUrl);
});

app.get('/api/auth/meta/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = process.env.REDIRECT_URI;
  
  if (!code) {
    return res.status(400).json({ error: 'Código de autorização não recebido.' });
  }

  try {
    const tokenResponse = await axios.post(`https://api.instagram.com/oauth/access_token`, new URLSearchParams({
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: code
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const accessToken = tokenResponse.data.access_token;
    console.log('Token recebido:', accessToken);

    res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=success`);
  } catch (error) {
    console.error('Erro na autenticação:', error.response ? error.response.data : error.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=error`);
  }
});

// 4. Inicialização do Servidor Central
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🚀 IceoLab Backend Operacional`);
  console.log(`🔌 Porta: ${PORT}`);
  console.log(`🛡️  CORS Limitado a: ${process.env.FRONTEND_URL || 'Nenhuma origem restrita (Verifique o .env)'}`);
  console.log(`========================================\n`);
});
