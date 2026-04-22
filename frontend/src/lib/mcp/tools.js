import {
  buildDefaultArgs,
  getToolContract,
  loadToolContracts,
} from "../contracts/contracts.js";
import { getMcpClient } from "./client.js";


// Función que normaliza la definición de una herramienta MCP combinando la información del MCP y 
// el contrato compartido.
function normalizeToolDefinition(mcpTool, contract, defaultArgs) {
  return {
    name: mcpTool.name,
    title: mcpTool.title ?? mcpTool.name,
    description: mcpTool.description ?? "",
    inputSchema: mcpTool.inputSchema ?? {},
    outputSchema: mcpTool.outputSchema ?? {},
    contract: contract ?? null,
    defaultArgs,
  };
}


// Función principal para descubrir las herramientas MCP disponibles, 
// que combina la información del MCP y el contrato compartido.
// Devuelve un array de objetos con la definición completa de cada herramienta MCP.
export async function discoverTools() {
  const client = getMcpClient();

  await loadToolContracts();
  const listToolsResult = await client.listTools();
  const tools = listToolsResult?.tools ?? [];

  return Promise.all(
    tools.map(async (tool) => {
      const contract = await getToolContract(tool.name);
      const defaultArgs = await buildDefaultArgs(tool.name);
      return normalizeToolDefinition(tool, contract, defaultArgs);
    }),
  );
}


// Devuelve la definición completa de una herramienta MCP específica por su nombre, o null si no se encuentra.
// Lo devuelve ya con la información combinada del MCP y el contrato compartido, 
// listo para ser utilizado en la UI o para ejecutar la herramienta.
export async function getToolDefinition(toolName) {
  const tools = await discoverTools();
  return tools.find((tool) => tool.name === toolName) ?? null;
}
