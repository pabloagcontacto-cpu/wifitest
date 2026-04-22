// Url base del MCP
const DEFAULT_MCP_BASE_URL = "http://127.0.0.1:8000/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";



// Helper para parsear un string como JSON si es posible.
// Si no es posible, devuelve el string original.
function parseJsonIfPossible(rawValue) {
  if (typeof rawValue !== "string") {
    return rawValue;
  }

  const trimmedValue = rawValue.trim();
  if (trimmedValue === "") {
    return rawValue;
  }

  try {
    return JSON.parse(trimmedValue);
  } catch {
    return rawValue;
  }
}


// Helper para extraer el mensaje relevante de una respuesta JSON-RPC, especialmente si es un batch.
function extractJsonRpcMessage(payload, requestId) {
  if (Array.isArray(payload)) {
    return payload.find((message) => message.id === requestId) ?? payload[0] ?? null;
  }

  return payload;
}


// Funcion para parsear la respuesta HTTP de una petición JSON-RPC al MCP, 
// manejando errores y extrayendo el resultado.
// Devuelve ya el resutlado como un objeto JavaScript, no como string.
async function parseJsonRpcHttpResponse(response, requestId) {
  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `La petición HTTP al MCP ha fallado con código ${response.status}.`,
    );
  }

  if (!rawBody.trim()) {
    return null;
  }

  const payload = JSON.parse(rawBody);
  const message = extractJsonRpcMessage(payload, requestId);

  if (!message) {
    throw new Error("No se ha recibido un mensaje JSON-RPC válido desde el MCP.");
  }

  if (message.error) {
    throw new Error(
      message.error.message ?? "El MCP ha respondido con un error JSON-RPC.",
    );
  }

  return message.result ?? null;
}



// Clase que implementa un cliente para comunicarse con el MCP a través de su API JSON-RPC sobre HTTP.
class McpClient {
  // El constructor acepta opciones, actualmente solo la baseUrl del MCP, pero se pueden añadir más en el futuro.
  constructor({ baseUrl = DEFAULT_MCP_BASE_URL } = {}) {
    this.baseUrl = baseUrl;
    this.protocolVersion = DEFAULT_PROTOCOL_VERSION;
    this.requestCounter = 0;
    this.initializationPromise = null;
  }

  // Contador interno para generar IDs únicos para las peticiones JSON-RPC.
  nextRequestId() {
    this.requestCounter += 1;
    return this.requestCounter;
  }

  // Construye los headers para una petición JSON-RPC, incluyendo la versión del protocolo si se indica.
  buildHeaders({ includeProtocolVersion = true } = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (includeProtocolVersion && this.protocolVersion) {
      headers["MCP-Protocol-Version"] = this.protocolVersion;
    }

    return headers;
  }


  // Función interna para enviar un mensaje JSON-RPC al MCP a través de HTTP POST, 
  // y parsear la respuesta.
  async postJsonRpcMessage(message, { includeProtocolVersion = true } = {}) {
    const requestId = message.id ?? null;
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.buildHeaders({ includeProtocolVersion }),
      body: JSON.stringify(message),
    });

    return parseJsonRpcHttpResponse(response, requestId);
  }


  async sendNotification(method, params = {}) {
    await this.postJsonRpcMessage(
      {
        jsonrpc: "2.0",
        method,
        params,
      },
      { includeProtocolVersion: true },
    );
  }

  async initialize() {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        const initializeRequestId = this.nextRequestId();
        const initializeResult = await this.postJsonRpcMessage(
          {
            jsonrpc: "2.0",
            id: initializeRequestId,
            method: "initialize",
            params: {
              protocolVersion: DEFAULT_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: {
                name: "wifitest-frontend",
                version: "0.1.0",
              },
            },
          },
          { includeProtocolVersion: false },
        );

        this.protocolVersion =
          initializeResult?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

        await this.sendNotification("notifications/initialized");

        return initializeResult;
      })();
    }

    return this.initializationPromise;
  }


  // Helper que implementa la función de request genérica para enviar peticiones JSON-RPC al MCP,
  // y que será utilizada por funciones más específicas como listTools o callTool.
  async request(method, params = {}) {
    await this.initialize();
    const requestId = this.nextRequestId();

    return this.postJsonRpcMessage({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    });
  }

  async listTools() {
    return this.request("tools/list", {});
  }

  async callTool(toolName, args = {}) {
    return this.request("tools/call", {
      name: toolName,
      arguments: args,
    });
  }

  async readResource(uri) {
    return this.request("resources/read", { uri });
  }

  async readJobResource(jobId) {
    return this.readResource(`job://${jobId}`);
  }
}

let sharedClient = null;

export function createMcpClient(options) {
  return new McpClient(options);
}

export function getMcpClient() {
  if (!sharedClient) {
    sharedClient = createMcpClient();
  }

  return sharedClient;
}

export function extractStructuredToolPayload(callToolResult) {
  if (callToolResult?.structuredContent) {
    return callToolResult.structuredContent;
  }

  const firstContentBlock = callToolResult?.content?.[0];
  if (firstContentBlock?.type === "text") {
    return parseJsonIfPossible(firstContentBlock.text);
  }

  return null;
}

export function extractResourceContents(readResourceResult) {
  const firstContent = readResourceResult?.contents?.[0];

  if (!firstContent) {
    return null;
  }

  if (typeof firstContent.text === "string") {
    return parseJsonIfPossible(firstContent.text);
  }

  if (typeof firstContent.content === "string") {
    return parseJsonIfPossible(firstContent.content);
  }

  return firstContent;
}
