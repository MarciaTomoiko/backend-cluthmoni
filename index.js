// Importações
import express from 'express'; //import express
import { google } from 'googleapis'; //import google comunicação
import cors from 'cors';  //política
import dotenv from 'dotenv';  //.env
import pkg from 'pg'; //banco de dados
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';


//Google ID
async function obterGoogleIdComToken(token) {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      console.error("Erro ao buscar userinfo:", await response.text());
      return null;
    }

    const data = await response.json();
    return data.sub; // o Google ID
  } catch (err) {
    console.error("Erro ao obter Google ID:", err);
    return null;
  }
}


dotenv.config(); // Carrega as variáveis do .env

const PORT = process.env.PORT || process.env.NODE_PORT || 8000;
const app = express();
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

// Configuração do OAuth2 com as variáveis do .env Comunicação da API GOOGLE
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI // A URL de redirecionamento que você configurou no Google Cloud Console
);
//Política que o Google necessita!
app.use(cors({
  origin: ['http://localhost:5173'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Adicionando a opção de credenciais
}));

app.use(express.json()); // Ler o corpo JSON

// rota de realizar o Login
app.get('/auth/google', (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: process.env.GOOGLE_SCOPE.split(' '),
  });
  res.redirect(authUrl); // Redireciona diretamente para o Google
});

// Rota Callback obtendo os dados token, dados de frequência cardiaca e pressão arterial
app.get('/callback', async (req, res, next) => {
  try {
    const { code } = req.query; // O código vem na URL após o redirecionamento do Google
    if (!code) return res.status(400).json({ error: 'Código de autorização não fornecido' });

    // Token de acesso
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Buscar dados google
    const fitness = google.fitness({ version: 'v1', auth: oAuth2Client });

    // Data para o banco
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const response = await fitness.users.dataset.aggregate({
      userId: 'me',
      requestBody: {
        aggregateBy: [
          { dataTypeName: 'com.google.heart_rate.bpm' },
          { dataTypeName: 'com.google.blood_pressure' }
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis: oneDayAgo,
        endTimeMillis: now
      }
    });

    let heartRateSum = 0;
    let heartRateCount = 0;
    let systolicSum = 0;
    let diastolicSum = 0;
    let bpCount = 0;

    response.data.bucket.forEach(bucket => {
      bucket.dataset.forEach(dataset => {
        if (dataset.dataSourceId.includes('heart_rate')) {
          dataset.point.forEach(point => {
            heartRateSum += point.value[0].fpVal;
            heartRateCount++;
          });
        }

        if (dataset.dataSourceId.includes('blood_pressure')) {
          dataset.point.forEach(point => {
            systolicSum += point.value[0].fpVal;
            diastolicSum += point.value[1].fpVal;
            bpCount++;
          });
        }
      });
    });

    const averageHeartRate = heartRateCount > 0 ? (heartRateSum / heartRateCount).toFixed(2) : null;
    const averageSystolic = bpCount > 0 ? (systolicSum / bpCount).toFixed(2) : null;
    const averageDiastolic = bpCount > 0 ? (diastolicSum / bpCount).toFixed(2) : null;
    const googleId = await obterGoogleIdComToken(tokens.access_token);
//importante esse redirecionamento para não perder a comunicação da API google
    res.redirect(`http://localhost:5173/callback?token=${tokens.access_token}&hr=${averageHeartRate}&bp_systolic=${averageSystolic}&bp_diastolic=${averageDiastolic}&gid=${googleId}`); 
  } catch (error) {
    next(error);
  }
});

// Rota para buscar dados históricos
app.get('/dados-historicos', async (req, res) => {
  const { googleId, jogo } = req.query;
  console.log('Rota /dados-historicos recebida com:', { googleId, jogo });

  try {
    let query = `
  SELECT d.*, j.nome AS nome_jogo
  FROM dados_usuario d
  JOIN jogos j ON d.jogo_id = j.id
  WHERE d.google_id = $1
  ${jogo ? "AND d.jogo_id = $2" : ""}
  ORDER BY d.data DESC
  LIMIT 7
`;

    const params = jogo ? [googleId, jogo] : [googleId];
    const result = await pool.query(query, params);

    res.json(result.rows.reverse()); // Mostrar do mais antigo para o mais recente
  } catch (err) {
    console.error('Erro ao buscar dados:', err);
    res.status(500).send('Erro ao buscar dados.');
  }
});
//Pegar informações do banco
app.post('/save-game', async (req, res) => {
  const {
    token,
    jogoSelecionado,
    frequencia_cardiaca,
    pressao_sistolica,
    pressao_diastolica
  } = req.body; 

  try { 
    const googleId = await obterGoogleIdComToken(token);
    if (!googleId) return res.status(400).send('token inválido')

    const dataColeta = new Date(); // Usa data atual

    const query = `
      INSERT INTO dados_usuario (
        access_token,
        google_id,
        jogo_id,
        frequencia_cardiaca,
        pressao_sistolica,
        pressao_diastolica,
        data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    const values = [
      token,
      googleId,
      jogoSelecionado,
      frequencia_cardiaca,
      pressao_sistolica,
      pressao_diastolica,
      dataColeta
    ];

    await pool.query(query, values);

    res.status(201).send('Salvo com sucesso');
  } catch (error) {
    console.error(error);
    res.status(500).send('Erro ao salvar dados');
  }
});

app.get('/jogos', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nome, frases FROM jogos ORDER BY nome');
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Erro ao buscar jogos');
  }
});



// tratamento de erros
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`App listening at http://localhost:${PORT}`);
});
