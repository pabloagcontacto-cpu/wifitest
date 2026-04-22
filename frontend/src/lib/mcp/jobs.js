import {
  extractResourceContents,
  extractStructuredToolPayload,
  getMcpClient,
} from "./client.js";
import { upsertJob } from "./store.js";

const DEFAULT_POLL_INTERVAL_MS = 3500; // Intervalo de tiempo por defecto entre cada intento de polling para comprobar el estado de un job.
const DEFAULT_JOB_TIMEOUT_MS = 120000; // Tiempo maximo por defecto para hacer polling de un job antes de considerarlo fallido por timeout.


const pollingHandles = new Map(); // Guarda los handles de los timeouts para cada job que se esta haciendo polling, para poder cancelarlos cuando el job termine o falle.
const pollingMeta = new Map(); // Guarda metadata de cada job que se esta haciendo polling, como el tiempo de inicio del polling, el intervalo entre polls y el timeout total permitido, para controlar mejor el proceso de polling.


// Helper para determinar si un status de job se considera terminado (ya sea completado con exito, fallido o no encontrado).
function isFinishedStatus(status) {
  return status === "completed" || status === "failed" || status === "not_found";
}


// Helper para normalizar la información de un job recibida desde el MCP.
function normalizeRemoteJob(remoteJob) {
  return {
    jobId: remoteJob?.job_id ?? remoteJob?.jobId ?? null,
    toolName: remoteJob?.tool_name ?? remoteJob?.toolName ?? null,
    status: remoteJob?.status ?? "unknown",
    input: remoteJob?.input ?? null,
    result: remoteJob?.result ?? null,
    error: remoteJob?.error ?? null,
    submittedAt: remoteJob?.submitted_at ?? remoteJob?.submittedAt ?? null,
    startedAt: remoteJob?.started_at ?? remoteJob?.startedAt ?? null,
    finishedAt: remoteJob?.finished_at ?? remoteJob?.finishedAt ?? null,
    resourceUri: remoteJob?.resource ?? null,
  };
}


// Si el job aun no tiene metadata de polling, la crea con los valores por defecto o los que se le hayan pasado en options, y devuelve la metadata del job.
// Si el job ya tiene metadata de polling, simplemente la devuelve.
function getOrCreatePollingMeta(jobId, options) {
  if (!pollingMeta.has(jobId)) {
    pollingMeta.set(jobId, {
      startedAt: Date.now(),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    });
  }

  return pollingMeta.get(jobId);
}


// Programa el siguiente intento de polling para un job, guardando el handle del timeout para poder cancelarlo si es necesario.
function scheduleNextPoll(jobId, options) {
  stopPolling(jobId);
  const meta = getOrCreatePollingMeta(jobId, options);

  const timeoutHandle = window.setTimeout(() => {
    pollJobUntilFinished(jobId, options);
  }, meta.pollIntervalMs);

  pollingHandles.set(jobId, timeoutHandle);
}


// Función para cancelar el polling de un job, eliminando su handle de timeout y su metadata.
export function stopPolling(jobId) {
  const timeoutHandle = pollingHandles.get(jobId);
  if (timeoutHandle) {
    window.clearTimeout(timeoutHandle);
    pollingHandles.delete(jobId);
  }
}


// Para todos los jobs que se estan haciendo polling, cancela su polling y elimina su metadata.
export function stopAllPolling() {
  [...pollingHandles.keys()].forEach((jobId) => {
    stopPolling(jobId);
  });
}


// Funcion principal para hacer polling del estado de un job hasta que termine, actualizando el estado del job en el store cada vez que se obtiene nueva información.
// Devuelve el estado final del job una vez que ha terminado, ya sea completado con exito o fallido.
export async function pollJobUntilFinished(jobId, options = {}) {
  // Crea o recupera la metadata de polling del job, para controlar el tiempo total de polling y el intervalo entre polls.
  const meta = getOrCreatePollingMeta(jobId, options);

  // Si el tiempo total de polling ha superado el timeout permitido, se considera que el job ha fallado por timeout, se cancela el polling y se actualiza el estado del job en el store con el error correspondiente.
  if (Date.now() - meta.startedAt > meta.timeoutMs) {
    stopPolling(jobId);
    pollingMeta.delete(jobId);

    return upsertJob({
      jobId,
      status: "failed",
      error: {
        message: "El polling del job ha superado el tiempo maximo permitido.",
        type: "PollingTimeoutError",
      },
      finishedAt: new Date().toISOString(),
    });
  }

  // Si el job aun no ha superado el timeout, se hace un intento de polling para obtener su estado actual desde el MCP, 
  // y se actualiza el estado del job en el store.
  try {
    const client = getMcpClient();
    const readResourceResult = await client.readJobResource(jobId);
    const remoteJob = extractResourceContents(readResourceResult);
    const normalizedJob = normalizeRemoteJob(remoteJob);
    const savedJob = upsertJob(normalizedJob);

    if (isFinishedStatus(savedJob.status)) {
      stopPolling(jobId);
      pollingMeta.delete(jobId);
      return savedJob;
    }

    scheduleNextPoll(jobId, options);
    return savedJob;
  } catch (error) {
    stopPolling(jobId);
    pollingMeta.delete(jobId);

    return upsertJob({
      jobId,
      status: "failed",
      error: {
        message:
          error instanceof Error
            ? error.message
            : "No se pudo recuperar el estado del job.",
        type: "PollingRequestError",
      },
      finishedAt: new Date().toISOString(),
    });
  }
}


// Funcion para ejecutar una herramienta MCP, que hace la llamada al MCP para iniciar la ejecución de la herramienta,
// guarda el job inicial en el store y programa el polling para comprobar su estado hasta que termine.
export async function executeTool(toolName, args = {}, options = {}) {
  const client = getMcpClient();
  const toolCallResult = await client.callTool(toolName, args);
  const payload = extractStructuredToolPayload(toolCallResult);

  if (!payload?.job_id) {
    throw new Error(
      `La tool '${toolName}' no ha devuelto un job_id valido para iniciar el polling.`,
    );
  }

  const initialJob = upsertJob({
    localRequestId: crypto.randomUUID(),
    jobId: payload.job_id,
    toolName,
    status: payload.status ?? "queued",
    resourceUri: payload.resource ?? `job://${payload.job_id}`,
    input: args,
    submittedAt: new Date().toISOString(),
  });

  scheduleNextPoll(initialJob.jobId, options);
  return initialJob;
}
