use std::fs;
use std::path::PathBuf;

#[tauri::command]
fn read_tool_contracts() -> Result<serde_json::Value, String> {
    let contracts_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("contracts")
        .join("tools.json");

    let raw_contracts = fs::read_to_string(&contracts_path).map_err(|error| {
        format!(
            "No se pudo leer el fichero de contratos en {}: {}",
            contracts_path.display(),
            error
        )
    })?;

    serde_json::from_str(&raw_contracts).map_err(|error| {
        format!(
            "No se pudo parsear el fichero de contratos en {}: {}",
            contracts_path.display(),
            error
        )
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_tool_contracts])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
