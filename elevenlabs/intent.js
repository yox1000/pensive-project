// Gemini intent classification for AR voice commands
// Uses Gemma 4 27B via Gemini API

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent`;

const INTENT_SYSTEM = `You are an intent classifier for a brain scan AR viewer.
Given a user's spoken question and a list of brain structures in their scan, classify the intent and extract the target structure if any.

Respond ONLY with valid JSON in this exact format:
{
  "intent": "<one of: locate|health_status|size|explain|compare|overview|abnormalities|rotate>",
  "structure": "<exact structure name from the list, or null>",
  "action": "<one of: highlight|highlight_status|highlight_volume|highlight_explain|highlight_compare|none|highlight_all_abnormal|rotate>"
}

Intent → action mapping:
- locate → highlight
- health_status → highlight_status
- size → highlight_volume
- explain → highlight_explain
- compare → highlight_compare
- overview → none
- abnormalities → highlight_all_abnormal
- rotate → rotate`;

async function classifyIntent(question, structureNames) {
  const prompt = `Brain structures in this scan: ${structureNames.join(', ')}\n\nUser question: "${question}"\n\nClassify the intent and respond with JSON only.`;

  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: INTENT_SYSTEM }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 100 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Extract JSON from response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Gemini response');
  return JSON.parse(match[0]);
}

module.exports = { classifyIntent };
