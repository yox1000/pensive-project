// DeepSeek intent classification for AR voice commands

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

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

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 100,
    }),
  });

  if (!res.ok) throw new Error(`DeepSeek error: ${await res.text()}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in DeepSeek response');
  return JSON.parse(match[0]);
}

module.exports = { classifyIntent };
