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

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\(\r\\)n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";
  return text.slice(0, MAX_ALICE_TEXT - 3) + "...";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function askRouterAI(text, history, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_KEY");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  
  safeHistory(history).forEach(item => {
    messages.push({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    });
  });
  
  messages.push({ role: "user", content: text });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));

  try {
const response = await fetch("https://routerai.ru", {
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

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-routerai",
      message: "Ready for Yandex Dialogs."
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я готова ответить на любой вопрос с помощью большой нейросети. Что хотите узнать?",
      false,
      oldHistory
    ));
  }

  try {
    const answer = await askRouterAI(text, oldHistory, remainingMs());
    
    const history = [
      ...oldHistory,
      { role: "user", text },
      { role: "model", text: answer }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    console.error("Error details:", error.message);
    let userMessage = "Ой, что-то пошло не так у ИИ-сервера. Попробуйте еще раз.";
    if (error.message === "MISSING_KEY") {
      userMessage = "Ошибка настройки: отсутствует API-ключ в переменных Vercel.";
    } else if (error.message.includes("ROUTER_API_ERROR_401")) {
      userMessage = "Ошибка авторизации: ваш API-ключ RouterAI недействителен или введен неверно.";
    } else if (error.message.includes("ROUTER_API_ERROR_402")) {
      userMessage = "Недостаточно средств. Пожалуйста, проверьте баланс вашего аккаунта RouterAI.";
    }
    return res.status(200).json(aliceResponse(userMessage, false, oldHistory));
  }
}
