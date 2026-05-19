import { executeTool, stopAllPolling, stopPolling } from "./lib/mcp/jobs.js";
import {
  clearApplicationState,
  clearTargetNetwork,
  getState,
  setTargetNetwork,
  setTools,
  subscribe,
  updateTargetNetwork,
} from "./lib/mcp/store.js";
import { computeTargetSecurityScore } from "./lib/security/scoring.js";
import { discoverTools } from "./lib/mcp/tools.js";

window.addEventListener("DOMContentLoaded", () => {
  const badge = document.querySelector("#runtime-badge");
  const navTabs = [...document.querySelectorAll(".nav-tab")];
  const panels = [...document.querySelectorAll(".view-panel")];
  const viewTitle = document.querySelector("#view-title");
  const targetNetworkPanel = document.querySelector("#target-network-panel");
  const dashboardHero = document.querySelector("#dashboard-hero");
  const dashboardModeTabs = document.querySelector("#dashboard-mode-tabs");
  const dashboardTopGrid = document.querySelector("#dashboard-top-grid");
  const toolsList = document.querySelector("#tools-list");
  const toolsStatusText = document.querySelector("#tools-status-text");
  const scanNetworksFeature = document.querySelector("#scan-networks-feature");
  const jobsList = document.querySelector("#jobs-list");
  const resultViewer = document.querySelector("#result-viewer");
  const workspaceContent = document.querySelector("#workspace-content");
  const dashboardResultCard = document.querySelector("#dashboard-result-card");
  const activeJobsMetric = document.querySelector("#metric-active-jobs");
  const securityScoreMetric = document.querySelector("#metric-security-score");
  const securityCoverageMetric = document.querySelector("#metric-security-coverage");
  const toolsCountMetric = document.querySelector("#metric-tools-count");
  const isTauriRuntime = Boolean(window.__TAURI__);

  const uiState = {
    selectedJobId: null,
    formValuesByTool: {},
    toolDiscoveryError: null,
    dashboardConnectionView: null,
    showConnectForm: false,
  };

  badge.textContent = isTauriRuntime
    ? "Runtime Tauri activo"
    : "Vista web cargada";

  function activateView(viewName) {
    navTabs.forEach((tab) => {
      const isActive = tab.dataset.view === viewName;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });

    panels.forEach((panel) => {
      const isVisible = panel.dataset.panel === viewName;
      panel.classList.toggle("is-visible", isVisible);
    });

    const activeTab = navTabs.find((tab) => tab.dataset.view === viewName);
    if (activeTab && viewTitle) {
      viewTitle.textContent =
        activeTab.querySelector("strong")?.textContent ?? "WIFITEST";
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getFormValuesForTool(tool) {
    if (!tool) {
      return {};
    }

    if (!uiState.formValuesByTool[tool.name]) {
      uiState.formValuesByTool[tool.name] = { ...tool.defaultArgs };
    }

    return uiState.formValuesByTool[tool.name];
  }

  function getLatestScanNetworksJob(state) {
    return getLatestJobByTool(state, "scan_wifi_networks");
  }

  function getToolExecutionState(state, toolName) {
    const latestJob = getLatestJobByTool(state, toolName);
    const isRunning = latestJob?.status === "running" || latestJob?.status === "queued";
    return {
      latestJob,
      isRunning,
    };
  }

  function getLoadingButtonClass(isLoading, baseClass = "primary-action") {
    return `${baseClass} ${isLoading ? "is-loading" : ""}`.trim();
  }

  function getLoadingButtonAttrs(isLoading, loadingLabel) {
    if (!isLoading) {
      return "";
    }
    return `disabled aria-busy="true" data-loading-label="${escapeHtml(loadingLabel)}"`;
  }

  function getLatestJobByTool(state, toolName) {
    const jobs = Object.values(state.jobs)
      .filter((job) => job.toolName === toolName)
      .sort((left, right) => {
        const leftTime = new Date(left.submittedAt ?? 0).getTime();
        const rightTime = new Date(right.submittedAt ?? 0).getTime();
        return rightTime - leftTime;
      });

    if (!jobs.length) {
      return null;
    }

    const selectedJob = uiState.selectedJobId ? state.jobs[uiState.selectedJobId] : null;
    if (selectedJob?.toolName === toolName) {
      return selectedJob;
    }

    return jobs[0];
  }

  function getTargetContext(state) {
    const targetNetwork = state.targetNetwork;
    const selectedNetwork = targetNetwork?.selectedNetwork ?? null;
    const scanResult = targetNetwork?.scanResult ?? null;
    const scanNormalized = scanResult?.normalized ?? {};
    const profile = targetNetwork?.profile ?? null;
    const profileNormalized = profile?.normalized ?? {};
    const routerProfile = targetNetwork?.routerProfile ?? null;
    const routerProfileNormalized = routerProfile?.normalized ?? {};
    const relatedNetworks = targetNetwork?.relatedNetworks ?? [];
    const profileNetworks = profileNormalized.networks ?? [];

    const networksByBssid = new Map();
    [...relatedNetworks, ...profileNetworks].forEach((network) => {
      if (!network?.bssid) {
        return;
      }
      networksByBssid.set(network.bssid, {
        ...networksByBssid.get(network.bssid),
        ...network,
      });
    });

    const fallbackNetworks = relatedNetworks.length > 0
      ? relatedNetworks
      : selectedNetwork
        ? [selectedNetwork]
        : [];
    const activeNetworks = networksByBssid.size > 0
      ? [...networksByBssid.values()]
      : fallbackNetworks;
    const primaryNetwork = activeNetworks.length > 0
      ? [...activeNetworks].sort((left, right) => {
          const leftSignal = Number(left?.signal ?? -999);
          const rightSignal = Number(right?.signal ?? -999);
          return rightSignal - leftSignal;
        })[0]
      : selectedNetwork;

    return {
      targetNetwork,
      selectedNetwork,
      relatedNetworks,
      profile,
      routerProfile,
      profileNetworks,
      activeNetworks,
      primaryNetwork,
      scanResult,
      interface:
        targetNetwork?.interface ??
        routerProfileNormalized.resolved_interface ??
        routerProfileNormalized.interface ??
        profileNormalized.interface ??
        scanNormalized.interface ??
        null,
      targetBssids:
        Array.from(
          new Set(
            [
              ...(profileNormalized.known_bssids ?? []),
              ...activeNetworks.map((network) => network.bssid).filter(Boolean),
            ],
          ),
        ),
      bandsSeen: Array.from(
        new Set(
          activeNetworks
            .map((network) => network.frequency_band)
            .filter(Boolean),
        ),
      ).sort(),
      channelsSeen: Array.from(
        new Set(
          activeNetworks
            .map((network) => network.channel)
            .filter((value) => value !== null && value !== undefined),
        ),
      ).sort((left, right) => Number(left) - Number(right)),
      targetSsid:
        targetNetwork?.targetSsid ??
        profileNormalized.target_ssid ??
        selectedNetwork?.ssid ??
        null,
      connection: targetNetwork?.connection ?? null,
    };
  }

  function getConnectionBadge(connection) {
    if (!connection) {
      return { tone: "muted", label: "No conectado" };
    }
    if (connection.connected && connection.matchesExpectedTarget) {
      return { tone: "good", label: "Conectado a la red fijada" };
    }
    if (connection.connected) {
      return { tone: "medium", label: "Conectado a otra red" };
    }
    return { tone: "muted", label: "No conectado" };
  }

  function formatSecurityScore(scoreData) {
    if (!scoreData) {
      return "-";
    }
    return `${scoreData.score.toFixed(1)} / ${scoreData.scoreMax}`;
  }

  function renderSecurityScoreSection(scoreData, title = "Resumen de seguridad global") {
    if (!scoreData) {
      return "";
    }

    const findingsMarkup = scoreData.findings.length > 0
      ? scoreData.findings.slice(0, 3).map((finding) => `<li>${escapeHtml(`${finding.title}: ${finding.summary}`)}</li>`).join("")
      : `<li>No se han detectado hallazgos graves en los factores ya revisados.</li>`;

    const positivesMarkup = scoreData.positiveSignals.length > 0
      ? scoreData.positiveSignals.slice(0, 3).map((item) => `<li>${escapeHtml(`${item.title}: ${item.summary}`)}</li>`).join("")
      : `<li>Todavia no hay suficientes señales positivas confirmadas para destacarlas.</li>`;

    const pendingMarkup = scoreData.pendingChecks.length > 0
      ? scoreData.pendingChecks.slice(0, 4).map((item) => `<li>${escapeHtml(item.summary)}</li>`).join("")
      : `<li>No quedan comprobaciones pendientes dentro del motor actual.</li>`;

    const recommendationsMarkup = scoreData.recommendations.length > 0
      ? scoreData.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
      : `<li>La red ya tiene una base razonable en los factores revisados.</li>`;

    return `
      <section class="profile-panel">
        <div class="feature-subheading">
          <h4>${escapeHtml(title)}</h4>
          <span class="signal-pill signal-pill--${escapeHtml(scoreData.tone)}">${escapeHtml(scoreData.headline)}</span>
        </div>
        <div class="security-assessment-layout">
          <div class="security-assessment-grid">
            <article class="profile-highlight-card">
              <span>Puntuacion</span>
              <strong>${escapeHtml(formatSecurityScore(scoreData))}</strong>
              <small>${escapeHtml(scoreData.isProvisional ? "Resultado provisional" : "Resultado consolidado")}</small>
            </article>
            <article class="profile-highlight-card">
              <span>Cobertura</span>
              <strong>${escapeHtml(`${scoreData.coveragePercent}%`)}</strong>
              <small>${escapeHtml(`${scoreData.assessedRulesCount} de ${scoreData.totalRulesCount} factores evaluados`)}</small>
            </article>
          </div>
          <div class="security-assessment-summary">
            <p>${escapeHtml(scoreData.summary)}</p>
            <p>${escapeHtml(scoreData.updatedAt ? `Ultima actualizacion considerada: ${new Date(scoreData.updatedAt).toLocaleString("es-ES")}` : "Todavia no hay una referencia temporal consolidada para esta puntuacion.")}</p>
          </div>
          <div class="security-assessment-grid">
            <article class="profile-highlight-card">
              <span>Factores que mas bajan la nota</span>
              <ul class="assessment-list">
                ${findingsMarkup}
              </ul>
            </article>
            <article class="profile-highlight-card">
              <span>Senales favorables</span>
              <ul class="assessment-list">
                ${positivesMarkup}
              </ul>
            </article>
          </div>
          <div class="security-assessment-grid">
            <article class="profile-highlight-card">
              <span>Pruebas pendientes</span>
              <ul class="assessment-list">
                ${pendingMarkup}
              </ul>
            </article>
            <article class="profile-highlight-card">
              <span>Siguientes pasos</span>
              <ul class="assessment-list">
                ${recommendationsMarkup}
              </ul>
            </article>
          </div>
        </div>
      </section>
    `;
  }

  function getSignalTone(signal) {
    const signalValue = Number(signal);

    if (!Number.isFinite(signalValue) || signalValue === -1) {
      return "muted";
    }
    if (signalValue >= -55) {
      return "good";
    }
    if (signalValue >= -72) {
      return "medium";
    }
    return "bad";
  }

  function getSignalLabel(signal) {
    const signalValue = Number(signal);
    if (!Number.isFinite(signalValue) || signalValue === -1) {
      return "Desconocida";
    }
    return `${signalValue} dBm`;
  }

  function getSecurityTone(security) {
    const normalizedSecurity = String(security ?? "").toUpperCase();

    if (normalizedSecurity.includes("WPA3")) {
      return "good";
    }
    if (normalizedSecurity.includes("WPA2")) {
      return "medium";
    }
    if (normalizedSecurity.includes("WPA") || normalizedSecurity.includes("WEP")) {
      return "bad";
    }
    if (normalizedSecurity.includes("OPEN") || normalizedSecurity.includes("UNKNOWN")) {
      return "bad";
    }
    return "muted";
  }

  function getSecurityLabel(network) {
    const security = String(network?.security ?? "").toUpperCase();

    if (security === "WPA3") {
      return "Seguridad fuerte";
    }
    if (security === "WPA2") {
      return "Seguridad aceptable";
    }
    if (security === "WPA/WPA2") {
      return "Seguridad mixta";
    }
    if (security === "WPA") {
      return "Seguridad antigua";
    }
    if (security === "WEP") {
      return "Seguridad insegura";
    }
    if (security === "OPEN") {
      return "Sin protección";
    }
    return "Seguridad desconocida";
  }

  function getSignalAssessment(signal) {
    const tone = getSignalTone(signal);

    if (tone === "good") {
      return "Señal muy buena";
    }
    if (tone === "medium") {
      return "Señal media";
    }
    if (tone === "bad") {
      return "Señal débil";
    }
    return "Señal desconocida";
  }

  function getAdminAuthHeadline(adminAuth) {
    if (!adminAuth || adminAuth.auth_required == null) {
      return "No determinado";
    }
    if (!adminAuth.auth_required) {
      return "Sin autenticacion aparente";
    }
    if (adminAuth.auth_type === "password_only") {
      return "Panel con solo contrasena";
    }
    if (adminAuth.auth_type === "username_password") {
      return "Panel con usuario y contrasena";
    }
    if (adminAuth.auth_type === "http_auth") {
      return "Autenticacion HTTP";
    }
    return "Autenticacion requerida";
  }

  function getAdminAuthTone(adminAuth) {
    if (!adminAuth || adminAuth.auth_required == null) {
      return "muted";
    }
    return adminAuth.auth_required ? "medium" : "bad";
  }

  function formatAdminAuthEvidence(adminAuth) {
    const evidence = adminAuth?.evidence ?? [];
    if (!evidence.length) {
      return "Sin evidencias concretas";
    }

    const labels = {
      password_field: "campo de contrasena",
      username_hint: "campo de usuario",
      login_form: "formulario de acceso",
      www_authenticate_header: "cabecera WWW-Authenticate",
    };

    return evidence.map((item) => labels[item] ?? item).join(", ");
  }

  function assessUpnpRisk(upnpResult) {
    if (!upnpResult?.normalized) {
      return {
        tone: "muted",
        headline: "Sin analisis UPnP",
        summary: "Todavia no se ha ejecutado la comprobacion UPnP sobre el router conectado.",
        recommendations: [
          "Lanza la comprobacion para saber si el router permite servicios UPnP dentro de la red local.",
        ],
      };
    }

    const normalized = upnpResult.normalized;
    if (!normalized.upnp_detected) {
      return {
        tone: "good",
        headline: "No detectado",
        summary: "No se han observado respuestas UPnP/SSDP del router durante la comprobacion actual.",
        recommendations: [
          "Si realmente no se utiliza, este resultado es positivo porque reduce una superficie de exposicion innecesaria.",
          "Si quieres mas certeza, puedes repetir la comprobacion mas adelante tras reiniciar el router o revisar manualmente el panel de administracion.",
        ],
      };
    }

    if (normalized.port_mapping_capable || normalized.wan_ip_connection_service) {
      return {
        tone: "bad",
        headline: "UPnP activo con riesgo",
        summary: "El router parece exponer servicios UPnP/IGD que podrian facilitar aperturas automaticas de puertos desde dispositivos internos.",
        recommendations: [
          "Si no se utiliza y no es necesario, seria recomendable desactivarlo.",
          "Revisar si algun dispositivo del negocio depende realmente de UPnP antes de tocarlo.",
        ],
      };
    }

    return {
      tone: "medium",
      headline: "UPnP detectado",
      summary: "Se ha visto actividad o identificacion UPnP, aunque todavia no hay evidencia fuerte de capacidades de mapeo de puertos.",
      recommendations: [
        "Conviene revisar el panel del router para confirmar si UPnP esta habilitado.",
      ],
    };
  }

  function assessManagementServicesRisk(servicesResult) {
    if (!servicesResult?.normalized) {
        return {
          tone: "muted",
          headline: "Sin analisis",
          summary: "Todavia no se han evaluado los servicios de administracion del router conectado.",
          recommendations: [
          "Lanza esta comprobacion para detectar panel web, SSH, Telnet, FTP, SNMP, TR-069 y otros puertos tipicos de gestion.",
        ],
      };
    }

    const normalized = servicesResult.normalized;
    if (normalized.services_detected_count === 0) {
      return {
        tone: "good",
        headline: "Exposicion baja",
        summary: "No se han detectado servicios tipicos de administracion abiertos en los puertos revisados durante esta comprobacion.",
        recommendations: normalized.recommendations ?? [],
      };
    }

    if (normalized.telnet_detected) {
      return {
        tone: "bad",
        headline: "Servicio sensible detectado",
        summary: "Se ha detectado Telnet, que suele considerarse una mala practica por ser un protocolo antiguo y sin cifrado.",
        recommendations: normalized.recommendations ?? [],
      };
    }

    if (normalized.web_admin_detected || normalized.ssh_detected) {
      return {
        tone: "medium",
        headline: "Servicios de gestion activos",
        summary: "El router expone servicios de administracion accesibles desde la red local. No es necesariamente malo, pero conviene revisar cuales son realmente necesarios.",
        recommendations: normalized.recommendations ?? [],
      };
    }

    return {
      tone: "muted",
      headline: "Exposicion limitada",
      summary: "Se ha detectado alguna superficie de gestion, pero no parece especialmente amplia en esta primera revision.",
      recommendations: normalized.recommendations ?? [],
    };
  }

  function getClientsAssessment(clientsCount) {
    const count = Number(clientsCount ?? 0);

    if (count <= 0) {
      return "Sin clientes observados";
    }
    if (count === 1) {
      return "1 cliente observado";
    }
    return `${count} clientes observados`;
  }

  function getBeaconAssessment(beaconsCount) {
    const count = Number(beaconsCount ?? 0);

    if (count <= 0) {
      return "Sin beacons detectados";
    }
    if (count < 5) {
      return "Actividad baja";
    }
    if (count < 15) {
      return "Actividad estable";
    }
    return "Actividad alta";
  }

  function getBandTone(frequencyBand) {
    if (String(frequencyBand) === "5") {
      return "good";
    }
    if (String(frequencyBand) === "2.4") {
      return "medium";
    }
    return "muted";
  }

  function getVisibilityTone(isHidden) {
    return isHidden ? "medium" : "good";
  }

  function getVisibilityLabel(isHidden) {
    return isHidden ? "SSID oculto" : "SSID visible";
  }

  function assessSecurityProfile(network) {
    const security = String(network?.security ?? "").toUpperCase();
    const privacy = String(network?.privacy ?? "").toUpperCase();
    const cipher = String(network?.cipher ?? "").toUpperCase();
    const auth = String(network?.auth ?? "").toUpperCase();
    const commonExplanations = {
      protocol:
        "El protocolo de seguridad es la familia principal de protección que usa la red Wi‑Fi para controlar cómo se conectan los dispositivos y cómo se protege el acceso.",
      privacy:
        "El campo privacy resume lo que la red anuncia sobre su protección general. Suele indicar si la red está abierta o si utiliza tecnologías como WPA2 o WPA3.",
      cipher:
        "El cipher indica cómo se cifra el tráfico una vez dentro de la red. En general, CCMP/AES se considera una opción moderna y preferible frente a alternativas antiguas.",
      auth:
        "La autenticación describe cómo demuestran los dispositivos que tienen permiso para entrar. En una red doméstica o de comercio suele aparecer PSK, que significa clave compartida.",
    };

    const buildFieldAssessment = (label, value, tone, explanation, assessment) => ({
      label,
      value: value || "Sin dato",
      tone,
      explanation,
      assessment,
    });

    let tone = "muted";
    let headline = "Perfil por revisar";
    let summary = "La red anuncia un perfil de seguridad que conviene revisar con detalle para entender su nivel real de protección.";
    let recommendations = [
      "Actualizar el perfil de la red para confirmar la configuración observada.",
      "Revisar manualmente el router si ves valores extraños o poco consistentes.",
    ];

    if (security === "WPA3") {
      tone = "good";
      headline = "Protocolo fuerte";
      summary = "La red anuncia WPA3, una opción moderna y sólida para proteger el acceso Wi‑Fi.";
      recommendations = [
        "Mantener WPA3 si todos los dispositivos son compatibles.",
        "Evitar activar compatibilidad heredada si no hace falta.",
      ];
    } else if (security === "WPA2") {
      tone = "medium";
      headline = "Protocolo aceptable";
      summary = "La red anuncia WPA2, que sigue siendo una opción válida, aunque ya no es la más moderna.";
      recommendations = [
        "Mantener WPA2 con CCMP/AES y evitar opciones antiguas.",
        "Valorar WPA3 si el router y los clientes lo soportan.",
      ];
    } else if (security === "WPA/WPA2") {
      tone = "medium";
      headline = "Modo mixto";
      summary = "La red parece combinar compatibilidad antigua y moderna. Eso puede ser útil, pero también amplia la superficie heredada.";
      recommendations = [
        "Desactivar modos heredados si ya no son necesarios.",
        "Intentar dejar la red en WPA2 o WPA3 según compatibilidad.",
      ];
    } else if (security === "WPA") {
      tone = "bad";
      headline = "Protocolo antiguo";
      summary = "La red anuncia WPA, una opción heredada que conviene sustituir por WPA2 o WPA3.";
      recommendations = [
        "Migrar al menos a WPA2.",
        "Comprobar si algún dispositivo antiguo está forzando esta compatibilidad.",
      ];
    } else if (security === "WEP") {
      tone = "bad";
      headline = "Protocolo inseguro";
      summary = "La red anuncia WEP, una configuración obsoleta que ya no se considera segura.";
      recommendations = [
        "Cambiar cuanto antes a WPA2 o WPA3.",
        "Revisar si hay equipos muy antiguos condicionando la configuración.",
      ];
    } else if (security === "OPEN") {
      tone = "bad";
      headline = "Sin protección";
      summary = "La red parece abierta y no anuncia una barrera clara de acceso.";
      recommendations = [
        "Activar WPA2 o WPA3 cuanto antes.",
        "Evitar usar redes abiertas para un entorno privado o de negocio.",
      ];
    }

    const protocolAssessment =
      tone === "good"
        ? "La red usa un protocolo moderno."
        : tone === "medium"
          ? "La red usa un protocolo razonable, aunque no es el más moderno."
          : tone === "bad"
            ? "La red usa un protocolo antiguo o claramente inseguro."
            : "El protocolo observado no permite una conclusión clara todavía.";

    const privacyTone =
      privacy.includes("WPA3") || privacy.includes("WPA2")
        ? "good"
        : privacy.includes("WPA")
          ? "medium"
          : privacy.includes("WEP") || privacy.includes("OPEN") || privacy === ""
            ? "bad"
            : "muted";

    const cipherTone =
      cipher.includes("CCMP")
        ? "good"
        : cipher.includes("TKIP")
          ? "bad"
          : cipher === ""
            ? "muted"
            : "medium";

    const authTone =
      auth.includes("PSK") || auth.includes("SAE")
        ? "good"
        : auth === ""
          ? "muted"
          : "medium";

    return {
      tone,
      headline,
      summary,
      recommendations,
      fields: [
        buildFieldAssessment(
          "Protocolo",
          security,
          tone,
          commonExplanations.protocol,
          protocolAssessment,
        ),
        buildFieldAssessment(
          "Cipher",
          cipher,
          cipherTone,
          commonExplanations.cipher,
          cipherTone === "good"
            ? "El cifrado observado encaja con una configuración actual."
            : cipherTone === "bad"
              ? "El cifrado observado apunta a una opción antigua o menos recomendable."
              : "No hay suficiente información o el valor necesita contexto adicional.",
        ),
        buildFieldAssessment(
          "Autenticación",
          auth,
          authTone,
          commonExplanations.auth,
          authTone === "good"
            ? "La forma de autenticación observada es la habitual en redes privadas actuales."
            : authTone === "muted"
              ? "No hay suficiente información sobre cómo valida el acceso la red."
              : "La autenticación observada requiere revisión para entender bien su solidez.",
        ),
      ],
    };
  }

  function assessWpsRisk(wpsResult) {
    const normalized = wpsResult?.normalized ?? null;
    const detected = Boolean(normalized?.wps_detected);
    const locked = Boolean(normalized?.wps_locked);
    const version = normalized?.wps_version || "Sin dato";
    const vendor = normalized?.vendor || "Sin dato";
    const channel = normalized?.channel ?? "Sin dato";

    const buildFieldAssessment = (label, value, tone, explanation, assessment) => ({
      label,
      value: String(value || "Sin dato"),
      tone,
      explanation,
      assessment,
    });

    if (!normalized) {
      return {
        tone: "muted",
        headline: "Pendiente de analisis",
        summary:
          "Todavia no hay una comprobacion WPS guardada para esta red. Primero hay que ejecutar el analisis de exposicion WPS.",
        recommendations: [
          "Lanzar la comprobacion WPS para saber si esta funcion esta anunciada por la red.",
          "Guardar el resultado como referencia inicial antes de seguir con otras pruebas.",
          "Si no se utiliza y no es necesaria, lo recomendable es mantener esta funcion desactivada.",
        ],
        fields: [
          buildFieldAssessment(
            "Estado WPS",
            "Sin analizar",
            "muted",
            "WPS es una funcion pensada para conectar dispositivos de forma rapida. Si esta activada, puede abrir una via de ataque innecesaria.",
            "Todavia no se puede valorar el riesgo porque no hay una medicion guardada.",
          ),
          buildFieldAssessment(
            "Bloqueo",
            "Sin analizar",
            "muted",
            "Algunos puntos de acceso intentan bloquear intentos repetidos sobre WPS. Ese bloqueo puede reducir riesgo, aunque no sustituye a desactivarlo.",
            "No hay datos todavia sobre si el router anuncia algun tipo de bloqueo.",
          ),
          buildFieldAssessment(
            "Cobertura observada",
            "Sin analizar",
            "muted",
            "Este campo resume si la comprobacion encontro informacion suficiente en la radio observada, como canal, fabricante o version WPS.",
            "Hace falta ejecutar el analisis para conocer el estado real de WPS.",
          ),
        ],
      };
    }

    let tone = "good";
    let headline = "Riesgo bajo por WPS";
    let summary =
      "No se ha detectado WPS en la red objetivo, asi que por ahora no aparece esta superficie de exposicion.";
    let recommendations = [
      "Mantener WPS desactivado en el router.",
      "Repetir la comprobacion si cambias configuraciones o firmware.",
      "Si no se utiliza y no es necesaria, lo recomendable es mantener esta funcion desactivada.",
    ];

    if (detected && locked) {
      tone = "medium";
      headline = "WPS presente con mitigacion parcial";
      summary =
        "La red anuncia WPS y eso ya merece atencion, aunque el punto de acceso parece indicar algun tipo de bloqueo frente a intentos repetidos.";
      recommendations = [
        "Desactivar WPS por completo si el router lo permite.",
        "No confiar solo en el bloqueo como medida de proteccion.",
        "Si no se utiliza y no es necesaria, lo recomendable es mantener esta funcion desactivada.",
      ];
    } else if (detected) {
      tone = "bad";
      headline = "WPS expuesto";
      summary =
        "La red anuncia WPS y eso incrementa el riesgo, porque añade un mecanismo adicional de acceso que normalmente no merece la pena mantener activo.";
      recommendations = [
        "Desactivar WPS en el router cuanto antes.",
        "Revisar si el firmware del router ofrece parches o mejoras para esta funcion.",
        "Si no se utiliza y no es necesaria, lo recomendable es desactivarla.",
      ];
    }

    return {
      tone,
      headline,
      summary,
      recommendations,
      fields: [
        buildFieldAssessment(
          "Estado WPS",
          detected ? `Detectado${version !== "Sin dato" ? ` (${version})` : ""}` : "No detectado",
          detected ? (locked ? "medium" : "bad") : "good",
          "WPS es una funcion pensada para conectar dispositivos de forma rapida. Si esta activada, puede abrir una via de ataque innecesaria.",
          detected
            ? "La red sigue anunciando WPS y conviene revisar si realmente lo necesitas."
            : "No se ha visto WPS en la comprobacion actual, lo que reduce esta superficie de exposicion.",
        ),
        buildFieldAssessment(
          "Bloqueo",
          detected ? (locked ? "Si" : "No") : "No aplica",
          detected ? (locked ? "medium" : "bad") : "good",
          "Algunos puntos de acceso intentan bloquear intentos repetidos sobre WPS. Ese bloqueo puede reducir riesgo, aunque no sustituye a desactivarlo.",
          detected
            ? locked
              ? "Existe una mitigacion parcial, pero sigue siendo preferible desactivar WPS."
              : "No se aprecia bloqueo y la exposicion es mas preocupante."
            : "Sin WPS visible, este aspecto no supone un riesgo activo.",
        ),
        buildFieldAssessment(
          "Cobertura observada",
          `${vendor} · Canal ${channel}`,
          detected ? "medium" : "good",
          "Este campo resume si la comprobacion encontro informacion suficiente en la radio observada, como canal, fabricante o version WPS.",
          detected
            ? "Se ha localizado una radio concreta que anuncia WPS y eso permite enfocar mejor la revision."
            : "La comprobacion no ha encontrado radios que anuncien WPS para la red objetivo.",
        ),
      ],
    };
  }

  function sumNetworkMetric(networks, metricName) {
    return networks.reduce((total, network) => {
      const value = Number(network?.[metricName] ?? 0);
      return Number.isFinite(value) ? total + value : total;
    }, 0);
  }

  function getBestSignalAcrossNetworks(networks) {
    const validSignals = networks
      .map((network) => Number(network?.signal))
      .filter((value) => Number.isFinite(value) && value !== -1);

    if (!validSignals.length) {
      return null;
    }

    return Math.max(...validSignals);
  }

  function syncTargetProfileFromJobs(state) {
    if (!state.targetNetwork) {
      return;
    }

    const latestProfileJob = getLatestJobByTool(state, "inspect_target_network_profile");
    if (
      latestProfileJob?.status !== "completed" ||
      !latestProfileJob.result?.normalized
    ) {
      return;
    }

    if (state.targetNetwork.profileSourceJobId === latestProfileJob.jobId) {
      return;
    }

    updateTargetNetwork({
      profile: latestProfileJob.result,
      profileSourceJobId: latestProfileJob.jobId,
      profileRefreshedAt: new Date().toISOString(),
    });
  }

  function syncTargetWpsFromJobs(state) {
    if (!state.targetNetwork) {
      return;
    }

    const latestWpsJob = getLatestJobByTool(state, "detect_wps_exposure");
    if (
      latestWpsJob?.status !== "completed" ||
      !latestWpsJob.result?.normalized
    ) {
      return;
    }

    if (state.targetNetwork.wpsSourceJobId === latestWpsJob.jobId) {
      return;
    }

    updateTargetNetwork({
      wps: latestWpsJob.result,
      wpsSourceJobId: latestWpsJob.jobId,
      wpsRefreshedAt: new Date().toISOString(),
    });
  }

  function syncTargetUpnpFromJobs(state) {
    if (!state.targetNetwork) {
      return;
    }

    const latestUpnpJob = getLatestJobByTool(state, "detect_upnp_exposure");
    if (
      latestUpnpJob?.status !== "completed" ||
      !latestUpnpJob.result?.normalized
    ) {
      return;
    }

    if (state.targetNetwork.upnpSourceJobId === latestUpnpJob.jobId) {
      return;
    }

    updateTargetNetwork({
      upnp: latestUpnpJob.result,
      upnpSourceJobId: latestUpnpJob.jobId,
      upnpRefreshedAt: new Date().toISOString(),
    });
  }

  function syncTargetManagementServicesFromJobs(state) {
    if (!state.targetNetwork) {
      return;
    }

    const latestManagementJob = getLatestJobByTool(state, "detect_management_services");
    if (
      latestManagementJob?.status !== "completed" ||
      !latestManagementJob.result?.normalized
    ) {
      return;
    }

    if (state.targetNetwork.managementServicesSourceJobId === latestManagementJob.jobId) {
      return;
    }

    updateTargetNetwork({
      managementServices: latestManagementJob.result,
      managementServicesSourceJobId: latestManagementJob.jobId,
      managementServicesRefreshedAt: new Date().toISOString(),
    });
  }

  function syncConnectionFromJobs(state) {
    if (!state.targetNetwork) {
      return;
    }

    const connectJob = getLatestJobByTool(state, "connect_to_target_network");
    const statusJob = getLatestJobByTool(state, "get_connection_status");
    const disconnectJob = getLatestJobByTool(state, "disconnect_from_network");
    const candidates = [connectJob, statusJob, disconnectJob]
      .filter((job) => job?.status === "completed" && job.result?.normalized)
      .sort((left, right) => {
        const leftTime = new Date(left.finishedAt ?? left.submittedAt ?? 0).getTime();
        const rightTime = new Date(right.finishedAt ?? right.submittedAt ?? 0).getTime();
        return rightTime - leftTime;
      });

    const latestConnectionJob = candidates[0];
    if (!latestConnectionJob) {
      return;
    }

    if (state.targetNetwork.connectionSourceJobId === latestConnectionJob.jobId) {
      return;
    }

    const normalized = latestConnectionJob.result.normalized;
    const isDisconnectJob = latestConnectionJob.toolName === "disconnect_from_network";
    updateTargetNetwork({
      connection: {
        connected: isDisconnectJob ? !normalized.disconnected : normalized.connected,
        activeSsid: normalized.active_ssid,
        activeBssid: normalized.active_bssid,
        matchesExpectedTarget: isDisconnectJob
          ? false
          : (normalized.matches_expected_target ?? normalized.connected),
        interface: normalized.resolved_interface ?? normalized.interface,
        ipv4: normalized.ipv4,
        gateway: normalized.gateway,
        dnsServers: normalized.dns_servers ?? [],
        lastCheckedAt: normalized.completed_at ?? new Date().toISOString(),
        sourceTool: latestConnectionJob.toolName,
      },
      connectionSourceJobId: latestConnectionJob.jobId,
    });
  }

  function syncRouterProfileFromJobs(state) {
    if (!state.targetNetwork) {
      return;
    }

    const latestRouterJob = getLatestJobByTool(state, "discover_gateway_and_router_profile");
    if (
      latestRouterJob?.status !== "completed" ||
      !latestRouterJob.result?.normalized
    ) {
      return;
    }

    if (state.targetNetwork.routerProfileSourceJobId === latestRouterJob.jobId) {
      return;
    }

    updateTargetNetwork({
      routerProfile: latestRouterJob.result,
      routerProfileSourceJobId: latestRouterJob.jobId,
      routerProfileRefreshedAt: new Date().toISOString(),
    });
  }

  function renderTargetNetworkPanel(state) {
    const targetContext = getTargetContext(state);
    const targetNetwork = targetContext.targetNetwork;

    if (!targetNetwork) {
      targetNetworkPanel.innerHTML = `
        <div class="target-network-panel__content">
          <div>
            <p class="section-tag">Red objetivo</p>
            <h3>Aun no has fijado ninguna red</h3>
            <p>Empieza lanzando un escaneo de redes disponibles y marca cual es tu red para continuar con la auditoria guiada.</p>
          </div>
          <div class="target-network-panel__status">
            <span class="pill">Sin objetivo</span>
          </div>
        </div>
      `;
      return;
    }

    const selectedNetwork = targetContext.primaryNetwork ?? targetNetwork.selectedNetwork ?? {};
    const radiosCount = targetContext.targetBssids.length;
    const connection = targetContext.connection;
    const connectionBadge = getConnectionBadge(connection);
    const checkConnectionState = getToolExecutionState(state, "get_connection_status");
    const connectState = getToolExecutionState(state, "connect_to_target_network");
    const disconnectState = getToolExecutionState(state, "disconnect_from_network");
    const connectionSummary = connection?.connected
      ? [
          connection.activeSsid ? `SSID activo ${connection.activeSsid}` : null,
          connection.ipv4 ? `IP ${connection.ipv4}` : null,
          connection.gateway ? `Gateway ${connection.gateway}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Todavia no hay una conexion confirmada a esta red.";

    const isConnectedToTarget = Boolean(connection?.connected && connection?.matchesExpectedTarget);

    targetNetworkPanel.innerHTML = `
      <div class="target-network-panel__content">
        <div>
          <p class="section-tag">Red objetivo</p>
          <h3>${escapeHtml(targetContext.targetSsid || selectedNetwork.ssid || "(Oculta)")}</h3>
          <p>${escapeHtml(radiosCount > 0 ? `${radiosCount} radio(s) detectados para esta red` : "Perfil basico guardado a partir del escaneo inicial")} · ${escapeHtml(selectedNetwork.bssid ? `BSSID principal ${selectedNetwork.bssid}` : "Sin BSSID principal")}</p>
          <p class="target-network-panel__connection">${escapeHtml(connectionSummary)}</p>
        </div>
        <div class="target-network-panel__status">
          <span class="pill">${escapeHtml(selectedNetwork.security ?? "Perfil guardado")}</span>
          <span class="signal-pill signal-pill--${escapeHtml(connectionBadge.tone)}">${escapeHtml(connectionBadge.label)}</span>
          <button
            id="check-connection-button"
            type="button"
            class="${escapeHtml(getLoadingButtonClass(checkConnectionState.isRunning, "secondary-action"))}"
            ${getLoadingButtonAttrs(checkConnectionState.isRunning, "Comprobando")}
          >
            Comprobar conexion
          </button>
          ${
            isConnectedToTarget
              ? `
                <button
                  id="disconnect-network-button"
                  type="button"
                  class="${escapeHtml(getLoadingButtonClass(disconnectState.isRunning, "danger-action"))}"
                  ${getLoadingButtonAttrs(disconnectState.isRunning, "Desconectando")}
                >
                  Desconectar
                </button>
              `
              : `
                <button
                  id="toggle-connect-form-button"
                  type="button"
                  class="${escapeHtml(getLoadingButtonClass(connectState.isRunning, "primary-action"))}"
                  ${connectState.isRunning ? getLoadingButtonAttrs(true, "Conectando") : ""}
                >
                  ${connectState.isRunning ? "Conectando" : (uiState.showConnectForm ? "Cancelar" : "Conectar")}
                </button>
              `
          }
          <button id="clear-target-network-button" type="button" class="secondary-action">Desfijar red</button>
        </div>
      </div>
      ${
        uiState.showConnectForm && !isConnectedToTarget
          ? `
            <form id="connect-target-network-form" class="target-network-connect-form">
              <label class="form-field">
                <span>Contrasena Wi-Fi</span>
                <input id="target-network-password" type="password" placeholder="Si la red es abierta, dejalo vacio" />
              </label>
              <div class="tool-form-actions">
                <button
                  type="submit"
                  class="primary-action"
                  ${connectState.isRunning ? "disabled" : ""}
                >
                  Intentar conexion
                </button>
              </div>
            </form>
          `
          : ""
      }
    `;

    const clearButton = document.querySelector("#clear-target-network-button");
    clearButton?.addEventListener("click", () => {
      clearTargetNetwork();
      uiState.showConnectForm = false;
      activateView("dashboard");
    });

    const toggleConnectFormButton = document.querySelector("#toggle-connect-form-button");
    toggleConnectFormButton?.addEventListener("click", () => {
      uiState.showConnectForm = !uiState.showConnectForm;
      renderDashboard(getState());
    });

    const disconnectNetworkButton = document.querySelector("#disconnect-network-button");
    disconnectNetworkButton?.addEventListener("click", async () => {
      try {
        const job = await executeTool("disconnect_from_network", {
          interface: targetContext.interface ?? "wlan0",
        });
        uiState.showConnectForm = false;
        uiState.selectedJobId = job.jobId;
        uiState.dashboardConnectionView = "not_connected";
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudo lanzar la desconexion Wi-Fi:", error);
      }
    });

    const checkConnectionButton = document.querySelector("#check-connection-button");
    checkConnectionButton?.addEventListener("click", async () => {
      try {
        const job = await executeTool("get_connection_status", {
          interface: targetContext.interface ?? "wlan0",
          expected_ssid: targetContext.targetSsid ?? "",
        });
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudo comprobar la conexion:", error);
      }
    });

    const connectForm = document.querySelector("#connect-target-network-form");
    connectForm?.addEventListener("submit", async (event) => {
      event.preventDefault();

      const passwordInput = document.querySelector("#target-network-password");
      const password = passwordInput?.value ?? "";

      try {
        const job = await executeTool("connect_to_target_network", {
          interface: targetContext.interface ?? "wlan0",
          ssid: targetContext.targetSsid ?? "",
          password,
        });
        uiState.showConnectForm = false;
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudo lanzar la conexion Wi-Fi:", error);
      }
    });
  }

  function renderToolsList(tools) {
    const state = getState();
    const hasTargetNetwork = Boolean(state.targetNetwork);
    const visibleTools = hasTargetNetwork
      ? tools.filter(
          (tool) =>
            tool.name !== "scan_wifi_networks" &&
            tool.name !== "inspect_target_network_profile" &&
            tool.name !== "detect_wps_exposure" &&
            tool.name !== "detect_upnp_exposure" &&
            tool.name !== "detect_management_services" &&
            tool.name !== "connect_to_target_network" &&
            tool.name !== "get_connection_status" &&
            tool.name !== "disconnect_from_network" &&
            tool.name !== "discover_gateway_and_router_profile",
        )
      : tools;

    if (!visibleTools.length) {
      toolsList.innerHTML = "";
      toolsStatusText.textContent = uiState.toolDiscoveryError
        ? `No se pudieron cargar las tools: ${uiState.toolDiscoveryError}`
        : "No hay tools disponibles en este momento.";
      return;
    }

    toolsStatusText.textContent =
      "Herramientas disponibles para construir funcionalidades dentro del dashboard.";

    toolsList.innerHTML = visibleTools
      .map((tool) => {
        const inputCount = Object.keys(tool.contract?.input ?? {}).length;
        return `
          <div class="tool-list-item tool-list-item--static">
            <span class="tool-list-title">${escapeHtml(tool.title)}</span>
            <span class="tool-list-meta">${inputCount} argumentos · ${escapeHtml(tool.name)}</span>
          </div>
        `;
      })
      .join("");
  }

  function buildScanFieldsMarkup(tool) {
    const formValues = getFormValuesForTool(tool);
    const inputContract = tool.contract?.input ?? {};

    return Object.entries(inputContract)
      .map(([argName, argContract]) => {
        const currentValue = formValues[argName] ?? "";
        const label = escapeHtml(argName);

        if (argContract.mode === "fixed") {
          const options = (argContract.allowed_values ?? [])
            .map((value) => {
              const isSelected = String(value) === String(currentValue);
              return `<option value="${escapeHtml(value)}" ${isSelected ? "selected" : ""}>${escapeHtml(value)}</option>`;
            })
            .join("");

          return `
            <label class="form-field">
              <span>${label}</span>
              <select data-tool-arg="${escapeHtml(argName)}">
                ${options}
              </select>
            </label>
          `;
        }

        return `
          <label class="form-field">
            <span>${label}</span>
            <input data-tool-arg="${escapeHtml(argName)}" type="text" value="${escapeHtml(currentValue)}" />
          </label>
        `;
      })
      .join("");
  }

  function renderNetworksTable(networks, options = {}) {
    const {
      compact = false,
      showFixAction = false,
      targetBssid = null,
    } = options;

    if (!networks.length) {
      return `
        <div class="empty-state">
          <p>Todavia no hay redes cargadas. Lanza un escaneo para ver los resultados aqui.</p>
        </div>
      `;
    }

    if (compact) {
      return `
        <div class="networks-table-wrap">
          <table class="networks-table networks-table--compact">
            <thead>
              <tr>
                <th>SSID</th>
                <th>BSSID</th>
                <th>Senal</th>
                ${showFixAction ? "<th>Accion</th>" : ""}
              </tr>
            </thead>
            <tbody>
              ${networks
                .map((network) => {
                  const isTarget = targetBssid && network.bssid === targetBssid;
                  const signalTone = getSignalTone(network.signal);
                  return `
                    <tr class="${isTarget ? "is-target-row" : ""}">
                      <td>${escapeHtml(network.ssid || "(Oculta)")}</td>
                      <td>${escapeHtml(network.bssid ?? "-")}</td>
                      <td>
                        <span class="signal-pill signal-pill--${escapeHtml(signalTone)}">
                          ${escapeHtml(getSignalLabel(network.signal))}
                        </span>
                      </td>
                      ${
                        showFixAction
                          ? `
                            <td>
                              <button
                                type="button"
                                class="inline-action"
                                data-fix-network-bssid="${escapeHtml(network.bssid ?? "")}"
                              >
                                Fijar red
                              </button>
                            </td>
                          `
                          : ""
                      }
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      `;
    }

    return `
      <div class="networks-table-wrap">
        <table class="networks-table">
          <thead>
            <tr>
              <th>SSID</th>
              <th>BSSID</th>
              <th>Canal</th>
              <th>Banda</th>
              <th>Senal</th>
              <th>Seguridad</th>
              <th>Privacy</th>
              <th>Cipher</th>
              <th>Auth</th>
              <th>Beacons</th>
              <th>Clientes</th>
            </tr>
          </thead>
          <tbody>
            ${networks
              .map((network) => `
                <tr class="${targetBssid && network.bssid === targetBssid ? "is-target-row" : ""}">
                  <td>${escapeHtml(network.ssid || "(Oculta)")}</td>
                  <td>${escapeHtml(network.bssid ?? "-")}</td>
                  <td>${escapeHtml(network.channel ?? "-")}</td>
                  <td>${escapeHtml(network.frequency_band ?? "-")}</td>
                  <td>${escapeHtml(network.signal ?? "-")}</td>
                  <td>${escapeHtml(network.security ?? "-")}</td>
                  <td>${escapeHtml(network.privacy ?? "-")}</td>
                  <td>${escapeHtml(network.cipher ?? "-")}</td>
                  <td>${escapeHtml(network.auth ?? "-")}</td>
                  <td>${escapeHtml(network.beacons ?? "-")}</td>
                  <td>${escapeHtml(network.clients_count ?? 0)}</td>
                </tr>
              `)
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderTargetNetworkInfoFeature(state) {
    const targetContext = getTargetContext(state);
    const targetNetwork = targetContext.targetNetwork;
    const network = targetContext.primaryNetwork;
    const latestWpsJob = getLatestJobByTool(state, "detect_wps_exposure");
    const latestProfileJob = getLatestJobByTool(state, "inspect_target_network_profile");
    const profileExecutionState = getToolExecutionState(state, "inspect_target_network_profile");
    const wpsExecutionState = getToolExecutionState(state, "detect_wps_exposure");
    const securityAssessment = assessSecurityProfile(network);
    const wpsAssessment = assessWpsRisk(targetNetwork?.wps);

    if (!network) {
      scanNetworksFeature.innerHTML = `
        <div class="empty-state">
          <p>No hay informacion guardada de la red objetivo.</p>
        </div>
      `;
      return;
    }

    const scanMetadata = targetNetwork?.scanResult?.normalized ?? {};
    const profileMetadata = targetContext.profile?.normalized ?? {};
    const signalTone = getSignalTone(network.signal);
    const securityTone = getSecurityTone(network.security);
    const bandTone = getBandTone(network.frequency_band);
    const visibilityTone = getVisibilityTone(network.is_hidden);
    const totalClients = sumNetworkMetric(targetContext.activeNetworks, "clients_count");
    const totalBeacons = sumNetworkMetric(targetContext.activeNetworks, "beacons");
    const bestObservedSignal = getBestSignalAcrossNetworks(targetContext.activeNetworks);
    const signalDisplayValue = bestObservedSignal ?? network.signal;
    const signalDisplayTone = getSignalTone(signalDisplayValue);
    const clientsTone = totalClients > 0 ? "good" : "muted";
    const beaconTone = totalBeacons > 0 ? "medium" : "muted";
    const hasWpsContext = Boolean(targetContext.interface && targetContext.targetBssids.length > 0);
    const hasProfileContext = Boolean(targetContext.interface && targetContext.targetSsid);
    const bandsSummary = targetContext.bandsSeen.length > 0
      ? targetContext.bandsSeen.join(" / ")
      : (network.frequency_band ? String(network.frequency_band) : "-");
    const bssidsSummary = targetContext.targetBssids.length > 0
      ? targetContext.targetBssids.join(" · ")
      : (network.bssid ?? "-");

    let profileTone = targetContext.profile ? "good" : "muted";
    let profileHeadline = targetContext.profile ? "Perfil enriquecido disponible" : "Perfil basico";
    let profileSummary = targetContext.profile
      ? `Ultima actualizacion enriquecida con ${targetContext.targetBssids.length} radio(s) detectados.`
      : "Todavia solo se muestra la informacion procedente del escaneo inicial.";

    if (latestProfileJob?.status === "running" || latestProfileJob?.status === "queued") {
      profileTone = "medium";
      profileHeadline = "Actualizando perfil";
      profileSummary = "Se esta ejecutando un escaneo mas largo para enriquecer la informacion de la red objetivo.";
    } else if (latestProfileJob?.status === "failed") {
      profileTone = "bad";
      profileHeadline = "Error al actualizar";
      profileSummary = latestProfileJob.error?.message ?? "No se pudo actualizar el perfil dirigido de la red.";
    }

    let wpsTone = "muted";
    let wpsHeadline = "Todavia sin analizar";
    let wpsSummary = "Lanza la comprobacion para detectar si la red anuncia WPS.";

    if (latestWpsJob?.status === "running" || latestWpsJob?.status === "queued") {
      wpsTone = "medium";
      wpsHeadline = "Analizando WPS";
      wpsSummary = "Se esta ejecutando la comprobacion sobre la red fijada.";
    } else if (latestWpsJob?.status === "failed") {
      wpsTone = "bad";
      wpsHeadline = "Error en la comprobacion";
      wpsSummary = latestWpsJob.error?.message ?? "No se pudo completar la comprobacion WPS.";
    } else if (latestWpsJob?.result?.normalized) {
      const wpsResult = latestWpsJob.result.normalized;
      if (wpsResult.wps_detected) {
        wpsTone = wpsResult.wps_locked ? "medium" : "bad";
        wpsHeadline = wpsResult.wps_locked ? "WPS detectado con bloqueo" : "WPS expuesto";
        wpsSummary = wpsResult.wps_locked
          ? "La red anuncia WPS, pero parece indicar bloqueo."
          : "La red anuncia WPS y conviene revisarlo o desactivarlo.";
      } else {
        wpsTone = "good";
        wpsHeadline = "Sin WPS visible";
        wpsSummary = "No se ha detectado exposición WPS para la red objetivo.";
      }
    }

    scanNetworksFeature.innerHTML = `
      <div class="target-profile">
        <section class="profile-overview-card">
          <div class="target-profile__hero">
            <div>
              <p class="section-tag">Informacion</p>
              <h3>${escapeHtml(network.ssid || "(Red oculta)")}</h3>
              <p>Resumen principal de la red fijada a partir del ultimo escaneo guardado. Este bloque sera la base para las siguientes funcionalidades del MVP.</p>
            </div>
            <div class="target-profile__badges">
              <button
                id="refresh-target-profile-button"
                type="button"
                class="${escapeHtml(getLoadingButtonClass(profileExecutionState.isRunning, "secondary-action"))}"
                ${hasProfileContext ? getLoadingButtonAttrs(profileExecutionState.isRunning, "Actualizando") : "disabled"}
              >
                Actualizar perfil
              </button>
              <span class="signal-pill signal-pill--${escapeHtml(profileTone)}">${escapeHtml(profileHeadline)}</span>
              <span class="signal-pill signal-pill--${escapeHtml(securityTone)}">${escapeHtml(getSecurityLabel(network))}</span>
              <span class="signal-pill signal-pill--${escapeHtml(signalDisplayTone)}">${escapeHtml(getSignalLabel(signalDisplayValue))}</span>
            </div>
          </div>

          <div class="target-profile__metrics">
            <article class="profile-metric-card">
              <span class="metric-label">Bandas detectadas</span>
              <strong>${escapeHtml(bandsSummary)} GHz</strong>
              <span class="signal-pill signal-pill--${escapeHtml(bandTone)}">${escapeHtml(targetContext.channelsSeen.length > 0 ? `Canales ${targetContext.channelsSeen.join(", ")}` : network.channel ? `Canal ${network.channel}` : "Canal desconocido")}</span>
            </article>
            <article class="profile-metric-card">
              <span class="metric-label">Visibilidad</span>
              <strong>${escapeHtml(network.is_hidden ? "Oculta" : "Visible")}</strong>
              <span class="signal-pill signal-pill--${escapeHtml(visibilityTone)}">${escapeHtml(getVisibilityLabel(network.is_hidden))}</span>
            </article>
            <article class="profile-metric-card">
              <span class="metric-label">Clientes observados</span>
              <strong>${escapeHtml(totalClients)}</strong>
              <span class="signal-pill signal-pill--${escapeHtml(clientsTone)}">${escapeHtml(getClientsAssessment(totalClients))}</span>
            </article>
            <article class="profile-metric-card">
              <span class="metric-label">Beacons</span>
              <strong>${escapeHtml(totalBeacons)}</strong>
              <span class="signal-pill signal-pill--${escapeHtml(beaconTone)}">${escapeHtml(getBeaconAssessment(totalBeacons))}</span>
              <span>${escapeHtml(scanMetadata.completed_at ? `Escaneo ${new Date(scanMetadata.completed_at).toLocaleString("es-ES")}` : "Sin fecha de escaneo")}</span>
            </article>
          </div>

          <div class="target-profile__layout">
            <section class="profile-panel">
              <div class="feature-subheading">
                <h4>Identidad de la red</h4>
              </div>
              <div class="profile-definition-list">
                <div class="profile-definition-item">
                  <span>SSID</span>
                  <strong>${escapeHtml(network.ssid || "(Oculta)")}</strong>
                </div>
                <div class="profile-definition-item">
                  <span>BSSID detectados</span>
                  <strong>${escapeHtml(bssidsSummary)}</strong>
                </div>
                <div class="profile-definition-item">
                  <span>Canal</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(bandTone)}">${escapeHtml(targetContext.channelsSeen.length > 0 ? `Canales ${targetContext.channelsSeen.join(", ")}` : network.channel ? `Canal ${network.channel}` : "Canal desconocido")}</span>
                  </strong>
                </div>
                <div class="profile-definition-item">
                  <span>Banda</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(bandTone)}">${escapeHtml(bandsSummary)} GHz</span>
                  </strong>
                </div>
                <div class="profile-definition-item">
                  <span>Senal</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(signalDisplayTone)}">${escapeHtml(getSignalLabel(signalDisplayValue))}</span>
                  </strong>
                  <small>${escapeHtml(getSignalAssessment(signalDisplayValue))}</small>
                </div>
                <div class="profile-definition-item">
                  <span>Tipo de red</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(visibilityTone)}">${escapeHtml(network.is_hidden ? "SSID oculto" : "SSID visible")}</span>
                  </strong>
                </div>
              </div>
            </section>

            <section class="profile-panel">
              <div class="feature-subheading">
                <h4>Seguridad anunciada</h4>
              </div>
              <div class="profile-highlight-grid">
                <div class="profile-highlight-card">
                  <span>Seguridad</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(securityTone)}">${escapeHtml(network.security ?? "-")}</span>
                  </strong>
                  <small>${escapeHtml(getSecurityLabel(network))}</small>
                </div>
                <div class="profile-highlight-card">
                  <span>Privacy</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(securityTone)}">${escapeHtml(network.privacy || "-")}</span>
                  </strong>
                </div>
                <div class="profile-highlight-card">
                  <span>Cipher</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(securityTone)}">${escapeHtml(network.cipher || "-")}</span>
                  </strong>
                </div>
                <div class="profile-highlight-card">
                  <span>Auth</span>
                  <strong>
                    <span class="signal-pill signal-pill--${escapeHtml(securityTone)}">${escapeHtml(network.auth || "-")}</span>
                  </strong>
                </div>
              </div>
              <p class="profile-note">Esta lectura procede de los beacons observados durante el escaneo. Mas adelante podremos enriquecerla con comprobaciones especificas y evaluaciones de riesgo.</p>
            </section>
          </div>
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Evaluar protocolo de seguridad</h4>
            <span class="signal-pill signal-pill--${escapeHtml(securityAssessment.tone)}">${escapeHtml(securityAssessment.headline)}</span>
          </div>
          <div class="security-assessment-layout">
            <div class="security-assessment-summary">
              <p>${escapeHtml(securityAssessment.summary)}</p>
            </div>
            <div class="security-attribute-grid">
              ${securityAssessment.fields
                .map(
                  (field) => `
                    <article class="security-attribute-card">
                      <div class="security-attribute-card__header">
                        <span>${escapeHtml(field.label)}</span>
                        <div class="info-tooltip">
                          <button type="button" class="info-tooltip__button" aria-label="Mas informacion sobre ${escapeHtml(field.label)}">i</button>
                          <div class="info-tooltip__panel">
                            ${escapeHtml(field.explanation)}
                          </div>
                        </div>
                      </div>
                      <div class="security-attribute-card__body">
                        <span class="signal-pill signal-pill--${escapeHtml(field.tone)}">${escapeHtml(field.value)}</span>
                        <p>${escapeHtml(field.assessment)}</p>
                      </div>
                    </article>
                  `,
                )
                .join("")}
            </div>
            <div class="security-assessment-grid">
              <article class="profile-highlight-card">
                <span>Recomendaciones</span>
                <small>Medidas sencillas para mejorar o mantener la proteccion actual de la red.</small>
                <ul class="assessment-list">
                  ${securityAssessment.recommendations
                    .map((item) => `<li>${escapeHtml(item)}</li>`)
                    .join("")}
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Comprobar exposicion WPS</h4>
            <span class="signal-pill signal-pill--${escapeHtml(wpsTone)}">${escapeHtml(wpsHeadline)}</span>
          </div>
          <div class="wps-check-layout">
            <div class="wps-check-copy">
              <p>${escapeHtml(wpsSummary)}</p>
              <div class="wps-check-meta">
                <span><strong>Interfaz:</strong> ${escapeHtml(targetContext.interface ?? "No disponible")}</span>
                <span><strong>BSSID objetivo:</strong> ${escapeHtml(targetContext.targetBssids.join(", ") || "No disponible")}</span>
              </div>
            </div>
            <div class="wps-check-actions">
              <button
                id="run-wps-check-button"
                type="button"
                class="${escapeHtml(getLoadingButtonClass(wpsExecutionState.isRunning, "primary-action"))}"
                ${hasWpsContext ? getLoadingButtonAttrs(wpsExecutionState.isRunning, "Analizando") : "disabled"}
              >
                Analizar WPS
              </button>
            </div>
          </div>
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Evaluar riesgo por WPS</h4>
            <span class="signal-pill signal-pill--${escapeHtml(wpsAssessment.tone)}">${escapeHtml(wpsAssessment.headline)}</span>
          </div>
          <div class="security-assessment-layout">
            <div class="security-assessment-summary">
              <p>${escapeHtml(wpsAssessment.summary)}</p>
            </div>
            <div class="security-attribute-grid">
              ${wpsAssessment.fields
                .map(
                  (field) => `
                    <article class="security-attribute-card">
                      <div class="security-attribute-card__header">
                        <span>${escapeHtml(field.label)}</span>
                        <div class="info-tooltip">
                          <button type="button" class="info-tooltip__button" aria-label="Mas informacion sobre ${escapeHtml(field.label)}">i</button>
                          <div class="info-tooltip__panel">
                            ${escapeHtml(field.explanation)}
                          </div>
                        </div>
                      </div>
                      <div class="security-attribute-card__body">
                        <span class="signal-pill signal-pill--${escapeHtml(field.tone)}">${escapeHtml(field.value)}</span>
                        <p>${escapeHtml(field.assessment)}</p>
                      </div>
                    </article>
                  `,
                )
                .join("")}
            </div>
            <div class="security-assessment-grid">
              <article class="profile-highlight-card">
                <span>Recomendaciones</span>
                <small>Pasos claros para reducir el riesgo que introduce WPS si aparece activo en la red.</small>
                <ul class="assessment-list">
                  ${wpsAssessment.recommendations
                    .map((item) => `<li>${escapeHtml(item)}</li>`)
                    .join("")}
                </ul>
              </article>
            </div>
          </div>
        </section>
      </div>
    `;

    const runWpsButton = document.querySelector("#run-wps-check-button");
    runWpsButton?.addEventListener("click", async () => {
      if (!hasWpsContext) {
        return;
      }

      try {
        const job = await executeTool("detect_wps_exposure", {
          interface: targetContext.interface,
          target_bssids: targetContext.targetBssids.join(","),
          scan_seconds: "8",
        });
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudo ejecutar la comprobacion WPS:", error);
      }
    });

    const refreshProfileButton = document.querySelector("#refresh-target-profile-button");
    refreshProfileButton?.addEventListener("click", async () => {
      if (!hasProfileContext) {
        return;
      }

      try {
        const job = await executeTool("inspect_target_network_profile", {
          interface: targetContext.interface,
          target_ssid: targetContext.targetSsid,
          scan_seconds: "20",
        });
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudo actualizar el perfil de la red:", error);
      }
    });
  }

  function renderConnectedDashboardPlaceholder(state) {
    const targetContext = getTargetContext(state);
    const connection = targetContext.connection;
    const badge = getConnectionBadge(connection);
    const hasConfirmedConnection = Boolean(connection?.connected && connection?.matchesExpectedTarget);
    const routerExecutionState = getToolExecutionState(state, "discover_gateway_and_router_profile");
    const latestRouterJob = getLatestJobByTool(state, "discover_gateway_and_router_profile");
    const routerProfile = targetContext.routerProfile?.normalized ?? null;
    const upnpResult = targetContext.targetNetwork?.upnp ?? null;
    const upnpNormalized = upnpResult?.normalized ?? null;
    const upnpAssessment = assessUpnpRisk(upnpResult);
    const upnpExecutionState = getToolExecutionState(state, "detect_upnp_exposure");
    const managementServicesResult = targetContext.targetNetwork?.managementServices ?? null;
    const managementServicesNormalized = managementServicesResult?.normalized ?? null;
    const managementServicesAssessment = assessManagementServicesRisk(managementServicesResult);
    const managementServicesExecutionState = getToolExecutionState(state, "detect_management_services");
    const detectedManagementServices = (managementServicesNormalized?.services ?? [])
      .filter((service) => service?.reachable);
    const openPorts = routerProfile?.open_ports ?? [];
    const webAdmin = routerProfile?.web_admin ?? {
      http: { reachable: false, title: null, status_code: null, server: null, url: null, final_url: null, content_type: null, text_preview: [] },
      https: { reachable: false, title: null, status_code: null, server: null, url: null, final_url: null, content_type: null, text_preview: [] },
    };
    const adminAuth = routerProfile?.admin_auth ?? null;

    let routerTone = "muted";
    let routerHeadline = "Todavia sin analizar";
    let routerSummary = "Lanza esta funcionalidad para identificar el gateway, el fabricante probable del router y algunos servicios internos habituales.";

    if (routerExecutionState.isRunning) {
      routerTone = "medium";
      routerHeadline = "Identificando router";
      routerSummary = "Se esta comprobando el gateway activo, el fabricante por MAC y la posible superficie web del router.";
    } else if (latestRouterJob?.status === "failed") {
      routerTone = "bad";
      routerHeadline = "Error en la identificacion";
      routerSummary = latestRouterJob.error?.message ?? "No se pudo completar la identificacion del router.";
    } else if (routerProfile) {
      const hasGateway = Boolean(routerProfile.gateway_ip);
      const hasWebAdmin = Boolean(webAdmin.http?.reachable || webAdmin.https?.reachable);
      routerTone = hasGateway ? "good" : "medium";
      routerHeadline = hasWebAdmin ? "Router identificado" : "Gateway identificado";
      routerSummary = hasWebAdmin
        ? "Se ha localizado el router y tambien hay indicios de una interfaz web de administracion accesible desde la red local."
        : "Se ha identificado el gateway activo y algunos rasgos basicos del router conectado.";
    }

    const routerRecommendations = [];
    if (routerProfile) {
      if (webAdmin.http?.reachable && !webAdmin.https?.reachable) {
        routerRecommendations.push("Si el panel web solo responde por HTTP, conviene revisar si el router permite administracion segura por HTTPS.");
      }
      if (openPorts.includes(23)) {
        routerRecommendations.push("Se ha detectado Telnet abierto. Si no es necesario, seria recomendable desactivarlo.");
      }
      if (!routerProfile.gateway_mac) {
        routerRecommendations.push("No se ha podido resolver la MAC del gateway con la informacion disponible en esta comprobacion. Podemos reintentarlo con mas fallbacks o tras refrescar la vecindad ARP.");
      }
      if (!routerProfile.gateway_vendor) {
        routerRecommendations.push("No se ha podido identificar el fabricante por MAC. Mas adelante podemos enriquecer la base local de fabricantes.");
      }
      if (adminAuth?.auth_required && adminAuth?.auth_type === "password_only") {
        routerRecommendations.push("El panel parece pedir solo contrasena. Esto es util para futuras comprobaciones controladas de credenciales del router.");
      }
      if (adminAuth?.auth_required && adminAuth?.auth_type === "username_password") {
        routerRecommendations.push("El panel parece usar usuario y contrasena. Ya tenemos una base buena para futuras comprobaciones de credenciales por defecto.");
      }
      if (!routerRecommendations.length) {
        routerRecommendations.push("Esta identificacion inicial del router nos da una buena base para las siguientes comprobaciones conectadas del MVP.");
      }
    }

    const confidenceTone = routerProfile?.router_profile_confidence === "high"
      ? "good"
      : routerProfile?.router_profile_confidence === "medium"
        ? "medium"
        : "muted";

    scanNetworksFeature.innerHTML = `
      <div class="target-profile">
        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Identificar el router</h4>
            <span class="signal-pill signal-pill--${escapeHtml(routerTone)}">${escapeHtml(routerHeadline)}</span>
          </div>
          <div class="wps-check-layout">
            <div class="wps-check-copy">
              <p>${escapeHtml(routerSummary)}</p>
              <div class="wps-check-meta">
                <span><strong>Estado:</strong> ${escapeHtml(badge.label)}</span>
                <span><strong>SSID activo:</strong> ${escapeHtml(connection?.activeSsid ?? "No conectado")}</span>
                <span><strong>Interfaz:</strong> ${escapeHtml(connection?.interface ?? targetContext.interface ?? "No disponible")}</span>
                <span><strong>IP local:</strong> ${escapeHtml(connection?.ipv4 ?? "No disponible")}</span>
              </div>
            </div>
            <div class="wps-check-actions">
              <button
                id="discover-router-profile-button"
                type="button"
                class="${escapeHtml(getLoadingButtonClass(routerExecutionState.isRunning, "primary-action"))}"
                ${hasConfirmedConnection ? getLoadingButtonAttrs(routerExecutionState.isRunning, "Analizando") : "disabled"}
              >
                Identificar router
              </button>
            </div>
          </div>
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Perfil detectado del router</h4>
            <span class="signal-pill signal-pill--${escapeHtml(confidenceTone)}">${escapeHtml(routerProfile?.router_profile_confidence ? `Confianza ${routerProfile.router_profile_confidence}` : "Sin perfil guardado")}</span>
          </div>
          ${
            routerProfile
              ? `
                <div class="security-assessment-layout">
                  <div class="security-assessment-summary">
                    <p>Esta tarjeta resume a que equipo estamos llegando una vez conectados: su gateway, su fabricante probable y si expone servicios habituales de administracion dentro de la red local.</p>
                  </div>
                  <div class="security-attribute-grid">
                    <article class="security-attribute-card">
                      <div class="security-attribute-card__header">
                        <span>Gateway</span>
                      </div>
                      <div class="security-attribute-card__body">
                        <span class="signal-pill signal-pill--${escapeHtml(routerProfile.gateway_ip ? "good" : "muted")}">${escapeHtml(routerProfile.gateway_ip ?? "No disponible")}</span>
                        <p>Es la direccion interna del router a la que suelen salir los dispositivos para alcanzar otras redes o Internet.</p>
                      </div>
                    </article>
                    <article class="security-attribute-card">
                      <div class="security-attribute-card__header">
                        <span>Fabricante</span>
                      </div>
                      <div class="security-attribute-card__body">
                        <span class="signal-pill signal-pill--${escapeHtml(routerProfile.gateway_vendor ? "good" : "muted")}">${escapeHtml(routerProfile.gateway_vendor ?? "No identificado")}</span>
                        <p>Se infiere a partir del prefijo MAC del gateway usando la base local \`mac.csv\`, lo que ayuda a orientar futuras comprobaciones.</p>
                      </div>
                    </article>
                    <article class="security-attribute-card">
                      <div class="security-attribute-card__header">
                        <span>Latencia</span>
                      </div>
                      <div class="security-attribute-card__body">
                        <span class="signal-pill signal-pill--${escapeHtml(routerProfile.icmp_reachable ? "good" : "muted")}">${escapeHtml(routerProfile.avg_latency_ms != null ? `${routerProfile.avg_latency_ms.toFixed(2)} ms` : "Sin dato")}</span>
                        <p>Nos indica si el gateway responde a una comprobacion basica de red y cuanto tarda aproximadamente en contestar.</p>
                      </div>
                    </article>
                    <article class="security-attribute-card">
                      <div class="security-attribute-card__header">
                        <span>Servicios</span>
                      </div>
                      <div class="security-attribute-card__body">
                        <span class="signal-pill signal-pill--${escapeHtml(openPorts.length ? "medium" : "muted")}">${escapeHtml(openPorts.length ? openPorts.join(", ") : "Sin puertos comunes detectados")}</span>
                        <p>Se revisan algunos puertos muy habituales en routers, como web, SSH o Telnet, para saber que superficie interna podria estar expuesta.</p>
                      </div>
                    </article>
                  </div>
                  <div class="security-assessment-grid">
                    <article class="profile-highlight-card">
                      <span>Administracion web</span>
                      <strong>${escapeHtml(webAdmin.http?.reachable || webAdmin.https?.reachable ? "Detectada" : "No detectada")}</strong>
                      <small><strong>HTTP:</strong> <a class="admin-link" href="${escapeHtml(webAdmin.http?.url ?? "#")}" target="_blank" rel="noreferrer">${escapeHtml(webAdmin.http?.url ?? "No disponible")}</a></small>
                      <small><strong>HTTPS:</strong> <a class="admin-link" href="${escapeHtml(webAdmin.https?.url ?? "#")}" target="_blank" rel="noreferrer">${escapeHtml(webAdmin.https?.url ?? "No disponible")}</a></small>
                      <small>
                        HTTP: ${escapeHtml(webAdmin.http?.reachable ? `si (${webAdmin.http?.status_code ?? "sin codigo"})` : "no")} ·
                        HTTPS: ${escapeHtml(webAdmin.https?.reachable ? `si (${webAdmin.https?.status_code ?? "sin codigo"})` : "no")}
                      </small>
                      <small><strong>Pagina detectada:</strong> ${escapeHtml(webAdmin.https?.title ?? webAdmin.http?.title ?? "Sin titulo detectado")}</small>
                      <small><strong>Servidor:</strong> ${escapeHtml(webAdmin.https?.server ?? webAdmin.http?.server ?? "No anunciado")}</small>
                      <small><strong>Contenido:</strong> ${escapeHtml(webAdmin.https?.content_type ?? webAdmin.http?.content_type ?? "No disponible")}</small>
                      <small><strong>URL final:</strong> <a class="admin-link" href="${escapeHtml(webAdmin.https?.final_url ?? webAdmin.http?.final_url ?? "#")}" target="_blank" rel="noreferrer">${escapeHtml(webAdmin.https?.final_url ?? webAdmin.http?.final_url ?? "No disponible")}</a></small>
                      <small>La comprobacion HTTPS acepta certificados autofirmados para poder inspeccionar routers domesticos sin bloquearse por ese aviso.</small>
                    </article>
                    <article class="profile-highlight-card">
                      <span>Detalles adicionales</span>
                      <small><strong>MAC gateway:</strong> ${escapeHtml(routerProfile.gateway_mac ?? "No disponible")}</small>
                      <small><strong>Fuente MAC:</strong> ${escapeHtml(routerProfile.gateway_mac_source ?? "No disponible")}</small>
                      <small><strong>BSSID activo:</strong> ${escapeHtml(routerProfile.active_bssid ?? "No disponible")}</small>
                      <small><strong>Perfil NM:</strong> ${escapeHtml(routerProfile.connection_profile ?? "No disponible")}</small>
                      <small><strong>DNS:</strong> ${escapeHtml((routerProfile.dns_servers ?? []).join(", ") || "No disponible")}</small>
                    </article>
                  </div>
                  <div class="security-assessment-grid">
                    <article class="profile-highlight-card">
                      <span>Autenticacion del panel</span>
                      <strong>${escapeHtml(getAdminAuthHeadline(adminAuth))}</strong>
                      <small><strong>Estado:</strong> ${escapeHtml(adminAuth?.auth_required == null ? "No determinado" : (adminAuth.auth_required ? "Requerida" : "No detectada"))}</small>
                      <small><strong>Tipo:</strong> ${escapeHtml(adminAuth?.auth_type ?? "No determinado")}</small>
                      <small><strong>Fuente:</strong> ${escapeHtml(adminAuth?.source_url ?? "No disponible")}</small>
                      <small><strong>Evidencias:</strong> ${escapeHtml(formatAdminAuthEvidence(adminAuth))}</small>
                    </article>
                  </div>
                  <div class="security-assessment-grid">
                    <article class="profile-highlight-card">
                      <span>Recomendaciones</span>
                      <small>Primeras conclusiones a partir de la identificacion del gateway y del router.</small>
                      <ul class="assessment-list">
                        ${routerRecommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
                      </ul>
                    </article>
                  </div>
                </div>
              `
              : `
                <div class="empty-state">
                  <p>Cuando lances esta funcionalidad, aqui apareceran la IP del gateway, su MAC, el fabricante probable y los servicios basicos detectados del router.</p>
                </div>
            `
          }
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Comprobar exposicion UPnP</h4>
            <span class="signal-pill signal-pill--${escapeHtml(upnpAssessment.tone)}">${escapeHtml(upnpAssessment.headline)}</span>
          </div>
          <div class="wps-check-layout">
            <div class="wps-check-copy">
              <p>${escapeHtml(
                upnpNormalized
                  ? (
                    upnpNormalized.upnp_detected
                      ? "Se han detectado respuestas UPnP/SSDP en el entorno conectado y se ha evaluado si parecen pertenecer al router actual."
                      : "No se han observado respuestas UPnP/SSDP del router durante la comprobacion."
                  )
                  : "Lanza esta funcionalidad para detectar si el router conectado expone UPnP/IGD dentro de la red local."
              )}</p>
              <div class="wps-check-meta">
                <span><strong>Gateway objetivo:</strong> ${escapeHtml(routerProfile?.gateway_ip ?? connection?.gateway ?? "No disponible")}</span>
                <span><strong>Respuestas SSDP:</strong> ${escapeHtml(String(upnpNormalized?.ssdp_responses_count ?? 0))}</span>
                <span><strong>Router coincidente:</strong> ${escapeHtml(upnpNormalized?.matching_router_response ? "Si" : "No")}</span>
              </div>
            </div>
            <div class="wps-check-actions">
              <button
                id="run-upnp-check-button"
                type="button"
                class="${escapeHtml(getLoadingButtonClass(upnpExecutionState.isRunning, "primary-action"))}"
                ${hasConfirmedConnection ? getLoadingButtonAttrs(upnpExecutionState.isRunning, "Analizando") : "disabled"}
              >
                Analizar UPnP
              </button>
            </div>
          </div>
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Evaluar riesgo por UPnP</h4>
            <span class="signal-pill signal-pill--${escapeHtml(upnpAssessment.tone)}">${escapeHtml(upnpAssessment.headline)}</span>
          </div>
          <div class="security-assessment-layout">
            <div class="security-assessment-summary">
              <p>${escapeHtml(upnpAssessment.summary)}</p>
            </div>
            ${
              upnpNormalized
                ? `
                  <div class="security-assessment-grid">
                    <article class="profile-highlight-card">
                      <span>Resultado tecnico</span>
                      <small><strong>Resultado:</strong> ${escapeHtml(upnpNormalized.upnp_detected ? "Detectado" : "No detectado")}</small>
                      <small><strong>UPnP detectado:</strong> ${escapeHtml(upnpNormalized.upnp_detected ? "Si" : "No")}</small>
                      <small><strong>IGD detectado:</strong> ${escapeHtml(upnpNormalized.igd_detected ? "Si" : "No")}</small>
                      <small><strong>Servicio WANIP:</strong> ${escapeHtml(upnpNormalized.wan_ip_connection_service == null ? "No determinado" : (upnpNormalized.wan_ip_connection_service ? "Si" : "No"))}</small>
                      <small><strong>Port mapping:</strong> ${escapeHtml(upnpNormalized.port_mapping_capable == null ? "No determinado" : (upnpNormalized.port_mapping_capable ? "Parece soportado" : "No detectado"))}</small>
                    </article>
                    <article class="profile-highlight-card">
                      <span>Detalles del dispositivo</span>
                      <small><strong>Friendly name:</strong> ${escapeHtml(upnpNormalized.device_friendly_name ?? "No disponible")}</small>
                      <small><strong>Fabricante:</strong> ${escapeHtml(upnpNormalized.device_manufacturer ?? "No disponible")}</small>
                      <small><strong>Modelo:</strong> ${escapeHtml(upnpNormalized.device_model ?? "No disponible")}</small>
                      <small><strong>Location:</strong> ${escapeHtml(upnpNormalized.location ?? "No disponible")}</small>
                    </article>
                  </div>
                `
                : `
                  <div class="empty-state">
                    <p>Aqui apareceran la evidencia SSDP/UPnP y una interpretacion del riesgo una vez se ejecute la comprobacion.</p>
                  </div>
                `
            }
            <div class="security-assessment-grid">
              <article class="profile-highlight-card">
                <span>Recomendaciones</span>
                <small>UPnP puede ser comodo, pero tambien amplia la capacidad de que equipos internos automaticen aperturas de puertos.</small>
                <ul class="assessment-list">
                  ${upnpAssessment.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Servicios de administracion</h4>
            <span class="signal-pill signal-pill--${escapeHtml(managementServicesAssessment.tone)}">${escapeHtml(managementServicesAssessment.headline)}</span>
          </div>
          <div class="wps-check-layout">
            <div class="wps-check-copy">
              <p>${escapeHtml(
                managementServicesNormalized
                  ? `Se han revisado ${managementServicesNormalized.services_detected_count} servicio(s) de administracion accesibles en los puertos tipicos del router.`
                  : "Lanza esta comprobacion para detectar panel web, SSH, Telnet, FTP, SNMP, TR-069 y otros puertos habituales de gestion del router."
              )}</p>
              <div class="wps-check-meta">
                <span><strong>Gateway objetivo:</strong> ${escapeHtml(routerProfile?.gateway_ip ?? connection?.gateway ?? "No disponible")}</span>
                <span><strong>Servicios detectados:</strong> ${escapeHtml(String(managementServicesNormalized?.services_detected_count ?? 0))}</span>
                <span><strong>Nivel:</strong> ${escapeHtml(managementServicesNormalized?.management_exposure_level ?? "No determinado")}</span>
              </div>
            </div>
            <div class="wps-check-actions">
              <button
                id="run-management-services-button"
                type="button"
                class="${escapeHtml(getLoadingButtonClass(managementServicesExecutionState.isRunning, "primary-action"))}"
                ${hasConfirmedConnection ? getLoadingButtonAttrs(managementServicesExecutionState.isRunning, "Analizando") : "disabled"}
              >
                Analizar servicios
              </button>
            </div>
          </div>
        </section>

        <section class="profile-panel">
          <div class="feature-subheading">
            <h4>Evaluar seguridad de servicios de administracion</h4>
            <span class="signal-pill signal-pill--${escapeHtml(managementServicesAssessment.tone)}">${escapeHtml(managementServicesAssessment.headline)}</span>
          </div>
          <div class="security-assessment-layout">
            <div class="security-assessment-summary">
              <p>${escapeHtml(managementServicesAssessment.summary)}</p>
            </div>
            ${
              managementServicesNormalized
                ? `
                  ${
                    detectedManagementServices.length > 0
                      ? `
                        <div class="security-assessment-grid">
                          ${detectedManagementServices
                            .map((service) => `
                              <article class="profile-highlight-card">
                                <span>${escapeHtml(service.service_name)}</span>
                                <strong>${escapeHtml(`Puerto ${service.port} abierto`)}</strong>
                                <small><strong>Riesgo:</strong> ${escapeHtml(service.risk_level)}</small>
                                <small><strong>Auth:</strong> ${escapeHtml(service.auth_type ?? (service.requires_auth == null ? "No determinado" : (service.requires_auth ? "Requerida" : "No requerida")))}</small>
                                <small><strong>Banner:</strong> ${escapeHtml(service.banner ?? "No disponible")}</small>
                                <small><strong>URL:</strong> ${service.url ? `<a class="admin-link" href="${escapeHtml(service.url)}" target="_blank" rel="noreferrer">${escapeHtml(service.url)}</a>` : "No aplica"}</small>
                                <small><strong>Titulo:</strong> ${escapeHtml(service.title ?? "No disponible")}</small>
                              </article>
                            `)
                            .join("")}
                        </div>
                      `
                      : `
                        <div class="empty-state">
                          <p>No se han detectado servicios de administracion abiertos en los puertos revisados durante esta comprobacion.</p>
                        </div>
                      `
                  }
                `
                : `
                  <div class="empty-state">
                    <p>Aqui apareceran los servicios detectados y una lectura de riesgo una vez se ejecute la comprobacion.</p>
                  </div>
                `
            }
            <div class="security-assessment-grid">
              <article class="profile-highlight-card">
                <span>Recomendaciones</span>
                <small>Esta evaluacion ayuda a decidir que accesos de gestion conviene mantener y cuales seria mejor cerrar.</small>
                <ul class="assessment-list">
                  ${managementServicesAssessment.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
                </ul>
              </article>
            </div>
          </div>
        </section>
      </div>
    `;

    const discoverRouterProfileButton = document.querySelector("#discover-router-profile-button");
    discoverRouterProfileButton?.addEventListener("click", async () => {
      if (!hasConfirmedConnection) {
        return;
      }

      try {
        const job = await executeTool("discover_gateway_and_router_profile", {
          interface: targetContext.interface ?? "wlan0",
          expected_ssid: targetContext.targetSsid ?? "",
        });
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudo identificar el router:", error);
      }
    });

    const runUpnpCheckButton = document.querySelector("#run-upnp-check-button");
    runUpnpCheckButton?.addEventListener("click", async () => {
      if (!hasConfirmedConnection) {
        return;
      }

      try {
        const job = await executeTool("detect_upnp_exposure", {
          interface: targetContext.interface ?? "wlan0",
          gateway_ip: routerProfile?.gateway_ip ?? connection?.gateway ?? "",
          timeout_seconds: "4",
        });
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudo analizar la exposicion UPnP:", error);
      }
    });

    const runManagementServicesButton = document.querySelector("#run-management-services-button");
    runManagementServicesButton?.addEventListener("click", async () => {
      if (!hasConfirmedConnection) {
        return;
      }

      try {
        const job = await executeTool("detect_management_services", {
          interface: targetContext.interface ?? "wlan0",
          gateway_ip: routerProfile?.gateway_ip ?? connection?.gateway ?? "",
          timeout_seconds: "3",
        });
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error("No se pudieron analizar los servicios de administracion:", error);
      }
    });
  }

  function renderDashboardModeTabs(state) {
    const hasTargetNetwork = Boolean(state.targetNetwork);
    if (!hasTargetNetwork) {
      dashboardModeTabs.hidden = true;
      dashboardModeTabs.innerHTML = "";
      return;
    }

    const targetContext = getTargetContext(state);
    const hasConfirmedConnection = Boolean(targetContext.connection?.matchesExpectedTarget);
    const activeView =
      uiState.dashboardConnectionView ??
      (hasConfirmedConnection ? "connected" : "not_connected");

    uiState.dashboardConnectionView = activeView;

    dashboardModeTabs.hidden = false;
    dashboardModeTabs.innerHTML = `
      <div class="subnav-tabs" aria-label="Modo del dashboard">
        <button type="button" class="subnav-tab ${activeView === "not_connected" ? "is-active" : ""}" data-dashboard-mode="not_connected">
          No conectado
        </button>
        <button type="button" class="subnav-tab ${activeView === "connected" ? "is-active" : ""}" data-dashboard-mode="connected">
          Conectado
        </button>
      </div>
    `;

    document.querySelectorAll("[data-dashboard-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        uiState.dashboardConnectionView = button.dataset.dashboardMode;
        renderDashboard(getState());
      });
    });
  }

  function renderScanNetworksFeature(state) {
    const tool = state.tools.find((entry) => entry.name === "scan_wifi_networks");
    const hasTargetNetwork = Boolean(state.targetNetwork);
    const scanExecutionState = getToolExecutionState(state, "scan_wifi_networks");

    if (!tool) {
      scanNetworksFeature.innerHTML = `
        <div class="empty-state">
          <p>La funcionalidad de escaneo de redes estara disponible cuando se cargue la tool correspondiente.</p>
        </div>
      `;
      return;
    }

    if (hasTargetNetwork) {
      if (uiState.dashboardConnectionView === "connected") {
        renderConnectedDashboardPlaceholder(state);
      } else {
        renderTargetNetworkInfoFeature(state);
      }
      return;
    }

    const latestScanJob = getLatestScanNetworksJob(state);
    const networks = latestScanJob?.result?.normalized?.networks ?? [];
    const targetBssid = state.targetNetwork?.selectedNetwork?.bssid ?? null;

    const statusMarkup = latestScanJob
      ? `
          <div class="feature-status-row">
            <span class="job-status status-${escapeHtml(latestScanJob.status ?? "queued")}">${escapeHtml(latestScanJob.status ?? "queued")}</span>
            <span>Job ${escapeHtml(latestScanJob.jobId ?? "-")}</span>
            <span>${escapeHtml(String(latestScanJob.result?.normalized?.networks_count ?? 0))} redes detectadas</span>
          </div>
        `
      : `
          <div class="feature-status-row">
            <span class="job-status status-queued">listo</span>
            <span>Configuracion preparada para lanzar el primer escaneo</span>
          </div>
        `;

    const introText =
      "El primer paso es escanear las redes disponibles y fijar cual es tu red para desbloquear el resto del dashboard.";

    const resultsTitle = "Selecciona tu red";
    const networksMarkup = renderNetworksTable(networks, {
      compact: true,
      showFixAction: true,
      targetBssid,
    });

    scanNetworksFeature.innerHTML = `
      <div class="feature-header">
        <div>
          <p class="section-tag">Reconocimiento</p>
          <h3>Escanear redes disponibles</h3>
          <p>${escapeHtml(introText)}</p>
        </div>
        ${statusMarkup}
      </div>

      <div class="feature-body">
        <section class="feature-results">
          <div class="feature-subheading">
            <h4>${escapeHtml(resultsTitle)}</h4>
          </div>
          ${networksMarkup}
        </section>

        <aside class="feature-config">
          <div class="feature-subheading">
            <h4>Configuracion</h4>
          </div>
          <form id="scan-networks-form" class="tool-form feature-tool-form">
            <div class="feature-form-grid">
              ${buildScanFieldsMarkup(tool)}
            </div>
            <div class="tool-form-actions">
              <button
                type="submit"
                class="${escapeHtml(getLoadingButtonClass(scanExecutionState.isRunning, "primary-action"))}"
                ${getLoadingButtonAttrs(scanExecutionState.isRunning, "Escaneando")}
              >
                Lanzar escaneo
              </button>
            </div>
          </form>
        </aside>
      </div>
    `;

    const executionForm = document.querySelector("#scan-networks-form");
    executionForm?.addEventListener("input", (event) => {
      const target = event.target;
      const argName = target?.dataset?.toolArg;
      if (!argName) {
        return;
      }

      uiState.formValuesByTool[tool.name] = {
        ...getFormValuesForTool(tool),
        [argName]: target.value,
      };
    });

    executionForm?.addEventListener("submit", async (event) => {
      event.preventDefault();

      const args = { ...getFormValuesForTool(tool) };

      try {
        const job = await executeTool(tool.name, args);
        uiState.selectedJobId = job.jobId;
        renderDashboard(getState());
      } catch (error) {
        console.error(`No se pudo ejecutar la tool '${tool.name}':`, error);
      }
    });

    document.querySelectorAll("[data-fix-network-bssid]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!latestScanJob?.result) {
          return;
        }

        const selectedNetwork = networks.find(
          (network) => network.bssid === button.dataset.fixNetworkBssid,
        );

        if (!selectedNetwork) {
          return;
        }

        const relatedNetworks = selectedNetwork?.ssid
          ? networks.filter((network) => network.ssid === selectedNetwork.ssid)
          : [selectedNetwork];

        setTargetNetwork({
          toolName: "scan_wifi_networks",
          sourceJobId: latestScanJob.jobId,
          fixedAt: new Date().toISOString(),
          targetSsid: selectedNetwork.ssid ?? "",
          interface:
            latestScanJob.result?.normalized?.interface ??
            latestScanJob.input?.interface ??
            null,
          selectedNetwork,
          relatedNetworks,
          scanResult: latestScanJob.result,
          profile: null,
          profileSourceJobId: null,
          wps: null,
          wpsSourceJobId: null,
          upnp: null,
          upnpSourceJobId: null,
          managementServices: null,
          managementServicesSourceJobId: null,
          connection: null,
          connectionSourceJobId: null,
          routerProfile: null,
          routerProfileSourceJobId: null,
        });

        uiState.dashboardConnectionView = "not_connected";
        uiState.selectedJobId = latestScanJob.jobId;
        activateView("dashboard");
      });
    });
  }

  function renderJobs(state) {
    const jobs = Object.values(state.jobs);

    if (!jobs.length) {
      jobsList.innerHTML = `
        <div class="empty-state">
          <p>Todavia no se ha lanzado ningun job.</p>
        </div>
      `;
      return;
    }

    const sortedJobs = [...jobs].sort((left, right) => {
      const leftTime = new Date(left.submittedAt ?? 0).getTime();
      const rightTime = new Date(right.submittedAt ?? 0).getTime();
      return rightTime - leftTime;
    });

    if (!uiState.selectedJobId) {
      uiState.selectedJobId = sortedJobs[0].jobId;
    }

    jobsList.innerHTML = sortedJobs
      .map((job) => {
        const isSelected = job.jobId === uiState.selectedJobId;
        const summary = job.result?.raw_text
          ? `Resultado disponible`
          : job.error?.message ?? "Sin resultado disponible todavia.";

        return `
          <button class="job-list-item ${isSelected ? "is-selected" : ""}" data-job-select="${escapeHtml(job.jobId)}" type="button">
            <span class="job-list-header">
              <strong>${escapeHtml(job.toolName ?? "tool")}</strong>
              <span class="job-status status-${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
            </span>
            <span class="job-list-id">${escapeHtml(job.jobId)}</span>
            <span class="job-list-summary">${escapeHtml(summary)}</span>
          </button>
        `;
      })
      .join("");
  }

  function renderResultViewer(state) {
    const selectedJob = uiState.selectedJobId
      ? state.jobs[uiState.selectedJobId]
      : null;

    if (!selectedJob) {
      resultViewer.innerHTML = `
        <div class="empty-state">
          <p>Selecciona un job para ver su resultado.</p>
        </div>
      `;
      return;
    }

    resultViewer.innerHTML = `
      <div class="result-meta">
        <span><strong>Tool:</strong> ${escapeHtml(selectedJob.toolName ?? "-")}</span>
        <span><strong>Estado:</strong> ${escapeHtml(selectedJob.status ?? "-")}</span>
        <span><strong>Job:</strong> ${escapeHtml(selectedJob.jobId ?? "-")}</span>
      </div>
      <div class="result-block">
        <h4>Input</h4>
        <pre>${escapeHtml(JSON.stringify(selectedJob.input ?? {}, null, 2))}</pre>
      </div>
      <div class="result-block">
        <h4>Resultado</h4>
        <pre>${escapeHtml(JSON.stringify(selectedJob.result ?? null, null, 2))}</pre>
      </div>
      <div class="result-block">
        <h4>Error</h4>
        <pre>${escapeHtml(JSON.stringify(selectedJob.error ?? null, null, 2))}</pre>
      </div>
    `;
  }

  function renderWorkspace(state) {
    if (!workspaceContent) {
      return;
    }

    const targetContext = getTargetContext(state);
    const targetNetwork = targetContext.targetNetwork;
    const securityScore = computeTargetSecurityScore(targetContext);
    const selectedNetwork = targetContext.primaryNetwork ?? targetNetwork?.selectedNetwork ?? null;
    const connection = targetContext.connection ?? null;

    if (!targetNetwork) {
      workspaceContent.innerHTML = `
        <article class="surface-card">
          <div class="card-heading">
            <h3>Estado guardado</h3>
            <span class="pill">Vacío</span>
          </div>
          <div class="empty-state">
            <p>Todavia no hay una red objetivo fijada ni resultados persistidos para este espacio.</p>
          </div>
        </article>
      `;
      return;
    }

    const completedChecks = [
      targetNetwork.scanResult?.normalized ? "Escaneo inicial" : null,
      targetNetwork.profile?.normalized ? "Perfil enriquecido" : null,
      targetNetwork.wps?.normalized ? "WPS" : null,
      targetNetwork.upnp?.normalized ? "UPnP" : null,
      targetNetwork.managementServices?.normalized ? "Servicios de administracion" : null,
      targetNetwork.routerProfile?.normalized ? "Router" : null,
    ].filter(Boolean);

    workspaceContent.innerHTML = `
      ${renderSecurityScoreSection(securityScore, "Puntuacion global de la red objetivo")}
      <div class="content-grid">
        <article class="surface-card">
          <div class="card-heading">
            <h3>Estado guardado</h3>
            <span class="pill">Persistente</span>
          </div>
          <p>Este espacio resume la red fijada y el contexto que la aplicacion conserva entre sesiones para seguir evaluando su seguridad.</p>
          <ul class="feature-list">
            <li><strong>SSID objetivo:</strong> ${escapeHtml(targetContext.targetSsid ?? selectedNetwork?.ssid ?? "No disponible")}</li>
            <li><strong>BSSID principal:</strong> ${escapeHtml(selectedNetwork?.bssid ?? "No disponible")}</li>
            <li><strong>Interfaz recordada:</strong> ${escapeHtml(targetContext.interface ?? "No disponible")}</li>
            <li><strong>Estado de conexion:</strong> ${escapeHtml(connection?.connected ? (connection.matchesExpectedTarget ? "Conectado a la red fijada" : "Conectado a otra red") : "No conectado")}</li>
            <li><strong>Comprobaciones guardadas:</strong> ${escapeHtml(completedChecks.join(", ") || "Ninguna")}</li>
          </ul>
        </article>

        <article class="surface-card">
          <div class="card-heading">
            <h3>Limpieza del estado</h3>
            <span class="pill">Control</span>
          </div>
          <p>Puedes limpiar el contexto persistido de la aplicacion para empezar otra auditoria con una red distinta o dejar el entorno limpio.</p>
          <ul class="feature-list">
            <li><strong>Desfijar red</strong>: elimina solo la red objetivo actual.</li>
            <li><strong>Limpiar estado</strong>: elimina la red fijada y tambien los resultados y jobs guardados en la interfaz.</li>
          </ul>
          <div class="workspace-actions">
            <button id="workspace-clear-target-button" type="button" class="secondary-action">Desfijar red</button>
            <button id="workspace-clear-state-button" type="button" class="danger-action">Limpiar estado</button>
          </div>
        </article>
      </div>
    `;

    const clearTargetButton = document.querySelector("#workspace-clear-target-button");
    clearTargetButton?.addEventListener("click", () => {
      clearTargetNetwork();
      uiState.showConnectForm = false;
      uiState.selectedJobId = null;
      uiState.dashboardConnectionView = null;
      activateView("dashboard");
    });

    const clearStateButton = document.querySelector("#workspace-clear-state-button");
    clearStateButton?.addEventListener("click", () => {
      stopAllPolling();
      clearApplicationState();
      uiState.showConnectForm = false;
      uiState.selectedJobId = null;
      uiState.dashboardConnectionView = null;
      activateView("dashboard");
    });
  }

  function renderDashboard(state) {
    const hasTargetNetwork = Boolean(state.targetNetwork);
    const tools = state.tools;
    const securityScore = hasTargetNetwork ? computeTargetSecurityScore(getTargetContext(state)) : null;

    activeJobsMetric.textContent = String(state.activeJobIds.length);
    toolsCountMetric.textContent = String(tools.length);
    if (securityScoreMetric) {
      securityScoreMetric.textContent = securityScore ? formatSecurityScore(securityScore) : "-";
      securityScoreMetric.className = securityScore
        ? `metric-score--${securityScore.tone}`
        : "metric-score--muted";
    }
    if (securityCoverageMetric) {
      securityCoverageMetric.textContent = securityScore ? `${securityScore.coveragePercent}%` : "-";
      securityCoverageMetric.className = securityScore
        ? `metric-score--${securityScore.coverageTone}`
        : "metric-score--muted";
    }
    badge.textContent = `${isTauriRuntime ? "Runtime Tauri activo" : "Vista web cargada"} · ${tools.length} tools`;

    renderTargetNetworkPanel(state);
    renderDashboardModeTabs(state);
    renderScanNetworksFeature(state);

    dashboardHero.hidden = !hasTargetNetwork;
    renderToolsList(tools);
    renderJobs(state);
    renderResultViewer(state);
    renderWorkspace(state);

    document.querySelectorAll("[data-job-select]").forEach((button) => {
      button.addEventListener("click", () => {
        uiState.selectedJobId = button.dataset.jobSelect;
        renderDashboard(getState());
      });
    });
  }

  navTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activateView(tab.dataset.view);
    });
  });

  subscribe((state) => {
    syncTargetProfileFromJobs(state);
    syncTargetWpsFromJobs(state);
    syncTargetUpnpFromJobs(state);
    syncTargetManagementServicesFromJobs(state);
    syncConnectionFromJobs(state);
    syncRouterProfileFromJobs(state);
    renderDashboard(getState());
  });

  discoverTools()
    .then((tools) => {
      uiState.toolDiscoveryError = null;
      setTools(tools);
      console.info("Tools MCP descubiertas:", tools);
    })
    .catch((error) => {
      uiState.toolDiscoveryError =
        error instanceof Error ? error.message : "Error desconocido";
      renderDashboard(getState());
      console.error("No se pudieron descubrir las tools MCP:", error);
    });

  window.wifitestMcp = {
    discoverTools,
    executeTool,
    getState,
    stopPolling,
    stopAllPolling,
  };

  activateView("dashboard");
  renderDashboard(getState());
});
