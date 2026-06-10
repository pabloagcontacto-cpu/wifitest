# WIFITEST Chat Service

Servicio local de chat para WIFITEST. Expone una API HTTP/SSE, guarda conversaciones en Redis y procesa turnos con un worker que orquesta OpenAI Responses + MCP async jobs.

## Arranque

Desde la raiz del proyecto:

```sh
./chat_service/runChatService.sh
```

En otra terminal, arrancar el worker de turnos:

```sh
./chat_service/runChatWorker.sh
```

Tambien se arranca automaticamente con:

```sh
./scripts/dev-stack.sh
```

Se puede desactivar dentro del stack con:

```sh
CHAT_SERVICE_ENABLED=0 ./scripts/dev-stack.sh
```

El worker se puede desactivar con:

```sh
CHAT_WORKER_ENABLED=0 ./scripts/dev-stack.sh
```

## Variables

- `CHAT_SERVICE_HOST`: host de uvicorn. Por defecto `127.0.0.1`.
- `CHAT_SERVICE_PORT`: puerto de uvicorn. Por defecto `8796`.
- `CHAT_REDIS_URL`: Redis del chat. Por defecto usa `REDIS_URL` o `redis://127.0.0.1:6379/1`.
- `CHAT_SERVICE_CORS_ALLOW_ORIGINS`: lista separada por comas. Por defecto permite Vite local y Tauri.
- `OPENAI_API_KEY`: clave de OpenAI necesaria para que el worker responda.
- `OPENAI_MODEL`: modelo de Responses API. Por defecto `gpt-4.1-mini`.
- `OPENAI_MCP_SERVER_URL`: MCP remoto que ve OpenAI. Por defecto `https://mcp.pablotests.xyz/mcp`.
- `OPENAI_MAX_TOOL_ROUNDS`: rondas maximas modelo -> job -> resultado. Por defecto `6`.
- `OPENAI_JOB_POLL_TIMEOUT_SECONDS`: timeout para esperar un job MCP. Por defecto `600`.

## Endpoints

- `GET /api/chat/health`
- `POST /api/chat/conversations`
- `GET /api/chat/conversations`
- `GET /api/chat/conversations/{conversation_id}`
- `DELETE /api/chat/conversations/{conversation_id}`
- `DELETE /api/chat/conversations`
- `GET /api/chat/conversations/{conversation_id}/messages`
- `POST /api/chat/conversations/{conversation_id}/messages`
- `GET /api/chat/turns/{turn_id}`
- `GET /api/chat/stream/{conversation_id}`

## Flujo

1. `POST /messages` guarda el mensaje del usuario.
2. El servicio crea un turno en Redis y lo encola en `CHAT_TURN_QUEUE_KEY`.
3. `runChatWorker.sh` toma el turno, crea o reutiliza una conversacion de OpenAI y llama a Responses con el tool MCP remoto.
4. Si el modelo llama una tool MCP, el MCP devuelve `job_id` y `job://...`.
5. El orquestador lee el resource hasta `completed`.
6. El resultado se emite por SSE en `tool_jobs_resolved` para que el frontend lo guarde en el estado global igual que un job manual.
7. El resultado se reinyecta al modelo.
8. Cuando no quedan jobs pendientes, se guarda el mensaje final del asistente y se emite por SSE.

## Contexto global

El frontend envia un resumen del estado global en cada `POST /messages`:

- red objetivo fijada, si existe;
- estado de conexion;
- puntuacion/resumen de seguridad;
- jobs recientes manuales o lanzados desde chat;
- recordatorio de que el agente no puede fijar la red objetivo por MCP.

El worker incluye ese contexto en el input enviado a OpenAI para que el agente conozca los analisis ya hechos desde la UI.

## Eventos SSE principales

- `connected`: stream abierto.
- `turn_queued`: mensaje guardado y turno en cola.
- `turn_started`: worker procesando.
- `model_responding`: OpenAI esta generando una respuesta con MCP disponible.
- `mcp_available`: el worker ha preparado el MCP remoto para el turno.
- `tool_jobs_resolved`: uno o varios jobs MCP se han resuelto; incluye los jobs completos para actualizar el store del frontend.
- `message_created`: nuevo mensaje para pintar en la UI.
- `turn_completed`: turno finalizado correctamente.
- `turn_failed`: fallo con `error` tecnico y `friendly_error` para UI.
- `conversation_deleted`: conversacion borrada.

## Prueba rapida

```sh
curl -s http://127.0.0.1:8796/api/chat/health
```

```sh
curl -s -X POST http://127.0.0.1:8796/api/chat/conversations \
  -H 'Content-Type: application/json' \
  -d '{"title":"Demo"}'
```

```sh
curl -N http://127.0.0.1:8796/api/chat/stream/<conversation_id>
```

```sh
curl -s -X POST http://127.0.0.1:8796/api/chat/conversations/<conversation_id>/messages \
  -H 'Content-Type: application/json' \
  -d '{"content":"Hola"}'
```
