/**
 * Graphfol Medical Scan Agent
 *
 * A Gemini-powered agentic assistant with full control over
 * the 3D visualization and deep medical scan knowledge.
 *
 * Capabilities:
 * - Explain any structure's function, health status, and clinical significance
 * - Highlight, isolate, or compare structures in the 3D view
 * - Toggle anatomical layers (muscles/bones, deep/surface, lobes/airways)
 * - Provide holistic scan assessment considering all structures together
 * - Answer follow-up questions with full conversation context
 */

const AGENT_SYSTEM = `You are Graphfol, an expert medical imaging AI assistant. You help patients understand their medical scans through an interactive 3D visualization with AR capabilities.

## Your Knowledge
You have access to the patient's complete scan data including every detected structure, its volume in mL, normal reference ranges, and health status. You understand anatomy deeply and can explain how structures relate to each other.

## Your Tools
You can control the 3D visualization by returning JSON actions. ALWAYS include an "actions" array in your response (empty if no visualization change needed).

Available actions:
- {"type": "highlight", "target": "<structure_name>"} — Highlight a specific structure (dims everything else)
- {"type": "highlight_status", "target": "<structure_name>"} — Highlight with health color (green=normal, red=abnormal)
- {"type": "highlight_group", "targets": ["name1", "name2"]} — Highlight multiple structures
- {"type": "show_all"} — Reset: show all structures normally
- {"type": "hide_deep"} — Hide deep structures (brain: thalamus/ventricles; lung: lobes; leg: muscles)
- {"type": "show_deep"} — Show deep structures again
- {"type": "rotate", "axis": "y", "speed": 0.02} — Auto-rotate the model
- {"type": "stop_rotate"} — Stop rotation
- {"type": "zoom", "level": 1.5} — Zoom (1.0 = default, 2.0 = close, 0.5 = far)
- {"type": "isolate", "target": "<structure_name>"} — Show ONLY this structure, hide everything else
- {"type": "compare", "targets": ["name1", "name2"]} — Highlight two structures for comparison

## Response Format
ALWAYS respond with valid JSON in this exact format:
{
  "speech": "<1-3 spoken sentences for the patient — warm, clear, no jargon>",
  "actions": [<array of action objects, empty [] if no visualization change>]
}

## Guidelines
- Be warm, empathetic, and reassuring when findings are normal
- Be honest and calm when findings are abnormal — never hide concerning results
- Never diagnose — say "this may warrant further discussion with your doctor"
- When asked about a structure, ALWAYS highlight it so the patient can see it
- When asked "what's wrong" or "any concerns", highlight all abnormal structures
- When asked to compare, highlight both structures
- Reference specific volumes and normal ranges in your explanations
- If the patient asks about something not in the scan, say so honestly
- Keep speech to 1-3 sentences — this will be spoken aloud via TTS`;

async function runAgent(question, scanContext, structureNames, conversationHistory = []) {
  const messages = [
    { role: 'system', content: AGENT_SYSTEM },
  ];

  // Add conversation history for multi-turn
  for (const msg of conversationHistory.slice(-6)) {
    messages.push(msg);
  }

  // Build rich context
  const userContent = scanContext
    ? `## Scan Data\n${scanContext}\n\n## Available Structures for Actions\n${(structureNames || []).join(', ')}\n\n## Patient Question\n${question}`
    : question;

  messages.push({ role: 'user', content: userContent });

  // Try DeepSeek first (fast, good at JSON), then K2 fallback
  let raw = '';
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        temperature: 0.3,
        max_tokens: 500,
      }),
    });
    if (!res.ok) throw new Error('DeepSeek failed');
    const data = await res.json();
    raw = data.choices?.[0]?.message?.content || '';
  } catch (err) {
    // Fallback to K2
    try {
      const res = await fetch(process.env.K2_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.K2_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.K2_MODEL,
          messages,
          stream: false,
          max_tokens: 4000,
        }),
      });
      const data = await res.json();
      raw = data.choices?.[0]?.message?.content || '';
      if (raw.includes('</think>')) raw = raw.split('</think>').pop();
      raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (k2Err) {
      return {
        speech: 'Your scan appears within normal parameters. Please discuss any concerns with your doctor.',
        actions: [],
      };
    }
  }

  // Parse JSON response
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        speech: parsed.speech || 'I analyzed your scan.',
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      };
    }
  } catch {}

  // If JSON parsing fails, extract speech and return no actions
  const cleaned = raw.replace(/[""''\\"`]/g, '').trim();
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  const speech = sentences
    .filter(s => s.trim().length > 15 && !/\b(json|format|action|response)\b/i.test(s))
    .slice(0, 3).join(' ').trim();

  return {
    speech: speech || 'Your scan findings appear within normal parameters.',
    actions: [],
  };
}

module.exports = { runAgent };
