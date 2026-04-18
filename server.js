require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const SYSTEM_PROMPT = `You are a medical communication assistant. You will receive a detailed clinical analysis of a brain scan written by a medical AI. Your job is to reason carefully through it and rewrite it for a patient with no medical background — clear, calm, and honest. Never downplay serious findings. Never diagnose. Always recommend consulting a doctor.

Respond in exactly this format:

SUMMARY
1-2 sentence plain English overview.

WHAT WE FOUND
Bullet points, plain language, no jargon.

WHAT THIS MIGHT MEAN
Honest but calm interpretation.

NEXT STEPS
What the patient should do.`;

// POST /api/analyze
// Body: { medicalAnalysis: string }
// Returns: K2's patient-friendly explanation (streaming)
app.post('/api/analyze', async (req, res) => {
  const { medicalAnalysis } = req.body;
  if (!medicalAnalysis) return res.status(400).json({ error: 'medicalAnalysis is required' });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: `Here is the clinical analysis of the uploaded brain scan:\n\n${medicalAnalysis}\n\nTranslate this into a patient-friendly explanation.` },
  ];

  const response = await fetch(process.env.K2_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.K2_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.K2_MODEL,
      messages,
      stream: true,
    }),
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
