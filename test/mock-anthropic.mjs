// A stand-in for the Anthropic Messages API that streams a canned answer, so the
// relay and page can be tested without a real API key or spending money.
// Run: node test/mock-anthropic.mjs  (listens on :8788)
import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http
  .createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const last = body.messages.at(-1).content;
    const inputTokens = Math.round(JSON.stringify(body).length / 4);

    if (last.includes("refuse")) return stream(res, inputTokens, [], "refusal");
    const words = `You asked: "${last}". This is the mock engine answering from test/mock-anthropic.mjs, word by word, so you can watch the stream arrive.`.split(" ");
    return stream(res, inputTokens, words, "end_turn");
  })
  .listen(8788, () => console.log("mock Anthropic API on http://localhost:8788"));

async function stream(res, inputTokens, words, stopReason) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

  await sleep(250);
  send("message_start", {
    message: {
      id: "msg_mock", type: "message", role: "assistant", content: [], model: "claude-haiku-5-5",
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
  await sleep(400);
  send("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "mock" } });
  send("content_block_stop", { index: 0 });

  if (words.length) {
    send("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
    for (const [i, w] of words.entries()) {
      send("content_block_delta", { index: 1, delta: { type: "text_delta", text: (i ? " " : "") + w } });
      await sleep(40);
    }
    send("content_block_stop", { index: 1 });
  }
  const visible = Math.round(words.join(" ").length / 4);
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: visible + 60 } });
  send("message_stop", {});
  res.end();
}
