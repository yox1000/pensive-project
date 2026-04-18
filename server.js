require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const SEG_API = process.env.BACKEND_URL || 'http://localhost:9999';
// Direct tunnel for large uploads (serveo can't handle >1MB POST)
const SEG_API_DIRECT = process.env.BACKEND_URL_DIRECT || 'http://localhost:9999';

app.use(express.json());

// Proxy /api/backend/* to the Python segmentation backend
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9999';
app.use('/api/backend', createProxyMiddleware({
  target: BACKEND_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/backend': '' },
  timeout: 600000,
  proxyTimeout: 600000,
}));

app.use(express.static(__dirname));
app.use('/niivue', express.static(path.join(__dirname, 'node_modules/@niivue/niivue/dist')));

// Upload scan → TotalSegmentator → return scan_id
app.post('/api/segment', upload.single('file'), async (req, res) => {
  try {
    // Build multipart form manually for Node fetch compatibility
    const boundary = '----MedLens' + Date.now();
    const filename = req.file.originalname || 'scan.nii.gz';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(header),
      req.file.buffer,
      Buffer.from(footer),
    ]);

    // Use direct tunnel for uploads (serveo can't handle large POST)
    const response = await fetch(`${SEG_API_DIRECT}/segment`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Segment proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// Proxy original scan NIfTI (for NiiVue) - stream to handle large files
app.get('/api/scan/:scanId', async (req, res) => {
  const { Readable } = require('stream');
  const response = await fetch(`${SEG_API}/scan/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get scan' });
  res.setHeader('Content-Type', 'application/gzip');
  if (response.headers.get('content-length')) {
    res.setHeader('Content-Length', response.headers.get('content-length'));
  }
  Readable.fromWeb(response.body).pipe(res);
});

// Proxy segmentation NIfTI (for NiiVue overlay)
app.get('/api/segmentation/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/segmentation/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get segmentation' });
  res.setHeader('Content-Type', 'application/gzip');
  const buffer = await response.arrayBuffer();
  res.send(Buffer.from(buffer));
});

// Proxy medical analysis
app.get('/api/analyze/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/analyze/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get analysis' });
  const data = await response.json();
  res.json(data);
});

const SYSTEM_PROMPT = `You are a medical communication assistant. You receive clinical analysis of a medical scan and rewrite it for a patient with no medical background. Be clear, calm, honest. Never diagnose. Always recommend consulting a doctor.

IMPORTANT: Do NOT include any thinking, reasoning, or internal monologue. Output ONLY the patient-facing text. Be concise: 4-6 sentences maximum. No headers, no bullet points, just flowing text a patient can read.`;

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
