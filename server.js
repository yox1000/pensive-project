require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const SEG_API = 'https://ad340e2a00a48de0-66-180-180-8.serveousercontent.com';

app.use(express.json());

// Proxy /api/backend/* to the Python segmentation backend
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9999';
app.use('/api/backend', createProxyMiddleware({
  target: BACKEND_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/backend': '' },
}));

app.use(express.static(__dirname));
app.use('/niivue', express.static(path.join(__dirname, 'node_modules/@niivue/niivue/dist')));

// Upload scan → TotalSegmentator → return scan_id
app.post('/api/segment', upload.single('file'), async (req, res) => {
  const formData = new FormData();
  const blob = new Blob([req.file.buffer]);
  formData.append('file', blob, req.file.originalname);

  const response = await fetch(`${SEG_API}/segment`, { method: 'POST', body: formData });
  if (!response.ok) return res.status(response.status).json({ error: 'Segmentation failed' });
  const data = await response.json();
  res.json(data);
});

// Get structure labels + metadata for a scan
app.get('/api/structures/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/structures/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get structures' });
  const data = await response.json();
  res.json(data);
});

// Proxy GLB mesh
app.get('/api/mesh/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/mesh/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get mesh' });
  res.setHeader('Content-Type', 'model/gltf-binary');
  const buffer = await response.arrayBuffer();
  res.send(Buffer.from(buffer));
});

const SYSTEM_PROMPT = `You are a medical communication assistant. You will receive a detailed clinical analysis of a medical scan produced by a segmentation AI. Your job is to reason carefully through it and rewrite it for a patient with no medical background — clear, calm, and honest. Never downplay serious findings. Never diagnose. Always recommend consulting a doctor.

Respond in exactly this format:

SUMMARY
1-2 sentence plain English overview.

WHAT WE FOUND
Bullet points, plain language, no jargon.

WHAT THIS MIGHT MEAN
Honest but calm interpretation.

NEXT STEPS
What the patient should do.`;

// Send structure data to K2, stream patient-friendly response
app.post('/api/analyze', async (req, res) => {
  const { medicalAnalysis } = req.body;
  if (!medicalAnalysis) return res.status(400).json({ error: 'medicalAnalysis is required' });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Here is the clinical analysis of the uploaded scan:\n\n${medicalAnalysis}\n\nTranslate this into a patient-friendly explanation.` },
  ];

  const response = await fetch(process.env.K2_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.K2_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: process.env.K2_MODEL, messages, stream: true }),
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value));
  }
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
