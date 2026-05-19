const COMMON_TERMS = [
  "1234",
  "12345",
  "123456",
  "12345678",
  "abcd",
  "qwerty",
  "asdf",
  "password",
  "passwd",
  "admin",
  "administrator",
  "welcome",
  "wifi",
  "internet",
  "router",
  "clave",
  "contrasena",
  "movistar",
  "orange",
  "vodafone",
  "jazztel",
  "digi",
];

function countCharacterSetVariety(password) {
  let variety = 0;
  if (/[a-z]/.test(password)) variety += 1;
  if (/[A-Z]/.test(password)) variety += 1;
  if (/\d/.test(password)) variety += 1;
  if (/[^A-Za-z0-9]/.test(password)) variety += 1;
  return variety;
}

function estimateCharsetPoolSize(password) {
  let poolSize = 0;
  if (/[a-z]/.test(password)) poolSize += 26;
  if (/[A-Z]/.test(password)) poolSize += 26;
  if (/\d/.test(password)) poolSize += 10;
  if (/[^A-Za-z0-9]/.test(password)) poolSize += 32;
  return poolSize;
}

function estimateEntropyBits(password) {
  const poolSize = estimateCharsetPoolSize(password);
  if (!password || poolSize <= 1) {
    return 0;
  }
  return Math.round(password.length * Math.log2(poolSize));
}

function uniqueCharacterRatio(password) {
  if (!password) {
    return 0;
  }
  return new Set(password).size / password.length;
}

function hasCommonPasswordTerm(password) {
  const lowered = password.toLowerCase();
  return COMMON_TERMS.some((term) => lowered.includes(term));
}

function hasSequentialRun(password, minimumLength = 4) {
  const lowered = password.toLowerCase();
  let ascendingRun = 1;
  let descendingRun = 1;

  for (let index = 1; index < lowered.length; index += 1) {
    const current = lowered.charCodeAt(index);
    const previous = lowered.charCodeAt(index - 1);

    ascendingRun = current === previous + 1 ? ascendingRun + 1 : 1;
    descendingRun = current === previous - 1 ? descendingRun + 1 : 1;

    if (ascendingRun >= minimumLength || descendingRun >= minimumLength) {
      return true;
    }
  }

  return false;
}

function hasRepeatedCharacters(password) {
  return /(.)\1{2,}/.test(password);
}

function hasRepeatedBlocks(password) {
  return /(..+)\1/.test(password);
}

function extractNetworkTokens(network) {
  const candidates = [
    String(network?.ssid ?? ""),
    String(network?.bssid ?? ""),
    String(network?.security ?? ""),
  ];

  return Array.from(
    new Set(
      candidates
        .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
        .map((value) => value.trim())
        .filter((value) => value.length >= 3),
    ),
  );
}

function hasNetworkRelatedTerm(password, network) {
  const lowered = password.toLowerCase();
  return extractNetworkTokens(network).some((token) => lowered.includes(token));
}

function scorePassword(password, network) {
  const length = password.length;
  const charsetVariety = countCharacterSetVariety(password);
  const entropyBits = estimateEntropyBits(password);
  const uniqueRatio = uniqueCharacterRatio(password);
  const containsCommonTerm = hasCommonPasswordTerm(password);
  const containsNetworkTerm = hasNetworkRelatedTerm(password, network);
  const hasSequence = hasSequentialRun(password);
  const repeatedCharacters = hasRepeatedCharacters(password);
  const repeatedBlocks = hasRepeatedBlocks(password);

  let score = 0;

  if (length >= 20) score += 35;
  else if (length >= 16) score += 28;
  else if (length >= 12) score += 20;
  else if (length >= 10) score += 14;
  else if (length >= 8) score += 8;
  else score += 2;

  score += charsetVariety * 8;

  if (uniqueRatio >= 0.8) score += 12;
  else if (uniqueRatio >= 0.65) score += 8;
  else if (uniqueRatio >= 0.5) score += 4;

  if (entropyBits >= 80) score += 20;
  else if (entropyBits >= 60) score += 14;
  else if (entropyBits >= 45) score += 8;
  else if (entropyBits >= 32) score += 4;

  if (containsCommonTerm) score -= 18;
  if (containsNetworkTerm) score -= 16;
  if (hasSequence) score -= 14;
  if (repeatedCharacters) score -= 10;
  if (repeatedBlocks) score -= 12;
  if (length < 12) score -= 10;
  if (charsetVariety < 3) score -= 8;
  if (uniqueRatio < 0.55) score -= 8;

  return {
    score: Math.max(0, Math.min(100, score)),
    details: {
      length,
      charsetVariety,
      entropyBits,
      uniqueRatio: Math.round(uniqueRatio * 100) / 100,
      containsCommonTerm,
      containsNetworkTerm,
      hasSequentialPattern: hasSequence,
      hasRepeatedCharacters: repeatedCharacters,
      hasRepeatedBlocks: repeatedBlocks,
    },
  };
}

export function analyzeWifiPasswordStrength(password, network = null) {
  const normalizedPassword = String(password ?? "");
  const security = String(network?.security ?? "").toUpperCase().trim();
  const isOpenNetwork = security === "OPEN";

  if (isOpenNetwork) {
    return {
      applicable: false,
      provided: normalizedPassword.trim() !== "",
      securityType: security || "OPEN",
      score: null,
      tone: "muted",
      headline: "No aplica",
      summary: "La red objetivo parece abierta, asi que no hay una clave Wi-Fi que evaluar en esta comprobacion.",
      recommendations: [
        "La ausencia de clave en una red abierta ya se refleja en la evaluacion global del protocolo Wi-Fi.",
      ],
      details: {
        length: 0,
        charsetVariety: 0,
        entropyBits: 0,
        uniqueRatio: 0,
        containsCommonTerm: false,
        containsNetworkTerm: false,
        hasSequentialPattern: false,
        hasRepeatedCharacters: false,
        hasRepeatedBlocks: false,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  if (normalizedPassword.trim() === "") {
    return {
      applicable: true,
      provided: false,
      securityType: security || "UNKNOWN",
      score: 0,
      tone: "bad",
      headline: "Clave no proporcionada",
      summary: "Todavia no hay una clave Wi-Fi evaluable para esta red protegida.",
      recommendations: [
        "Introduce la clave real de la red desde la aplicacion para poder valorar su robustez.",
      ],
      details: {
        length: 0,
        charsetVariety: 0,
        entropyBits: 0,
        uniqueRatio: 0,
        containsCommonTerm: false,
        containsNetworkTerm: false,
        hasSequentialPattern: false,
        hasRepeatedCharacters: false,
        hasRepeatedBlocks: false,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  const { score, details } = scorePassword(normalizedPassword, network);

  let tone = "bad";
  let headline = "Clave debil";
  let summary = "La clave parece demasiado predecible, corta o apoyada en patrones faciles de explotar.";
  const recommendations = [];

  if (score >= 85) {
    tone = "good";
    headline = "Clave robusta";
    summary = "La clave combina buena longitud, variedad de caracteres y pocos indicios de patrones previsibles.";
  } else if (score >= 60) {
    tone = "medium";
    headline = "Clave aceptable";
    summary = "La clave no parece trivial, pero aun hay margen para reforzarla frente a ataques de diccionario o adivinacion.";
  }

  if (details.length < 12) {
    recommendations.push("Intentar usar al menos 12 caracteres en la clave Wi-Fi.");
  }
  if (details.charsetVariety < 3) {
    recommendations.push("Mejorar la mezcla de caracteres combinando mayusculas, minusculas, numeros y simbolos.");
  }
  if (details.entropyBits < 60) {
    recommendations.push("Aumentar longitud y variedad para ampliar el espacio teorico de combinaciones.");
  }
  if (details.containsCommonTerm) {
    recommendations.push("Evitar palabras comunes o patrones tipicos como admin, wifi, password o secuencias numericas.");
  }
  if (details.containsNetworkTerm) {
    recommendations.push("No reutilizar partes del SSID, del proveedor o de la identidad visible de la red dentro de la clave.");
  }
  if (details.hasSequentialPattern) {
    recommendations.push("Evitar secuencias ascendentes o descendentes como 1234, abcd o variantes parecidas.");
  }
  if (details.hasRepeatedCharacters || details.hasRepeatedBlocks) {
    recommendations.push("Evitar repeticiones largas del mismo caracter o bloques repetidos dentro de la clave.");
  }
  if (!recommendations.length) {
    recommendations.push("Mantener una clave larga, poco predecible y distinta de otras claves del negocio.");
  }

  return {
    applicable: true,
    provided: true,
    securityType: security || "UNKNOWN",
    score,
    tone,
    headline,
    summary,
    recommendations,
    details,
    checkedAt: new Date().toISOString(),
  };
}
