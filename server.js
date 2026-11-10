"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const nodemailer = require("nodemailer");

const ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@.]{2,}$/;
const PHONE_PATTERN = /^[+()\d\s./-]{6,25}$/;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/src/styles/style.css", ["src/styles/style.css", "text/css; charset=utf-8"]],
  ["/src/scripts/script.js", ["src/scripts/script.js", "text/javascript; charset=utf-8"]],
  ["/src/scripts/privacy.js", ["src/scripts/privacy.js", "text/javascript; charset=utf-8"]],
  ["/src/data/marketing.json", ["src/data/marketing.json", "application/json; charset=utf-8"]],
  ["/ochrana-osobnich-udaju.html", ["ochrana-osobnich-udaju.html", "text/html; charset=utf-8"]],
  ["/images/fotografie-bude-doplnena.svg", ["public/images/fotografie-bude-doplnena.svg", "image/svg+xml"]],
  ["/favicon.svg", ["public/favicon.svg", "image/svg+xml"]],
  ["/favicon.ico", ["public/favicon.ico", "image/x-icon"]],
  ["/robots.txt", ["public/robots.txt", "text/plain; charset=utf-8"]]
]);
const LOCAL_IMAGE_TYPES = new Map([
  [".avif", "image/avif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"]
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  const smtpPort = Number(env.SMTP_PORT || 587);
  if (
    env.SMTP_SECURE !== undefined &&
    !["true", "false"].includes(env.SMTP_SECURE.toLowerCase())
  ) {
    throw new Error("SMTP_SECURE must be either true or false.");
  }
  const smtpSecure = env.SMTP_SECURE === undefined
    ? smtpPort === 465
    : env.SMTP_SECURE.toLowerCase() === "true";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  }
  if ((env.SMTP_USER && !env.SMTP_PASSWORD) || (!env.SMTP_USER && env.SMTP_PASSWORD)) {
    throw new Error("Set both SMTP_USER and SMTP_PASSWORD, or leave both empty.");
  }

  const smtp = {
    host: (env.SMTP_HOST || "").trim(),
    port: smtpPort,
    secure: smtpSecure,
    user: env.SMTP_USER || "",
    password: env.SMTP_PASSWORD || "",
    from: (env.SMTP_FROM || "").trim(),
    to: (env.SMTP_TO || "").trim()
  };
  const senderAddress = smtp.from.match(/<([^<>]+)>/)?.[1]?.trim() || smtp.from;
  const emailConfigured = Boolean(
    smtp.host &&
    smtp.host.length <= 255 &&
    !/\s/.test(smtp.host) &&
    !/[\r\n]/.test(smtp.from) &&
    EMAIL_PATTERN.test(senderAddress) &&
    EMAIL_PATTERN.test(smtp.to)
  );

  return {
    host: env.HOST || "0.0.0.0",
    port,
    smtp,
    emailConfigured,
    publicOrigin: env.PUBLIC_ORIGIN || ""
  };
}

function readDemoMode() {
  const configPath = path.join(ROOT, "src", "data", "marketing.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8")).demoMode === true;
}

function requiredString(body, field, label, maxLength) {
  const value = body[field];
  if (typeof value !== "string") {
    throw new HttpError(400, `Pole „${label}“ je povinné.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, `Pole „${label}“ je povinné.`);
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `Pole „${label}“ je příliš dlouhé.`);
  }
  return trimmed;
}

function optionalString(body, field, label, maxLength) {
  const value = body[field] ?? "";
  if (typeof value !== "string") {
    throw new HttpError(400, `Pole „${label}“ nemá platný formát.`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `Pole „${label}“ je příliš dlouhé.`);
  }
  return trimmed;
}

function validateDate(value) {
  if (!value) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "Požadovaný termín nemá platný formát.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new HttpError(400, "Požadovaný termín není platné datum.");
  }
  return value;
}

function validateQuote(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Formulář obsahuje neplatná data.");
  }
  if (typeof body.website === "string" && body.website.trim()) {
    throw new HttpError(400, "Formulář se nepodařilo ověřit.");
  }

  const name = requiredString(body, "name", "Jméno a příjmení", 120);
  const company = optionalString(body, "company", "Firma", 160);
  const phone = requiredString(body, "phone", "Telefon", 25);
  const email = requiredString(body, "email", "E-mail", 254).toLowerCase();
  const pickup = requiredString(body, "pickup", "Místo nakládky", 160);
  const delivery = requiredString(body, "delivery", "Místo vykládky", 160);
  const cargo = requiredString(body, "cargo", "Co potřebujete převézt", 1000);
  const dimensions = optionalString(body, "dimensions", "Rozměry a hmotnost", 240);
  const date = validateDate(optionalString(body, "date", "Požadovaný termín", 10));
  const message = optionalString(body, "message", "Další informace", 3000);

  if (name.length < 2 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name)) {
    throw new HttpError(400, "Zadejte platné jméno a příjmení.");
  }
  if (!PHONE_PATTERN.test(phone) || phone.replace(/\D/g, "").length < 6) {
    throw new HttpError(400, "Zadejte platné telefonní číslo.");
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, "Zadejte platnou e-mailovou adresu.");
  }
  if (body.privacyAcknowledgement !== "on" && body.privacyAcknowledgement !== true) {
    throw new HttpError(400, "Před odesláním potvrďte, že jste se seznámil/a se zásadami ochrany osobních údajů.");
  }

  return {
    name,
    company,
    phone,
    email,
    pickup,
    delivery,
    cargo,
    dimensions,
    date,
    message,
    privacyAcknowledgement: true
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function buildQuoteEmail(quote) {
  const fields = [
    ["Jméno a příjmení", quote.name],
    ["Firma", quote.company],
    ["Telefon", quote.phone],
    ["E-mail", quote.email],
    ["Místo nakládky", quote.pickup],
    ["Místo vykládky", quote.delivery],
    ["Co potřebujete převézt", quote.cargo],
    ["Rozměry a hmotnost", quote.dimensions],
    ["Požadovaný termín", quote.date],
    ["Další informace", quote.message],
    ["Potvrzení seznámení se zásadami ochrany osobních údajů", quote.privacyAcknowledgement ? "Ano" : "Ne"]
  ];

  const text = [
    "Nová nezávazná poptávka z webu autoteď.cz",
    "",
    ...fields.map(([label, value]) => `${label}: ${value || "Neuvedeno"}`)
  ].join("\n");
  const rows = fields.map(([label, value]) =>
    `<tr><th align="left" valign="top" style="padding:8px 12px;border-bottom:1px solid #e6ebf0">${escapeHtml(label)}</th><td valign="top" style="padding:8px 12px;border-bottom:1px solid #e6ebf0;white-space:pre-wrap">${escapeHtml(value || "Neuvedeno")}</td></tr>`
  ).join("");

  return {
    subject: `Nová poptávka na přepravu – ${quote.name}`,
    text,
    html: `<div style="font-family:Arial,sans-serif;color:#132d47"><h2 style="color:#071b33">Nová nezávazná poptávka z webu autoteď.cz</h2><table style="width:100%;max-width:720px;border-collapse:collapse">${rows}</table></div>`,
    replyTo: quote.email
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let oversized = false;

    const declaredLength = Number(request.headers["content-length"] || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      request.resume();
      reject(new HttpError(413, "Odeslaný formulář je příliš velký."));
      return;
    }

    request.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        reject(new HttpError(413, "Odeslaný formulář je příliš velký."));
      } else if (!oversized) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (oversized) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Formulář obsahuje neplatná data."));
      }
    });
    request.on("error", reject);
  });
}

function createRateLimiter({ limit, windowMs, now, maxEntries }) {
  const requestsByIp = new Map();
  return (ip) => {
    const currentTime = now();
    let entry = requestsByIp.get(ip);
    if (!entry || entry.resetAt <= currentTime) {
      for (const [key, value] of requestsByIp) {
        if (value.resetAt <= currentTime) requestsByIp.delete(key);
      }
      if (requestsByIp.size >= maxEntries) return false;
      entry = { count: 0, resetAt: currentTime + windowMs };
      requestsByIp.set(ip, entry);
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  };
}

function createAppServer({
  config = readConfig(),
  sendMail,
  now = Date.now,
  rateLimitMaxRequests = RATE_LIMIT_MAX_REQUESTS,
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
  demoMode
} = {}) {
  const isDemoMode = demoMode === undefined ? readDemoMode() : demoMode;
  const transport = sendMail
    ? { sendMail }
    : config.emailConfigured
      ? nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        ...(!config.smtp.secure ? { requireTLS: true } : {}),
        ...(config.smtp.user ? {
          auth: { user: config.smtp.user, pass: config.smtp.password }
        } : {}),
        tls: { minVersion: "TLSv1.2" }
      })
      : null;
  const rateLimit = createRateLimiter({
    limit: rateLimitMaxRequests,
    windowMs: rateLimitWindowMs,
    now,
    maxEntries: MAX_RATE_LIMIT_ENTRIES
  });

  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cache-Control", "no-store");

    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/robots.txt" || url.pathname === "/sitemap.xml") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        sendJson(response, 405, { message: "Tato metoda není povolená." });
        return;
      }
      try {
        const origin = getConfiguredSiteOrigin();
        const content = url.pathname === "/robots.txt"
          ? await buildRobotsTxt(origin)
          : buildSitemapXml(origin);
        sendText(response, 200, url.pathname === "/robots.txt" ? "text/plain; charset=utf-8" : "application/xml; charset=utf-8", content, request.method);
      } catch (error) {
        console.error("SEO file generation failed:", error.message);
        sendText(response, 500, "text/plain; charset=utf-8", "SEO soubor se nepodařilo vygenerovat.\n", request.method);
      }
      return;
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/api/quote") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { message: "Tento endpoint přijímá pouze odeslání formuláře." });
        return;
      }

      try {
        checkOrigin(request, config.publicOrigin);
        const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          throw new HttpError(415, "Formulář musí být odeslán jako JSON.");
        }

        const clientIp = request.socket.remoteAddress || "unknown";
        if (!rateLimit(clientIp)) {
          response.setHeader("Retry-After", String(Math.ceil(rateLimitWindowMs / 1000)));
          throw new HttpError(429, "Bylo odesláno příliš mnoho poptávek. Zkuste to prosím později.");
        }

        const body = await readJsonBody(request);
        const quote = validateQuote(body);
        if (isDemoMode) {
          sendJson(response, 503, {
            message: "Ukázková verze webu poptávky nepřijímá ani neposílá. Odesílání je vypnuté."
          });
          return;
        }
        if (!transport) {
          sendJson(response, 503, {
            message: "Odesílání e-mailů zatím není nakonfigurované. Správce webu musí doplnit SMTP nastavení."
          });
          return;
        }

        try {
          await transport.sendMail({
            from: config.smtp.from,
            to: config.smtp.to,
            ...buildQuoteEmail(quote)
          });
        } catch (error) {
          console.error("Quote email delivery failed:", error.code || "SMTP_ERROR");
          sendJson(response, 502, {
            message: "E-mail se nepodařilo odeslat. Zkuste to prosím později nebo nás kontaktujte telefonicky."
          });
          return;
        }

        sendJson(response, 200, { ok: true, message: "Poptávka byla úspěšně odeslána." });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof HttpError
          ? error.message
          : "Poptávku se nepodařilo zpracovat. Zkuste to prosím později.";
        if (status === 500) console.error("Quote request failed:", error.message);
        sendJson(response, status, { message });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, { message: "Tato metoda není povolená." });
      return;
    }

    const staticFile = STATIC_FILES.get(url.pathname) || getLocalImageFile(url.pathname);
    if (!staticFile) {
      sendJson(response, 404, { message: "Stránka nebyla nalezena." });
      return;
    }
    const [relativePath, contentType] = staticFile;
    try {
      const filePath = path.join(ROOT, relativePath);
      const content = await fs.promises.readFile(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType);
      response.setHeader(
        "Cache-Control",
        relativePath === "src/data/marketing.json"
          ? "no-store"
          : [
              "index.html",
              "ochrana-osobnich-udaju.html",
              "src/styles/style.css",
              "src/scripts/script.js",
              "src/scripts/privacy.js"
            ].includes(relativePath)
          ? "no-cache"
          : "public, max-age=3600"
      );
      if (request.method === "HEAD") response.end();
      else response.end(content);
    } catch (error) {
      console.error("Static file read failed:", error.code || "FILE_ERROR");
      sendJson(response, 500, { message: "Stránku se nepodařilo načíst." });
    }
  });
}

function getLocalImageFile(urlPath) {
  const match = /^\/images\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(urlPath);
  if (!match || match[1].includes("..")) return null;
  const extension = path.extname(match[1]).toLowerCase();
  const contentType = LOCAL_IMAGE_TYPES.get(extension);
  return contentType ? [`public/images/${match[1]}`, contentType] : null;
}

function getConfiguredSiteOrigin() {
  const configPath = path.join(ROOT, "src/data/marketing.json");
  const siteConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!siteConfig.siteUrl) return "";

  const siteUrl = new URL(siteConfig.siteUrl);
  if (
    !["http:", "https:"].includes(siteUrl.protocol) ||
    siteUrl.username ||
    siteUrl.password
  ) {
    throw new Error("siteUrl must be a public HTTP or HTTPS address.");
  }
  return siteUrl.origin;
}

async function buildRobotsTxt(origin) {
  const template = await fs.promises.readFile(path.join(ROOT, "public/robots.txt"), "utf8");
  const lines = template.trimEnd().split(/\r?\n/);
  if (origin) lines.push(`Sitemap: ${origin}/sitemap.xml`);
  return `${lines.join("\n")}\n`;
}

function buildSitemapXml(origin) {
  const pages = origin
    ? [`${origin}/`, `${origin}/ochrana-osobnich-udaju.html`]
    : [];
  const urls = pages.map((page) =>
    `  <url>\n    <loc>${escapeXml(page)}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>${page.endsWith("/") ? "1.0" : "0.3"}</priority>\n  </url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${urls ? "\n" : ""}</urlset>\n`;
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  })[character]);
}

function checkOrigin(request, allowedOrigin) {
  const origin = request.headers.origin;
  if (!origin) return;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "Původ požadavku se nepodařilo ověřit.");
  }
  if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
    throw new HttpError(403, "Původ požadavku se nepodařilo ověřit.");
  }
  const expectedOrigin = allowedOrigin || `${parsedOrigin.protocol}//${request.headers.host}`;
  if (parsedOrigin.origin !== expectedOrigin.replace(/\/$/, "")) {
    throw new HttpError(403, "Poptávku lze odeslat pouze z tohoto webu.");
  }
}

function sendJson(response, status, body) {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendText(response, status, contentType, content, method) {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.end(method === "HEAD" ? undefined : content);
}

if (require.main === module) {
  try {
    const config = readConfig();
    const server = createAppServer({ config });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.listen(config.port, config.host, () => {
      console.log(`Autoteď.cz server naslouchá na ${config.host}:${config.port}.`);
      if (!config.emailConfigured) {
        console.warn("SMTP není nakonfigurované; poptávkový formulář zatím nebude odesílat e-maily.");
      }
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        server.close((error) => {
          if (error) {
            console.error("Server shutdown failed:", error.message);
            process.exitCode = 1;
          }
        });
      });
    }
  } catch (error) {
    console.error("Server configuration failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  buildQuoteEmail,
  buildRobotsTxt,
  buildSitemapXml,
  createAppServer,
  readConfig,
  validateQuote
};
