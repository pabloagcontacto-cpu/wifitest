const DEFAULT_CHAT_BASE_URL = "http://127.0.0.1:8796/api/chat";

async function parseJsonResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.detail ?? payload?.error ?? response.statusText;
    throw new Error(`Chat service HTTP ${response.status}: ${detail}`);
  }

  return payload;
}

export class ChatServiceClient {
  constructor({ baseUrl = DEFAULT_CHAT_BASE_URL } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health() {
    const response = await fetch(`${this.baseUrl}/health`);
    return parseJsonResponse(response);
  }

  async createConversation({ title = "Nueva conversacion" } = {}) {
    const response = await fetch(`${this.baseUrl}/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });
    return parseJsonResponse(response);
  }

  async listConversations() {
    const response = await fetch(`${this.baseUrl}/conversations`);
    return parseJsonResponse(response);
  }

  async listMessages(conversationId) {
    const response = await fetch(`${this.baseUrl}/conversations/${conversationId}/messages`);
    return parseJsonResponse(response);
  }

  async sendMessage(conversationId, content, context = {}) {
    const response = await fetch(`${this.baseUrl}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content, context }),
    });
    return parseJsonResponse(response);
  }

  async deleteConversation(conversationId) {
    const response = await fetch(`${this.baseUrl}/conversations/${conversationId}`, {
      method: "DELETE",
    });
    return parseJsonResponse(response);
  }

  async deleteAllConversations() {
    const response = await fetch(`${this.baseUrl}/conversations`, {
      method: "DELETE",
    });
    return parseJsonResponse(response);
  }

  openEventStream(conversationId) {
    return new EventSource(`${this.baseUrl}/stream/${conversationId}`);
  }
}

export const chatServiceClient = new ChatServiceClient();
