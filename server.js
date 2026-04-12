// Versão: 1.0.4 - Integração Supabase (salvar e listar contas Instagram)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Inicializa o cliente Supabase com a service_role key (acesso total, só no backend)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 1. Configuração Robusta de CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,       // https://www.reidobaralho.com.br
  'http://localhost:5173',        // dev local (frontend Vite)
  'http://localhost:3000',        // dev local (alternativo)
  'http://localhost:3001'         // dev local (backend)
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
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

// 2. Rota de Teste de Status
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', message: 'Motor do IceoLab online v1.0.4' });
});

// 3. Autenticação OAuth 2.0 — Instagram Business API
app.get('/api/auth/meta', (req, res) => {
  const authUrl = 'https://api.instagram.com/oauth/authorize?client_id=828166929780571&redirect_uri=https://iceolab-backend.onrender.com/api/auth/meta/callback&scope=instagram_business_basic,instagram_business_manage_messages&response_type=code';

  console.log('[Auth] Redirecionando para:', authUrl);
  res.redirect(authUrl);
});

// 4. Callback — Troca o code pelo token, busca o perfil e salva no Supabase
app.get('/api/auth/meta/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = process.env.REDIRECT_URI;

  if (!code) {
    console.error('[Callback] Código de autorização ausente.');
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=error&reason=no_code`);
  }

  try {
    // Passo 1: Troca o code pelo access_token de curta duração
    const tokenResponse = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, user_id } = tokenResponse.data;
    console.log('[Callback] Token recebido para user_id:', user_id);

    // Passo 2: Busca o username e profile_picture_url na Graph API
    const profileResponse = await axios.get('https://graph.instagram.com/me', {
      params: {
        fields: 'id,username,profile_picture_url',
        access_token: access_token
      }
    });

    const { username, profile_picture_url } = profileResponse.data;
    console.log('[Callback] Perfil obtido:', username);

    // Passo 3: Monta o objeto a ser salvo no Supabase
    // UUID fixo de teste — substitua pelo ID real do usuário logado quando houver auth
    const dataToInsert = {
      user_id: '00000000-0000-0000-0000-000000000001',
      instagram_username: username,
      access_token: access_token,
      profile_picture: profile_picture_url || null
    };

    console.log('=== JSON QUE VAI PRO BANCO ===');
    console.log(JSON.stringify(dataToInsert, null, 2));
    console.log('==============================');

    const { data: savedData, error } = await supabase
      .from('instagram_accounts')
      .insert([dataToInsert])
      .select(); // .select() confirma o retorno do registro inserido

    if (error) {
      console.error('--- ERRO NO SUPABASE ---');
      console.error('Mensagem:', error.message);
      console.error('Código:', error.code);
      console.error('Detalhes:', error.details);
      console.error('Hint:', error.hint);
      console.error('------------------------');
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=error&reason=db_error`);
    }

    console.log('--- SALVO COM SUCESSO! ---', savedData);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=success`);

  } catch (error) {
    const errDetail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('[Callback] Erro geral:', errDetail);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=error&reason=auth_failed`);
  }
});

// 5. Rota: Lista todas as contas Instagram vinculadas
app.get('/api/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('instagram_accounts')
      .select('id, instagram_username, profile_picture, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Accounts] Erro ao buscar contas:', error.message);
      return res.status(500).json({ error: 'Erro ao buscar contas.' });
    }

    res.json({ accounts: data });
  } catch (err) {
    console.error('[Accounts] Erro inesperado:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// 6. Inicialização do Servidor
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🚀 IceoLab Backend v1.0.4 Operacional`);
  console.log(`🔌 Porta: ${PORT}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? 'Conectado' : '⚠️ URL ausente!'}`);
  console.log(`🛡️  CORS: ${process.env.FRONTEND_URL}`);
  console.log(`========================================\n`);
});
