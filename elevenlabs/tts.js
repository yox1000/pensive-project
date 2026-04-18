// ElevenLabs TTS via REST API — no SDK needed
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)

async function textToSpeech(text) {
  const res = await fetch(`${ELEVENLABS_API_URL}/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS failed: ${err}`);
  }

  return res.arrayBuffer();
}

module.exports = { textToSpeech };
