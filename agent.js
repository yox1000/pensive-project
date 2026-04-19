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

const AGENT_SYSTEM = `You are Graphfol, an expert medical imaging AI assistant. You help patients understand their medical scans through an interactive 3D visualization with AR.

## Your Knowledge
You have the patient's complete scan data: every structure, volume in mL, normal ranges, and health status. You understand anatomy deeply and how structures relate.

## Response Format
ALWAYS respond with valid JSON. You have TWO modes:

### Mode 1: Single response (for questions)
{
  "speech": "<1-3 spoken sentences>",
  "actions": [<action objects>]
}

### Mode 2: Walkthrough (for "give me a tour", "walk me through", "explain everything", "overview")
{
  "walkthrough": [
    {"speech": "<what to say about this structure>", "actions": [{"type": "highlight", "target": "structure_name"}], "delay": 6},
    {"speech": "<next structure explanation>", "actions": [{"type": "highlight", "target": "next_structure"}], "delay": 6},
    ...
  ]
}

When the user asks for a walkthrough/tour/overview, return a walkthrough with one step per major structure. Each step highlights the structure, explains it with its volume and status, and waits before moving to the next. Cover 5-8 most important structures. Start with a show_all, end with a show_all.

## Available Actions
- {"type": "highlight", "target": "<name>"} — Highlight structure
- {"type": "highlight_status", "target": "<name>"} — Green=normal, red=abnormal
- {"type": "highlight_group", "targets": ["a", "b"]} — Multiple structures
- {"type": "show_all"} — Reset view
- {"type": "hide_deep"} — Toggle deep structures off
- {"type": "show_deep"} — Toggle deep structures on
- {"type": "isolate", "target": "<name>"} — Show ONLY this structure
- {"type": "compare", "targets": ["a", "b"]} — Compare two structures
- {"type": "rotate", "speed": 0.02} — Auto-rotate
- {"type": "stop_rotate"} — Stop rotation

## Structure Names (use these exact names in actions)
Brain: brain, skull, frontal_lobe, parietal_lobe, temporal_lobe, occipital_lobe, cerebellum, brainstem, thalamus, caudate_nucleus, lentiform_nucleus, ventricle, insular_cortex, internal_capsule, subarachnoid_space, venous_sinuses, septum_pellucidum, central_sulcus, spinal_cord
Lungs: lung_upper_lobe_left, lung_lower_lobe_left, lung_upper_lobe_right, lung_middle_lobe_right, lung_lower_lobe_right, heart, aorta, trachea, esophagus
Leg: femur, tibia, hip_bone, sacrum, quadriceps, hamstrings, gluteus, adductors, calf_muscles, sartorius, iliotibial_band, tibialis_anterior

## Guidelines
- Warm, empathetic, reassuring for normal findings
- Honest and calm for abnormal findings
- Never diagnose — suggest discussing with doctor
- ALWAYS highlight the structure you're talking about
- Reference specific volumes and normal ranges
- Keep speech to 1-3 sentences per step — spoken via TTS
- For walkthroughs: start general, then go structure by structure, mention any concerns, end with summary
- delay field is seconds to wait before next step (4-8 seconds depending on speech length)`;

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
        max_tokens: 4000,
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

      // Check if it's a walkthrough response
      if (parsed.walkthrough && Array.isArray(parsed.walkthrough)) {
        return { walkthrough: parsed.walkthrough };
      }

      // Single response
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
