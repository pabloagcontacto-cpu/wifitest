// Estado centralizado para herramientas y jobs del MCP, con funciones para actualizar el estado y notificar a los listeners.


// El estado se estructura con un objeto principal que contiene un array de herramientas,
// un objeto de jobs indexados por jobId, y arrays separados de jobIds para trabajos activos, completados y fallidos.
const TARGET_NETWORK_STORAGE_KEY = "wifitest.targetNetwork";

const state = {
  tools: [], // Lista de tools descubiertas y normalizadas.
  jobs: {},  // Dirccionario de jobs indexados por jobId, {"jobId": {jobID: "jobId", "toolName": "toolName", status: "running"}}.
  activeJobIds: [], // Ids de jobs en queued o running.
  completedJobIds: [],  // ids de jobs terminados correctamente.
  failedJobIds: [],  // ids de jobs terminados con error.
  targetNetwork: loadPersistedTargetNetwork(),
};


// Aqui se guardan los componentes que estan suscritos al store.
// Es decir, compoennentes o modulos que quieren enterarse cuando cambia el estado.
// En la mayor parte de los casos, seran componentes de React que se suscriben para actualizar su UI cuando cambia el estado del MCP.
const listeners = new Set();


function loadPersistedTargetNetwork() {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(TARGET_NETWORK_STORAGE_KEY);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch {
    return null;
  }
}


function persistTargetNetwork() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  if (state.targetNetwork) {
    window.localStorage.setItem(
      TARGET_NETWORK_STORAGE_KEY,
      JSON.stringify(state.targetNetwork),
    );
    return;
  }

  window.localStorage.removeItem(TARGET_NETWORK_STORAGE_KEY);
}


// Crea una copia del estado actual y la envia a todos los listeners registrados, 
// para que puedan actualizarse.
function emitChange() {
  const snapshot = getState();
  listeners.forEach((listener) => listener(snapshot));
}


// Recorre todos los jobs del estado y reconstruye los arrays de activeJobIds, completedJobIds y failedJobIds.
function rebuildJobIndexes() {
  const jobs = Object.values(state.jobs);

  state.activeJobIds = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => job.jobId);

  state.completedJobIds = jobs
    .filter((job) => job.status === "completed")
    .map((job) => job.jobId);

  state.failedJobIds = jobs
    .filter((job) => job.status === "failed")
    .map((job) => job.jobId);
}


// Devuelve una copia del estado actual, para evitar que se modifique directamente desde fuera del store.
export function getState() {
  return {
    tools: [...state.tools],
    jobs: { ...state.jobs },
    activeJobIds: [...state.activeJobIds],
    completedJobIds: [...state.completedJobIds],
    failedJobIds: [...state.failedJobIds],
    targetNetwork: state.targetNetwork ? { ...state.targetNetwork } : null,
  };
}

// Funcion para suscribirse a los cambios del estado, recibe un listener (funcion) que se llamara cada vez que el estado cambie.
export function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}


// guarda la lista de tools descubiertas
//avisa a todos los listeners
// normalmente se llamara a esta funcion despues de discoverTools() para guardar el resultado en el estado y actualizar la UI.
export function setTools(tools) {
  state.tools = [...tools];
  emitChange();
}


// Funcion para guardar o actualizar un job en el estado, recibe un objeto job con al menos un jobId, y lo guarda o actualiza en el estado.
export function upsertJob(job) {
  if (!job?.jobId) {
    throw new Error("No se puede guardar un job sin jobId.");
  }

  const previousJob = state.jobs[job.jobId] ?? {};
  state.jobs[job.jobId] = {
    ...previousJob,
    ...job,
  };

  rebuildJobIndexes();
  emitChange();

  return state.jobs[job.jobId];
}


export function setTargetNetwork(targetNetwork) {
  state.targetNetwork = targetNetwork ? { ...targetNetwork } : null;
  persistTargetNetwork();
  emitChange();
}


export function updateTargetNetwork(updates) {
  if (!state.targetNetwork) {
    return null;
  }

  state.targetNetwork = {
    ...state.targetNetwork,
    ...updates,
  };
  persistTargetNetwork();
  emitChange();

  return state.targetNetwork;
}


export function clearTargetNetwork() {
  state.targetNetwork = null;
  persistTargetNetwork();
  emitChange();
}


export function clearApplicationState() {
  state.jobs = {};
  state.activeJobIds = [];
  state.completedJobIds = [];
  state.failedJobIds = [];
  state.targetNetwork = null;
  persistTargetNetwork();
  emitChange();
}
