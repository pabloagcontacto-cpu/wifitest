// Url para cargar el contrato compartido en caso de que no se pueda acceder a través de Tauri
const CONTRACTS_FALLBACK_URL = "/contracts/tools.json";
const RUNTIME_CONFIG_FALLBACK_URL = "/config/local.json";

// Cache de la promesa de carga de contracts para evitar múltiples cargas simultáneas
let contractsPromise = null;
let runtimeConfigPromise = null;


// Funcion para obtener la función de invoke de Tauri si está disponible.
function getTauriInvoke() {
  return window.__TAURI__?.core?.invoke ?? null;
}


// Función para cargar los contratos utilizando Tauri.
async function loadContractsThroughTauri() {
  const invoke = getTauriInvoke();
  if (!invoke) {
    throw new Error("Tauri runtime no disponible para leer contracts/tools.json.");
  }

  return invoke("read_tool_contracts"); // Comando definido en el backend de Tauri para leer el contrato compartido
}


// Función para cargar los contratos utilizando fetch como fallback.
async function loadContractsThroughFetch() {
  const response = await fetch(CONTRACTS_FALLBACK_URL);
  if (!response.ok) {
    throw new Error(
      `No se pudo cargar el contrato compartido desde ${CONTRACTS_FALLBACK_URL}.`,
    );
  }

  return response.json();
}

async function loadRuntimeConfigThroughTauri() {
  const invoke = getTauriInvoke();
  if (!invoke) {
    throw new Error("Tauri runtime no disponible para leer config/local.json.");
  }

  return invoke("read_runtime_config");
}


async function loadRuntimeConfigThroughFetch() {
  const response = await fetch(RUNTIME_CONFIG_FALLBACK_URL);
  if (response.status === 404) {
    return {};
  }
  if (!response.ok) {
    throw new Error(
      `No se pudo cargar la configuracion local desde ${RUNTIME_CONFIG_FALLBACK_URL}.`,
    );
  }

  return response.json();
}


// Funcion principal para cargar los contratos, intenta Tauri primero y luego fetch como fallback.
export async function loadToolContracts() {
  if (!contractsPromise) {
    contractsPromise = (async () => {
      try {
        return await loadContractsThroughTauri();
      } catch (tauriError) {
        try {
          return await loadContractsThroughFetch();
        } catch {
          throw tauriError;
        }
      }
    })();
  }

  return contractsPromise;
}


export async function loadRuntimeConfig() {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = (async () => {
      try {
        return await loadRuntimeConfigThroughTauri();
      } catch {
        try {
          return await loadRuntimeConfigThroughFetch();
        } catch {
          return {};
        }
      }
    })();
  }

  return runtimeConfigPromise;
}

// Helper que se llama desde fuera para obtener un contrato específico de herramienta.
export async function getToolContract(toolName) {
  const contract = await loadToolContracts();
  return contract.tools?.[toolName] ?? null;
}


// Helper para obtener el contrato de input de una herramienta específica.
export async function getToolInputContract(toolName) {
  const toolContract = await getToolContract(toolName);
  return toolContract?.input ?? {};
}

// Helper para obtener el contrato de output de una herramienta específica.
export async function getToolOutputContract(toolName) {
  const toolContract = await getToolContract(toolName);
  return toolContract?.output ?? {};
}


// Devuelve un objeto con valores por defecto del input.
export async function buildDefaultArgs(toolName) {
  const inputContract = await getToolInputContract(toolName);
  const runtimeConfig = await loadRuntimeConfig();
  const defaultWifiInterface =
    typeof runtimeConfig.default_wifi_interface === "string"
      ? runtimeConfig.default_wifi_interface.trim()
      : "";
  const defaultArgs = {};

  Object.entries(inputContract).forEach(([argName, argContract]) => {
    if (argName === "interface" && defaultWifiInterface !== "") {
      defaultArgs[argName] = defaultWifiInterface;
      return;
    }

    defaultArgs[argName] = argContract.default ?? null;
  });

  return defaultArgs;
}
