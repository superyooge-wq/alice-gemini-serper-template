const DEFAULT_MODEL = "deepseek/deepseek-chat:online";
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 1000;
const MAX_ALICE_TEXT = 1000;
const TOTAL_RESPONSE_BUDGET_MS = 3500;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных, опирайся на результаты поиска; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[()\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Не удалось подготовить ответ.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const cut = text.slice(0, MAX_ALICE_TEXT - 3);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return trimmed + "...";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string" &&
      item.text.trim().length > 0
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history: safeHistory(history) }
  };
}

async function askRouterAI(text, history, timeoutMs) {
  const key = process.env.ROUTERAI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_KEY");

  const model = String(process.env.ROUTERAI_MODEL || process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  safeHistory(history).forEach(item => {
    messages.push({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    });
  });

  messages.push({ role: "user", content: text });

  const ms = Number.isFinite(timeoutMs)
    ? Math.max(100, timeoutMs)
    : TOTAL_RESPONSE_BUDGET_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const response = await fetch("https://routerai.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.5,
        max_tokens: 250
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`ROUTER_API_ERROR_${response.status}`);
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content?.trim();

    if (!answer) throw new Error("EMPTY_RESPONSE");
    return answer;
  } finally {
    clearTimeout(timer);
  }
}
