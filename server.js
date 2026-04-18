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

const SYSTEM_PROMPT = `You are a medical imaging assistant. Given clinical findings from a scan segmentation, provide a clear, calm, patient-friendly explanation. Never diagnose. Recommend consulting a doctor. Be concise: 3-5 sentences of flowing text. No headers, no bullets, no reasoning.`;

// BiMediX2 running on local cluster via vLLM
const BIMEDIX_URL = process.env.BIMEDIX_URL || 'http://localhost:8000/v1/chat/completions';
const BIMEDIX_MODEL = process.env.BIMEDIX_MODEL || 'BiMediX2-8B-hf';

// Send structure data to BiMediX2 (cluster) with K2 fallback, stream response
app.post('/api/analyze', async (req, res) => {
  const { medicalAnalysis } = req.body;
  if (!medicalAnalysis) return res.status(400).json({ error: 'medicalAnalysis is required' });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: medicalAnalysis },
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  // Try BiMediX2 first (local cluster), fallback to K2 cloud
  let response;
  let usedModel = 'bimedix2';
  try {
    response = await fetch(BIMEDIX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: BIMEDIX_MODEL, messages, stream: true, max_tokens: 512 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('BiMediX2 not ready');
  } catch (err) {
    console.log('BiMediX2 unavailable, falling back to K2:', err.message);
    usedModel = 'k2';
    response = await fetch(process.env.K2_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.K2_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: process.env.K2_MODEL, messages, stream: true }),
    });
  }

  // Stream response, filtering think blocks
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let inThink = false;
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) { res.write(line + '\n'); continue; }
      const data = line.slice(6);
      if (data === '[DONE]') { res.write(line + '\n'); continue; }
      try {
        const parsed = JSON.parse(data);
        let content = parsed.choices?.[0]?.delta?.content || '';
        // Filter <think> blocks (K2 reasoning)
        if (content.includes('<think>')) inThink = true;
        if (inThink) {
          if (content.includes('</think>')) {
            content = content.split('</think>').pop();
            inThink = false;
          } else { content = ''; }
        }
        if (content) {
          parsed.choices[0].delta.content = content;
          res.write('data: ' + JSON.stringify(parsed) + '\n');
        }
      } catch {
        res.write(line + '\n');
      }
    }
  }
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
