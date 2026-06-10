## Instalación y ejecución en Linux

La aplicación WIFITEST está pensada para ejecutarse en sistemas Linux comunes, especialmente distribuciones basadas en Arch, Debian/Ubuntu/Kali/Parrot, Fedora y openSUSE. No obstante, debido a diferencias entre repositorios, nombres de paquetes, versiones de librerías gráficas y controladores Wi-Fi, no se puede garantizar el funcionamiento exacto en todas las distribuciones. El instalador intenta adaptarse automáticamente al sistema detectado y preparar el entorno con la menor intervención manual posible.

El proceso básico de instalación consta de tres pasos. Primero se clona el repositorio:

```bash
git clone https://github.com/pabloagcontacto-cpu/wifitest
cd wifitest
```

Después se ejecuta el instalador:
```bash
./scripts/install-linux.sh
```

Finalmente, una vez terminada la instalación, la aplicación se lanza con:
```bash
./scripts/run-app.sh
```


El script de instalación detecta la distribución y el gestor de paquetes disponible, como pacman, apt, dnf o zypper. A partir de ello comprueba e instala, si el usuario lo autoriza, las dependencias necesarias para el backend MCP, el frontend Tauri, Redis o Valkey, herramientas Wi-Fi como aircrack-ng, iw y reaver, NetworkManager y las librerías gráficas requeridas. En sistemas donde Redis no esté disponible como paquete nativo, el instalador puede preparar un contenedor local con Docker o Podman para exponer Redis en 127.0.0.1:6379, sin necesidad de modificar el resto de la aplicación.

Durante la instalación también se detecta la interfaz Wi-Fi disponible. Si hay varias interfaces, el script permite al usuario seleccionar cuál desea utilizar. La aplicación no depende de que la interfaz se llame necesariamente \texttt{wlan0}; el nombre real detectado se guarda en la configuración local para que las herramientas lo usen automáticamente. Además, el instalador puede comprobar si la antena Wi-Fi es apta para las funcionalidades de auditoría: intenta ponerla en modo monitor, realizar una captura breve de paquetes y restaurarla posteriormente a modo gestionado. Para utilizar correctamente la aplicación es necesario disponer de una antena Wi-Fi compatible con modo monitor e inyección o captura de tráfico, ya que algunas funcionalidades dependen de esa capacidad. En caso de utilizar una máquina virtual y disponer de una antena wifi USB, lo recomendable es, una vez iniciada la máquina virtual, conectar por USB la antena WIFI y elegir como opción que se conecte directamente a la máquina virtual y no al host. Por otra parte, en ciertas antenas WiFi y dependiendo de la distribución utilizada puede ser necesario instalar manualmente los drivers específicos de la antena que permitan ponerla en modo monitor y, de esta manera, poder utilizar la aplicación.

Otra parte importante del instalador es la configuración opcional de Cloudflare Tunnel mediante \texttt{cloudflared}. El dashboard y las herramientas locales pueden utilizarse sin túnel, pero el chat con OpenAI y herramientas MCP necesita que OpenAI pueda acceder al servidor MCP mediante una URL pública HTTPS. Para ello se requiere tener una cuenta de Cloudflare y un dominio o subdominio comprado y gestionado en Cloudflare. El script pregunta al usuario si quiere configurar esta parte; si responde afirmativamente, guía el inicio de sesión con Cloudflare, pide un nombre para el túnel y un hostname público, crea o reutiliza el túnel, configura la ruta DNS y genera el archivo local de configuración de \texttt{cloudflared}. Para una demo rápida, una instalación local o una prueba de las funcionalidades manuales, puede ser más sencillo no configurar Cloudflare y probar las funcionalidades de manera normal desde el \textit{dashboard}, sin utilizar el chat.

Por otro lado, este script de instalación ofrece al usuario la posibilidad de configurar la clave API de OpenAI para que se pueda utilizar el Chat. De nuevo, si únicamente se quiere probar las funcionalidades de la aplicación, se puede saltar esta parte y no utilizar el chat.

El script también prepara los entornos Python del backend MCP y del servicio de chat, instala las dependencias de Node del frontend y genera ficheros de configuración locales como \texttt{backend/MCP/.env}, \texttt{chat\_service/.env} y \texttt{config/local.json}. Estos ficheros contienen valores específicos de la máquina, como la interfaz Wi-Fi seleccionada, la configuración de Redis, la URL pública del MCP o la clave de OpenAI si el usuario decide guardarla. Por seguridad, estos archivos no forman parte del repositorio.

El script de arranque [`scripts/run-app.sh`](scripts/run-app.sh) se encarga de lanzar la aplicación completa. Si existe un binario Tauri compilado, arranca la interfaz de escritorio directamente. Si no existe, ofrece compilarlo. En sistemas donde no sea posible compilar Tauri por falta de librerías gráficas nativas (en las pruebas sucedió únicamente en Parrot OS), también se contempla el modo web, que sirve la misma interfaz desde un servidor local y permite usar la aplicación desde el navegador. Además, el arranque levanta Redis si es necesario, inicia el worker MCP, el servidor MCP, el servicio de chat, el worker de chat y, si está configurado, el túnel de Cloudflare.

Si no se quiere hacer la instalación manual de la aplicación, se ha publicado un vídeo en el propio repositorio llamado [`Demo.mp4`](Demo.mp4) en el que se muestra en detalle el funcionamiento completo de la aplicación.


