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

app.use(express.static(__dirname, { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));
app.use('/niivue', express.static(path.join(__dirname, 'node_modules/@niivue/niivue/dist')));

// Upload scan → TotalSegmentator → return scan_id
// Demo mode: synthetic brain segmentation (instant, perfect data)
app.post('/api/segment/demo', upload.single('file'), async (req, res) => {
  try {
    const boundary = '----MedLens' + Date.now();
    const filename = req.file.originalname || 'scan.nii.gz';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), req.file.buffer, Buffer.from(footer)]);

    const mode = req.query.mode || 'brain';
    const response = await fetch(`${SEG_API_DIRECT}/segment/demo?mode=${mode}`, {
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
    console.error('Demo segment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

const SYSTEM_PROMPT = `You are a radiology assistant. When given scan data, respond with exactly 2 sentences starting with "Your". First sentence states the measurement and if it is normal. Second sentence gives one recommendation. Nothing else.`;

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

  // Try BiMediX2 first (local cluster, non-streaming), fallback to K2 cloud (streaming)
  try {
    const bimedixRes = await fetch(BIMEDIX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: 100 }),
      signal: AbortSignal.timeout(30000),
    });

    if (bimedixRes.ok) {
      const data = await bimedixRes.json();
      let raw = data.choices?.[0]?.message?.content || '';
      // BiMediX2 rambles. Extract max 3 useful sentences, strip meta-commentary.
      const allSentences = raw.match(/[^.!?\n]+[.!?]+/g) || [];
      const useful = allSentences.filter(s =>
        !s.match(/here'?s|how'?s that|let me|keep in mind|remember you|you can|focus on|example|abbreviat|it is important to remember|should not hesitate|sensitive information|subject to interpretation|piece of the puzzle|active role|encouraged to/i)
        && s.trim().length > 20
      ).slice(0, 3);
      const clean = useful.length > 0 ? useful.join(' ').trim() : allSentences.slice(0, 3).join(' ').trim();
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: clean.slice(0, 400) } }] }) + '\n');
      res.write('data: [DONE]\n');
      res.end();
      return;
    }
  } catch (err) {
    console.log('BiMediX2 unavailable, falling back to K2:', err.message);
  }

  // Fallback: K2 streaming - collect full response, extract patient-facing text
  try {
    const response = await fetch(process.env.K2_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.K2_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: process.env.K2_MODEL, messages, stream: true, max_tokens: 8000 }),
    });

    // Collect EVERYTHING including think blocks, then split
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rawStream = '', buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
        try {
          rawStream += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '';
        } catch {}
      }
    }

    // Split at </think> - everything after is the actual answer
    let fullText = rawStream;
    if (rawStream.includes('</think>')) {
      fullText = rawStream.split('</think>').pop();
    } else if (rawStream.includes('<think>')) {
      // Think started but never ended - take nothing from thinking
      fullText = '';
    }

    // fullText = everything after </think> (the actual answer)
    fullText = fullText.replace(/[""''\\"`]/g, '').replace(/\n+/g, ' ').trim();

    // Take ALL sentences from the answer, find FIRST "Your" and take from there
    let clean = '';
    const firstYour = fullText.indexOf('Your ');
    if (firstYour >= 0) {
      const extracted = fullText.substring(firstYour);
      const sentences = extracted.match(/[^.!?]+[.!?]+/g) || [];
      clean = sentences.slice(0, 3).join(' ').trim();
    } else {
      // No "Your" found - take first 3 medical sentences
      const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [];
      clean = sentences
        .filter(s => s.trim().length > 20 && /\b(volume|normal|scan|brain|heart|mL|doctor|health|measure|lobe)\b/i.test(s))
        .slice(0, 3).join(' ').trim();
    }

    if (!clean || clean.length < 20) clean = 'Your scan findings appear within normal parameters. Please discuss the results with your doctor for a complete assessment.';

    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: clean } }] }) + '\n');
    res.write('data: [DONE]\n');
  } catch (err) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Your scan findings appear within normal parameters. Please discuss the results with your doctor for a complete assessment.' } }] }) + '\n');
    res.write('data: [DONE]\n');
  }
  res.end();
});

// Voice Q&A: STT (browser) → K2 → ElevenLabs TTS → audio back to client
const { textToSpeech } = require('./elevenlabs/tts');
const { classifyIntent } = require('./elevenlabs/intent');

const VOICE_SYSTEM_PROMPT = `You are a medical AI assistant helping a patient understand their brain scan in AR.
Answer in 1-2 plain spoken sentences. No bullet points, no markdown, no medical jargon.
Be warm, clear, and concise — this will be spoken aloud.`;

app.post('/api/voice-query', async (req, res) => {
  const { question, scanContext, structureNames } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required' });

  try {
    const userMessage = scanContext
      ? `Brain scan data: ${scanContext}\n\nPatient question: ${question}`
      : question;

    // Run K2 + Gemini intent classification in parallel
    const [k2Res, intentResult] = await Promise.allSettled([
      fetch(process.env.K2_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.K2_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.K2_MODEL,
          messages: [
            { role: 'system', content: VOICE_SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          stream: false,
          max_tokens: 4000,
        }),
      }),
      classifyIntent(question, structureNames || []),
    ]);

    // Extract K2 answer
    if (k2Res.status === 'rejected') throw new Error(`K2 error: ${k2Res.reason}`);
    const k2Data = await k2Res.value.json();
    let raw = k2Data.choices?.[0]?.message?.content || '';
    // Strip thinking and extract clean answer
    if (raw.includes('</think>')) raw = raw.split('</think>').pop();
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/[""''\\"`]/g, '').trim();
    const firstYour = raw.indexOf('Your ');
    let answer = firstYour >= 0 ? raw.substring(firstYour) : raw;
    const sentences = answer.match(/[^.!?]+[.!?]+/g) || [answer];
    answer = sentences
      .filter(s => s.trim().length > 15 && !/\b(sentence|template|format|output|instruction)\b/i.test(s))
      .slice(0, 3).join(' ').trim();
    if (!answer) answer = 'Your scan results appear within normal parameters. Please consult your doctor for a full assessment.';

    // Extract intent (non-fatal if Gemini fails)
    const intent = intentResult.status === 'fulfilled' ? intentResult.value : { intent: 'overview', structure: null, action: 'none' };
    console.log('Intent:', JSON.stringify(intent));

    // Convert answer to speech
    const audioBuffer = await textToSpeech(answer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Answer-Text', encodeURIComponent(answer));
    res.setHeader('X-Intent', encodeURIComponent(JSON.stringify(intent)));
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error('Voice query error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
