const SCORE_MAX = 10;

// Para añadir una nueva tool al scoring basta con sumar una regla nueva que
// lea el estado derivado de `targetNetwork` y devuelva un resultado homogéneo.
const SECURITY_SCORING_RULES = [
  {
    id: "wifi_protocol",
    title: "Protocolo Wi-Fi",
    pendingLabel: "Actualizar el perfil principal de la red para confirmar el protocolo Wi-Fi.",
    evaluate: (context) => {
      const network = context?.primaryNetwork;
      const security = String(network?.security ?? "").toUpperCase().trim();

      if (!network || !security) {
        return unknownRuleResult("Todavia no hay un perfil suficiente del protocolo Wi-Fi.");
      }

      if (security === "WPA3") {
        return positiveRuleResult(
          "WPA3 detectado",
          "La red anuncia WPA3, que hoy es la opcion mas fuerte de las observadas en esta revision.",
        );
      }

      if (security === "WPA2") {
        return warningRuleResult(
          "WPA2 en uso",
          "La red anuncia WPA2. Sigue siendo una opcion valida, aunque ya no es la mas moderna.",
          -0.6,
          ["Valorar WPA3 si el router y los dispositivos lo soportan."],
        );
      }

      if (security === "WPA/WPA2") {
        return warningRuleResult(
          "Modo mixto heredado",
          "La red combina compatibilidad antigua y moderna, lo que mantiene superficie heredada innecesaria en muchos casos.",
          -1.1,
          ["Intentar dejar la red en WPA2 o WPA3 si no necesitas compatibilidad antigua."],
        );
      }

      if (security === "WPA") {
        return negativeRuleResult(
          "WPA antiguo",
          "La red anuncia WPA, una opcion heredada que conviene sustituir por WPA2 o WPA3.",
          -2.6,
          ["Migrar el protocolo Wi-Fi a WPA2 o WPA3 cuanto antes."],
        );
      }

      if (security === "WEP") {
        return negativeRuleResult(
          "WEP inseguro",
          "La red anuncia WEP, una configuracion obsoleta y claramente insegura.",
          -4.8,
          ["Eliminar WEP y cambiar a WPA2 o WPA3 de forma prioritaria."],
        );
      }

      if (security === "OPEN") {
        return negativeRuleResult(
          "Red abierta",
          "La red parece abierta y no anuncia una barrera de acceso robusta.",
          -6.0,
          ["Activar WPA2 o WPA3 para evitar acceso libre a la red."],
        );
      }

      return warningRuleResult(
        "Protocolo no concluyente",
        "La red anuncia un protocolo que necesita contexto adicional antes de valorarlo bien.",
        -1.4,
        ["Revisar la configuracion del router para confirmar el protocolo real anunciado."],
      );
    },
  },
  {
    id: "wifi_cipher",
    title: "Cipher Wi-Fi",
    pendingLabel: "Actualizar el perfil de red para confirmar el cifrado observado.",
    evaluate: (context) => {
      const network = context?.primaryNetwork;
      const cipher = String(network?.cipher ?? "").toUpperCase().trim();

      if (!network || !cipher) {
        return unknownRuleResult("No hay suficiente informacion del cipher Wi-Fi.");
      }

      if (cipher.includes("CCMP") && !cipher.includes("TKIP")) {
        return positiveRuleResult(
          "Cipher moderno",
          "La red anuncia CCMP/AES sin arrastrar TKIP, lo que encaja con una configuracion actual.",
        );
      }

      if (cipher.includes("CCMP") && cipher.includes("TKIP")) {
        return warningRuleResult(
          "Cipher mixto con TKIP",
          "La red sigue anunciando TKIP junto a CCMP, lo que sugiere compatibilidad heredada que conviene revisar.",
          -0.8,
          ["Intentar eliminar TKIP y dejar solo CCMP/AES si el router lo permite."],
        );
      }

      if (cipher.includes("TKIP")) {
        return negativeRuleResult(
          "TKIP heredado",
          "El cipher observado incluye TKIP, una opcion antigua menos recomendable.",
          -1.6,
          ["Desactivar TKIP y mantener solo cifrados modernos como CCMP/AES."],
        );
      }

      return warningRuleResult(
        "Cipher poco claro",
        "El valor de cipher detectado no permite una conclusion fuerte y conviene revisarlo manualmente.",
        -0.6,
        ["Revisar en el router el tipo exacto de cifrado configurado."],
      );
    },
  },
  {
    id: "wifi_password_strength",
    title: "Robustez de la clave Wi-Fi",
    pendingLabel: "Conectarte desde la aplicacion con la clave real para poder evaluar su robustez.",
    evaluate: (context) => {
      const assessment = context?.targetNetwork?.passwordAssessment ?? null;
      if (!assessment) {
        return unknownRuleResult("Todavia no hay una evaluacion de la clave Wi-Fi.");
      }

      if (!assessment.applicable) {
        return positiveRuleResult(
          "Sin clave aplicable",
          "La evaluacion de clave no aplica a esta red porque no se ha tratado como una red protegida con password.",
        );
      }

      if (!assessment.provided) {
        return unknownRuleResult("La aplicacion todavia no ha confirmado una clave Wi-Fi valida para esta red.");
      }

      if ((assessment.score ?? 0) >= 80) {
        return positiveRuleResult(
          "Clave robusta",
          "La clave Wi-Fi analizada tiene una longitud y una complejidad razonables para esta revision.",
        );
      }

      if ((assessment.score ?? 0) >= 55) {
        return warningRuleResult(
          "Clave mejorable",
          "La clave Wi-Fi no parece trivial, pero todavia podria reforzarse para resistir mejor ataques de adivinacion o diccionario.",
          -0.7,
          assessment.recommendations ?? [],
        );
      }

      return negativeRuleResult(
        "Clave debil",
        "La clave Wi-Fi analizada parece demasiado predecible o corta para el nivel de proteccion deseable.",
        -2.5,
        assessment.recommendations ?? [],
      );
    },
  },
  {
    id: "wps_exposure",
    title: "Exposicion WPS",
    pendingLabel: "Ejecutar la comprobacion WPS para saber si esta superficie esta activa.",
    evaluate: (context) => {
      const normalized = context?.targetNetwork?.wps?.normalized ?? null;
      if (!normalized) {
        return unknownRuleResult("Todavia no se ha medido la exposicion WPS.");
      }

      if (!normalized.wps_detected) {
        return positiveRuleResult(
          "WPS no detectado",
          "No se ha observado WPS en la red objetivo durante la comprobacion.",
        );
      }

      if (normalized.wps_locked) {
        return warningRuleResult(
          "WPS visible con bloqueo",
          "La red anuncia WPS y eso ya suma riesgo, aunque parece existir cierta mitigacion frente a intentos repetidos.",
          -1.1,
          ["Desactivar WPS por completo si no es imprescindible."],
        );
      }

      return negativeRuleResult(
        "WPS expuesto",
        "La red anuncia WPS sin una mitigacion clara. Es una superficie adicional de acceso poco recomendable.",
        -1.9,
        ["Desactivar WPS en el router cuanto antes."],
      );
    },
  },
  {
    id: "upnp_exposure",
    title: "Exposicion UPnP",
    pendingLabel: "Lanzar la comprobacion UPnP para verificar si el router responde en la LAN.",
    evaluate: (context) => {
      const normalized = context?.targetNetwork?.upnp?.normalized ?? null;
      if (!normalized) {
        return unknownRuleResult("Todavia no se ha revisado UPnP en el router conectado.");
      }

      if (!normalized.upnp_detected) {
        return positiveRuleResult(
          "UPnP no detectado",
          "No se han observado respuestas UPnP/SSDP del router durante la comprobacion actual.",
        );
      }

      if (normalized.port_mapping_capable || normalized.wan_ip_connection_service) {
        return negativeRuleResult(
          "UPnP con capacidad relevante",
          "El router parece exponer servicios UPnP/IGD que podrian facilitar aperturas automaticas de puertos.",
          -1.2,
          ["Si no se utiliza, conviene desactivar UPnP desde el panel del router."],
        );
      }

      return warningRuleResult(
        "UPnP detectado",
        "Se ha visto actividad UPnP, aunque sin evidencia fuerte de mapeo de puertos en esta revision.",
        -0.6,
        ["Revisar en el router si UPnP esta activo y si realmente hace falta."],
      );
    },
  },
  {
    id: "router_web_admin_transport",
    title: "Transporte del panel web",
    pendingLabel: "Identificar el router para saber si el panel usa HTTP, HTTPS o ambos.",
    evaluate: (context) => {
      const routerProfile = context?.targetNetwork?.routerProfile?.normalized ?? null;
      const webAdmin = routerProfile?.web_admin ?? null;

      if (!routerProfile || !webAdmin) {
        return unknownRuleResult("Todavia no hay identificacion del panel web del router.");
      }

      const httpReachable = Boolean(webAdmin.http?.reachable);
      const httpsReachable = Boolean(webAdmin.https?.reachable);

      if (!httpReachable && !httpsReachable) {
        return positiveRuleResult(
          "Panel web no observado",
          "No se ha detectado panel web accesible en las rutas revisadas durante esta comprobacion.",
        );
      }

      if (httpReachable && !httpsReachable) {
        return negativeRuleResult(
          "Panel solo por HTTP",
          "El panel del router responde por HTTP sin una alternativa HTTPS clara, lo que implica gestion sin cifrado.",
          -1.4,
          ["Priorizar HTTPS para la administracion del router si existe esa opcion."],
        );
      }

      if (httpReachable && httpsReachable) {
        return warningRuleResult(
          "HTTP y HTTPS activos",
          "El panel responde por HTTPS, pero tambien sigue aceptando HTTP, lo que mantiene una via menos segura.",
          -0.6,
          ["Desactivar HTTP si el router permite dejar solo HTTPS."],
        );
      }

      return positiveRuleResult(
        "Panel por HTTPS",
        "La administracion web observada responde por HTTPS, lo que reduce la exposicion frente a gestion sin cifrado.",
      );
    },
  },
  {
    id: "router_admin_auth",
    title: "Autenticacion del panel",
    pendingLabel: "Identificar el router para confirmar el tipo de autenticacion del panel.",
    evaluate: (context) => {
      const adminAuth = context?.targetNetwork?.routerProfile?.normalized?.admin_auth ?? null;

      if (!adminAuth || adminAuth.auth_required == null) {
        return unknownRuleResult("No se ha determinado todavia si el panel exige autenticacion.");
      }

      if (adminAuth.auth_required === false) {
        return negativeRuleResult(
          "Panel sin autenticacion aparente",
          "No se ha detectado una barrera clara de autenticacion en el panel, lo que seria un hallazgo muy grave.",
          -3.0,
          ["Revisar el panel del router de inmediato y confirmar que exige autenticacion."],
        );
      }

      if (adminAuth.auth_type === "password_only") {
        return warningRuleResult(
          "Panel con solo contrasena",
          "El panel parece pedir solo contrasena. Es util, pero suele ser menos robusto que separar usuario y contrasena.",
          -0.8,
          ["Confirmar si el router permite reforzar o cambiar el esquema de acceso administrativo."],
        );
      }

      if (adminAuth.auth_type === "username_password") {
        return positiveRuleResult(
          "Usuario y contrasena requeridos",
          "El panel parece exigir usuario y contrasena, una base razonable para administracion local.",
        );
      }

      if (adminAuth.auth_type === "http_auth") {
        return warningRuleResult(
          "Autenticacion HTTP detectada",
          "El panel requiere autenticacion HTTP. Es mejor que no exigir nada, aunque conviene revisar bien el flujo de acceso.",
          -0.4,
          ["Comprobar manualmente el panel para revisar el metodo de autenticacion exacto."],
        );
      }

      return warningRuleResult(
        "Autenticacion requerida",
        "El panel exige autenticacion, pero todavia no se ha clasificado con mas detalle el mecanismo concreto.",
        -0.3,
        ["Seguir enriqueciendo la inspeccion del mecanismo de login del router."],
      );
    },
  },
  {
    id: "router_admin_credentials",
    title: "Credenciales del panel",
    pendingLabel: "Completar la evaluacion asistida para indicar si la clave del panel sigue siendo la inicial o ya fue cambiada.",
    evaluate: (context) => {
      const assessment = context?.targetNetwork?.adminCredentialsAssessment ?? null;
      const adminAuth = context?.targetNetwork?.routerProfile?.normalized?.admin_auth ?? null;

      if (!adminAuth || adminAuth.auth_required == null) {
        return unknownRuleResult("Todavia no se ha identificado con suficiente detalle el acceso al panel del router.");
      }

      if (adminAuth.auth_required === false) {
        return positiveRuleResult(
          "No aplica",
          "Esta comprobacion no aplica porque el panel no parece requerir credenciales administrativas en el flujo observado.",
        );
      }

      if (!assessment) {
        return unknownRuleResult("Todavia no se ha completado la evaluacion asistida de credenciales del panel.");
      }

      if (assessment.status === "changed_by_user") {
        return positiveRuleResult(
          "Credencial personalizada",
          "El usuario indica que la clave del panel ya fue cambiada y no sigue siendo la credencial inicial del router.",
          [
            "Guardar esta practica: mantener una clave administrativa personalizada reduce mucho el riesgo de acceso no autorizado.",
          ],
        );
      }

      if (assessment.status === "factory_unique") {
        return warningRuleResult(
          "Clave inicial unica",
          "La clave del panel parece seguir siendo la inicial del equipo o la entregada por la operadora. No es una credencial universal, pero sigue siendo mejor cambiarla.",
          -0.9,
          [
            "Cambiar la clave administrativa del panel por una personalizada y solo conocida por el responsable de la red.",
          ],
        );
      }

      if (assessment.status === "factory_common") {
        return negativeRuleResult(
          "Credencial por defecto conocida",
          "La evaluacion asistida indica que el panel sigue dependiendo de una credencial generica o conocida, lo que eleva mucho el riesgo de acceso administrativo no autorizado.",
          -2.6,
          [
            "Cambiar de inmediato la credencial administrativa por una combinacion personalizada y robusta.",
          ],
        );
      }

      return warningRuleResult(
        "Sin confirmar",
        "Todavia no hay certeza suficiente sobre si la credencial del panel sigue siendo la inicial o ya fue cambiada.",
        -0.5,
        [
          "Comprobar manualmente si la clave del panel sigue siendo la de origen y, si es asi, sustituirla por una personalizada.",
        ],
      );
    },
  },
  {
    id: "management_services",
    title: "Servicios de administracion",
    pendingLabel: "Ejecutar el analisis de servicios de administracion del router.",
    evaluate: (context) => {
      const normalized = context?.targetNetwork?.managementServices?.normalized ?? null;
      if (!normalized) {
        return unknownRuleResult("Todavia no se han revisado los puertos y servicios de administracion.");
      }

      const detectedServices = (normalized.services ?? []).filter((service) => service?.reachable);
      if (!detectedServices.length) {
        return positiveRuleResult(
          "Sin servicios sensibles detectados",
          "No se han observado servicios de administracion abiertos en los puertos revisados durante esta comprobacion.",
        );
      }

      let delta = 0;
      const details = [];
      const recommendations = [];

      const hasPort = (port) => detectedServices.some((service) => Number(service.port) === port);

      if (hasPort(23)) {
        delta -= 2.5;
        details.push("Telnet abierto");
        recommendations.push("Desactivar Telnet si no es estrictamente necesario.");
      }
      if (hasPort(21)) {
        delta -= 1.4;
        details.push("FTP abierto");
        recommendations.push("Cerrar FTP si no se utiliza para una funcion concreta del router.");
      }
      if (hasPort(161)) {
        delta -= 1.5;
        details.push("SNMP accesible");
        recommendations.push("Revisar SNMP y desactivarlo o endurecerlo si no se necesita.");
      }
      if (hasPort(7547)) {
        delta -= 0.8;
        details.push("TR-069/CWMP visible");
        recommendations.push("Confirmar con el panel o el operador si TR-069 debe estar accesible en la LAN.");
      }
      if (hasPort(22)) {
        delta -= 0.5;
        details.push("SSH abierto");
        recommendations.push("Cerrar SSH si no se usa para administracion real.");
      }
      if (hasPort(8080) || hasPort(8443)) {
        delta -= 0.6;
        details.push("Puertos alternativos de administracion");
        recommendations.push("Revisar por que existen puertos alternativos de gestion y si son necesarios.");
      }
      if (detectedServices.length >= 4) {
        delta -= 0.6;
        details.push("Superficie amplia de gestion");
        recommendations.push("Reducir el numero de servicios de gestion expuestos si el router lo permite.");
      }

      if (delta <= -2.5) {
        return negativeRuleResult(
          "Servicios sensibles expuestos",
          `Se han detectado varios servicios de administracion relevantes: ${details.join(", ")}.`,
          delta,
          recommendations,
        );
      }

      return warningRuleResult(
        "Servicios de gestion activos",
        `El router expone servicios de administracion en la LAN: ${details.join(", ")}.`,
        delta || -0.4,
        recommendations,
      );
    },
  },
];

function unknownRuleResult(summary) {
  return {
    status: "unknown",
    summary,
    delta: 0,
    recommendations: [],
  };
}

function positiveRuleResult(title, summary, recommendations = []) {
  return {
    status: "positive",
    title,
    summary,
    delta: 0,
    recommendations,
  };
}

function warningRuleResult(title, summary, delta, recommendations = []) {
  return {
    status: "warning",
    title,
    summary,
    delta,
    recommendations,
  };
}

function negativeRuleResult(title, summary, delta, recommendations = []) {
  return {
    status: "negative",
    title,
    summary,
    delta,
    recommendations,
  };
}

function clampScore(value) {
  return Math.max(0, Math.min(SCORE_MAX, value));
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean)));
}

function collectKnownTimestamps(context) {
  const targetNetwork = context?.targetNetwork ?? null;
  const candidates = [
    targetNetwork?.fixedAt,
    targetNetwork?.scanResult?.normalized?.completed_at,
    targetNetwork?.profile?.normalized?.completed_at,
    targetNetwork?.wps?.normalized?.completed_at,
    targetNetwork?.upnp?.normalized?.completed_at,
    targetNetwork?.managementServices?.normalized?.completed_at,
    targetNetwork?.routerProfile?.normalized?.completed_at,
    targetNetwork?.passwordAssessmentUpdatedAt,
    targetNetwork?.adminCredentialsAssessment?.checkedAt,
    targetNetwork?.profileRefreshedAt,
    targetNetwork?.wpsRefreshedAt,
    targetNetwork?.upnpRefreshedAt,
    targetNetwork?.managementServicesRefreshedAt,
    targetNetwork?.routerProfileRefreshedAt,
  ]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());

  return candidates.length > 0 ? candidates[0].toISOString() : null;
}

function getScoreTone(score) {
  if (score >= 8) {
    return "good";
  }
  if (score >= 5.5) {
    return "medium";
  }
  return "bad";
}

function getScoreHeadline(score) {
  if (score >= 8.5) {
    return "Seguridad fuerte";
  }
  if (score >= 7) {
    return "Seguridad aceptable";
  }
  if (score >= 5.5) {
    return "Seguridad mejorable";
  }
  return "Seguridad fragil";
}

function getCoverageTone(coveragePercent) {
  if (coveragePercent >= 75) {
    return "good";
  }
  if (coveragePercent >= 45) {
    return "medium";
  }
  return "muted";
}

function buildSummary(score, findings, pendingChecks, coveragePercent) {
  if (!findings.length && !pendingChecks.length) {
    return "No se han detectado señales claras de riesgo en los factores ya revisados y la cobertura del analisis es amplia.";
  }

  if (!findings.length) {
    return `No se han detectado hallazgos graves en los factores ya medidos. La puntuacion es provisional porque todavia queda ${coveragePercent < 50 ? "bastante" : "algo de"} cobertura pendiente.`;
  }

  const topFinding = findings[0];
  if (!pendingChecks.length) {
    return `El factor que mas esta penalizando la nota ahora mismo es "${topFinding.title.toLowerCase()}". El resto del analisis ya cubre la mayoria de comprobaciones planteadas.`;
  }

  return `El factor que mas esta penalizando la nota ahora mismo es "${topFinding.title.toLowerCase()}". Ademas, todavia quedan ${pendingChecks.length} comprobacion(es) sin ejecutar, asi que la puntuacion sigue siendo provisional.`;
}

export function computeTargetSecurityScore(targetContext) {
  if (!targetContext?.targetNetwork) {
    return null;
  }

  const ruleResults = SECURITY_SCORING_RULES.map((rule) => {
    const result = rule.evaluate(targetContext);
    return {
      id: rule.id,
      title: rule.title,
      pendingLabel: rule.pendingLabel,
      ...result,
    };
  });

  const assessedRules = ruleResults.filter((result) => result.status !== "unknown");
  const pendingChecks = ruleResults
    .filter((result) => result.status === "unknown")
    .map((result) => ({
      id: result.id,
      title: result.title,
      summary: result.pendingLabel,
    }));

  const deductions = ruleResults
    .filter((result) => result.delta < 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

  const positiveSignals = ruleResults
    .filter((result) => result.status === "positive")
    .map((result) => ({
      id: result.id,
      title: result.title,
      summary: result.summary,
    }));

  const totalDelta = ruleResults.reduce((accumulator, result) => accumulator + Number(result.delta || 0), 0);
  const score = clampScore(SCORE_MAX + totalDelta);
  const roundedScore = Math.round(score * 10) / 10;
  const coveragePercent = Math.round((assessedRules.length / SECURITY_SCORING_RULES.length) * 100);
  const recommendationPool = uniqueStrings(
    ruleResults.flatMap((result) => result.recommendations ?? []),
  );

  return {
    score: roundedScore,
    scoreMax: SCORE_MAX,
    scorePercent: Math.round((roundedScore / SCORE_MAX) * 100),
    tone: getScoreTone(roundedScore),
    headline: getScoreHeadline(roundedScore),
    coveragePercent,
    coverageTone: getCoverageTone(coveragePercent),
    assessedRulesCount: assessedRules.length,
    totalRulesCount: SECURITY_SCORING_RULES.length,
    findings: deductions.map((result) => ({
      id: result.id,
      title: result.title,
      summary: result.summary,
      delta: result.delta,
    })),
    positiveSignals,
    pendingChecks,
    recommendations: recommendationPool.slice(0, 6),
    summary: buildSummary(roundedScore, deductions, pendingChecks, coveragePercent),
    updatedAt: collectKnownTimestamps(targetContext),
    isProvisional: pendingChecks.length > 0,
    rules: ruleResults,
  };
}

export { SECURITY_SCORING_RULES };
