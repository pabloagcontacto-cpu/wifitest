# WIFITEST Frontend

Base inicial del frontend de escritorio de `WIFITEST` con Tauri y frontend web en HTML, CSS y JavaScript vanilla.

## Que hay aqui

- `src/`: interfaz web que renderiza dentro de la ventana de escritorio
- `src-tauri/`: shell nativa de Tauri escrita en Rust

## Arranque local

```bash
cd /home/pablo/Documentos/Proyectos/TFM/wifitest/frontend
npm install
npm run dev
```

## Scripts utiles

- `npm run dev`: arranque normal de Tauri
- `npm run dev:x11`: fuerza backend GTK sobre X11/XWayland
- `npm run dev:safe`: modo recomendado para tu entorno actual con Nvidia + Hyprland
- `npm run build`: build normal
- `npm run build:x11`: build forzando X11
- `npm run build:safe`: build usando el mismo perfil seguro del modo desarrollo

En tu maquina principal, el comando estable ahora mismo es:

```bash
npm run dev:safe
```

En una VM normal con Ubuntu o Kali, probablemente podras usar directamente:

```bash
npm run dev
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
