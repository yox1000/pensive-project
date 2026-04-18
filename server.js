require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/chat', async (req, res) => {
  const { messages, stream = false } = req.body;

  const response = await fetch(process.env.K2_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.K2_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.K2_MODEL,
      messages,
      stream,
    }),
  });

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    response.body.pipeTo(new WritableStream({
      write(chunk) { res.write(chunk); },
      close() { res.end(); },
    }));
  } else {
    const data = await response.json();
    res.json(data);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
