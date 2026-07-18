const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const MAPS_URL_LOGIN = "https://maps-sistemas.com/login#/";
const MAPS_URL_QUOTES = "https://maps-sistemas.com/#/quotes";

// -----------------------------------------------------------------------
// CACHE simple en memoria (24h) para los catálogos de Maps Seguros.
// Evita abrir un navegador cada vez que alguien abre el formulario.
// -----------------------------------------------------------------------
const cache = {};
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheGet(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.time < CACHE_TTL_MS) return entry.value;
  return null;
}
function cacheSet(key, value) {
  cache[key] = { value, time: Date.now() };
}

const normalizar = (v) => (v || "").toString().trim().toUpperCase();

// Guardamos aquí el detalle del último intento (éxito o error), para poder
// verlo directo abriendo una URL en el navegador, sin depender de los logs
// de Easypanel ni de las herramientas de desarrollador
let ultimoDiagnostico = { mensaje: "Todavía no se ha hecho ninguna cotización." };

// -----------------------------------------------------------------------
// Helpers compartidos de Playwright
// -----------------------------------------------------------------------

// Abre sesión en Maps Seguros y deja la página lista en Cotizaciones
// (la pestaña "Datos del Cliente" queda activa por defecto)
async function abrirCotizadorLogueado() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(MAPS_URL_LOGIN, { waitUntil: "networkidle" });
  await page.fill("#email", process.env.MAPS_SEGUROS_USER);
  await page.fill("#password", process.env.MAPS_SEGUROS_PASS);
  await page.click('button:has-text("INGRESAR")');
  await page.waitForFunction(() => !window.location.href.includes("/login"), {
    timeout: 15000,
  });

  await page.goto(MAPS_URL_QUOTES, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Cotizaciones", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Al entrar a #/quotes caemos en la LISTA de cotizaciones existentes,
  // hay que dar clic en "+ Nuevo" para abrir el formulario real
  const btnNuevo = page.getByRole("button", { name: "Nuevo" });
  await btnNuevo.waitFor({ state: "visible", timeout: 20000 });
  await btnNuevo.click();
  await page.waitForTimeout(1500);

  return { browser, page };
}

// Navega a la pestaña "Datos de la Unidad" y asegura que "Tipo de Transporte"
// quede en "Automóvil" (si no se fija explícito, el catálogo de Marca puede
// cargar el de motocicletas/camiones en vez de autos)
async function irADatosDeLaUnidad(page) {
  const tab = page.getByText("Datos de la Unidad", { exact: true });
  await tab.waitFor({ state: "visible", timeout: 30000 });
  await tab.click();
  await page.waitForTimeout(500);
  await selectByLabel(page, "Tipo de Transporte", "Automóvil");
  await page.waitForTimeout(500);
}

// Selecciona una opción de un <select> ubicado justo después de una etiqueta visible.
// Compara el texto normalizado (sin espacios extra, mayúsculas) para evitar fallos
// por diferencias invisibles de formato en el catálogo de Maps Seguros.
async function selectByLabel(page, labelText, optionLabel) {
  const select = page
    .locator(`xpath=//label[contains(text(),"${labelText}")]/following::select[1]`)
    .first();
  await select.waitFor({ state: "visible", timeout: 10000 });

  const valorEncontrado = await select.evaluate((sel, buscado) => {
    const normal = (s) => (s || "").replace(/\s+/g, " ").trim().toUpperCase();
    const opt = Array.from(sel.options).find((o) => normal(o.text) === normal(buscado));
    return opt ? opt.value : null;
  }, optionLabel);

  if (valorEncontrado === null) {
    throw new Error(
      `El valor "${optionLabel}" no existe en el catálogo de "${labelText}" de Maps Seguros. Verifica cómo está escrito exactamente en el cotizador.`
    );
  }

  await select.selectOption(valorEncontrado);
}

// Lee todas las opciones visibles de un <select> ubicado tras una etiqueta
async function getOptionsByLabel(page, labelText) {
  const select = page
    .locator(`xpath=//label[contains(text(),"${labelText}")]/following::select[1]`)
    .first();
  await select.waitFor({ state: "visible", timeout: 15000 });
  const options = await select.locator("option").allTextContents();
  return options
    .map((o) => o.trim())
    .filter((o) => o && !o.toLowerCase().includes("seleccione"));
}

// Selecciona el candidato visible entre varios elementos que matchean el mismo xpath
// (útil cuando hay un elemento "proxy" de accesibilidad oculto mezclado con el real)
async function localizarVisibleEntreCandidatos(page, xpath, timeoutMs = 15000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const candidatos = page.locator(`xpath=${xpath}`);
    const total = await candidatos.count();
    for (let i = 0; i < total; i++) {
      const el = candidatos.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No se encontró ningún elemento visible para: ${xpath}`);
}

// Espera a que un <select> dependiente termine de repoblarse (más de solo
// la opción "-- Seleccione --") antes de seguir, en vez de una pausa fija
async function esperarOpcionesCargadas(page, labelText, timeoutMs = 10000) {
  const select = page
    .locator(`xpath=//label[contains(text(),"${labelText}")]/following::select[1]`)
    .first();
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const count = await select.locator("option").count().catch(() => 0);
    if (count > 1) return;
    await page.waitForTimeout(300);
  }
}

// -----------------------------------------------------------------------
// GET /catalogo/marcas
// -----------------------------------------------------------------------
app.get("/catalogo/marcas", async (req, res) => {
  const cached = cacheGet("marcas");
  if (cached) return res.json({ ok: true, marcas: cached, cache: true });

  let browser;
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page);
    const marcas = await getOptionsByLabel(sesion.page, "Marca");
    await browser.close();
    cacheSet("marcas", marcas);
    res.json({ ok: true, marcas, cache: false });
  } catch (e) {
    if (browser) await browser.close();
    console.error("Error catálogo marcas:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------------------------------------------------
// GET /catalogo/submarcas?marca=GEELY
// -----------------------------------------------------------------------
app.get("/catalogo/submarcas", async (req, res) => {
  const marca = normalizar(req.query.marca);
  if (!marca) return res.status(400).json({ ok: false, error: "Falta el parámetro marca" });

  const key = `submarcas:${marca}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, submarcas: cached, cache: true });

  let browser;
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page);
    await selectByLabel(sesion.page, "Marca", marca);
    await esperarOpcionesCargadas(sesion.page, "Submarca");
    const submarcas = await getOptionsByLabel(sesion.page, "Submarca");
    await browser.close();
    cacheSet(key, submarcas);
    res.json({ ok: true, submarcas, cache: false });
  } catch (e) {
    if (browser) await browser.close();
    console.error("Error catálogo submarcas:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------------------------------------------------
// GET /catalogo/anios?marca=GEELY&submarca=EX2
// (En Maps Seguros, el selector que dice "Modelo" en realidad contiene el AÑO)
// -----------------------------------------------------------------------
app.get("/catalogo/anios", async (req, res) => {
  const marca = normalizar(req.query.marca);
  const submarca = normalizar(req.query.submarca);
  if (!marca || !submarca)
    return res.status(400).json({ ok: false, error: "Faltan parámetros marca/submarca" });

  const key = `anios:${marca}:${submarca}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, anios: cached, cache: true });

  let browser;
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page);
    await selectByLabel(sesion.page, "Marca", marca);
    await esperarOpcionesCargadas(sesion.page, "Submarca");
    await selectByLabel(sesion.page, "Submarca", submarca);
    await esperarOpcionesCargadas(sesion.page, "Modelo");
    const anios = await getOptionsByLabel(sesion.page, "Modelo");
    await browser.close();
    cacheSet(key, anios);
    res.json({ ok: true, anios, cache: false });
  } catch (e) {
    if (browser) await browser.close();
    console.error("Error catálogo años:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------------------------------------------------
// GET /catalogo/versiones?marca=GEELY&submarca=EX2&anio=2026
// -----------------------------------------------------------------------
app.get("/catalogo/versiones", async (req, res) => {
  const marca = normalizar(req.query.marca);
  const submarca = normalizar(req.query.submarca);
  const anio = normalizar(req.query.anio);
  if (!marca || !submarca || !anio)
    return res.status(400).json({ ok: false, error: "Faltan parámetros marca/submarca/anio" });

  const key = `versiones:${marca}:${submarca}:${anio}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, versiones: cached, cache: true });

  let browser;
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page);
    await selectByLabel(sesion.page, "Marca", marca);
    await esperarOpcionesCargadas(sesion.page, "Submarca");
    await selectByLabel(sesion.page, "Submarca", submarca);
    await esperarOpcionesCargadas(sesion.page, "Modelo");
    await selectByLabel(sesion.page, "Modelo", anio);
    await esperarOpcionesCargadas(sesion.page, "Version");
    const versiones = await getOptionsByLabel(sesion.page, "Version");
    await browser.close();
    cacheSet(key, versiones);
    res.json({ ok: true, versiones, cache: false });
  } catch (e) {
    if (browser) await browser.close();
    console.error("Error catálogo versiones:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------------------------------------------------
// POST /cotizar
// -----------------------------------------------------------------------
app.post("/cotizar", async (req, res) => {
  const datos = req.body;
  let browser;
  let page;

  try {
    datos.marca = normalizar(datos.marca);
    datos.modelo = normalizar(datos.modelo);
    datos.version = normalizar(datos.version);
    datos.uso = normalizar(datos.uso);
    datos.tipoPoliza = normalizar(datos.tipoPoliza);

    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    page = sesion.page;

    // ---------- TAB: DATOS DEL CLIENTE ----------
    const datosClienteTab = page.getByText("Datos del Cliente", { exact: true });
    await datosClienteTab.waitFor({ state: "visible", timeout: 30000 });
    await datosClienteTab.click();
    const clienteBox = await localizarVisibleEntreCandidatos(
      page,
      `//label[contains(text(),"Cliente:")]/following::*[self::input or self::span or self::div][1]`
    );
    await clienteBox.click();
    await page.keyboard.type("CLIENTE EJEMPLO", { delay: 50 });
    await page.waitForTimeout(1500);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Esperamos a que la app termine de procesar la selección del cliente
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);

    // ---------- TAB: DATOS DE LA UNIDAD ----------
    const datosUnidadTab = page.getByText("Datos de la Unidad", { exact: true });
    await datosUnidadTab.waitFor({ state: "visible", timeout: 40000 });
    await datosUnidadTab.click();
    await page.waitForTimeout(500);
    await selectByLabel(page, "Tipo de Transporte", "Automóvil");
    await page.waitForTimeout(500);

    await selectByLabel(page, "Marca", datos.marca);
    await esperarOpcionesCargadas(page, "Submarca");
    await selectByLabel(page, "Submarca", datos.modelo);
    await esperarOpcionesCargadas(page, "Modelo");
    await selectByLabel(page, "Modelo", String(datos.anio));
    await esperarOpcionesCargadas(page, "Version");
    await selectByLabel(page, "Version", datos.version);
    await page.waitForTimeout(500);
    await selectByLabel(page, "Uso", datos.uso);

    function derivarServicio(uso) {
      const privadoPasajeros = [
        "EXCLUSIVO UBER", "EXCLUSIVO DIDI", "INDRIVER", "BOLT",
        "CONDUCTOR APP", "EXTENSION APP", "MIXTO",
      ];
      const carga = ["CARGA A y B PESADO", "CARGA C", "CARGA LIGERA"];
      const reparto = ["REPARTO", "REPARTO APP"];
      const taxi = ["TAXI", "MOTOTAXI"];

      if (uso === "PARTICULAR") return "PARTICULAR";
      if (privadoPasajeros.includes(uso)) return "PRIVADO PASAJEROS";
      if (taxi.includes(uso)) return "TAXI";
      if (carga.includes(uso)) return "CARGA A y B";
      if (reparto.includes(uso)) return "REPARTO APP";
      return "PARTICULAR";
    }
    await selectByLabel(page, "Servicio", derivarServicio(datos.uso));
    await selectByLabel(page, "Flotilla", "Descuento Flotilla AA 11 A 20");

    // ---------- TAB: DETALLES DE COBERTURA ----------
    const coberturaTab = page.getByText("Detalles de Cobertura", { exact: true });
    await coberturaTab.waitFor({ state: "visible", timeout: 30000 });
    await coberturaTab.click();
    await page.waitForTimeout(500);
    await selectByLabel(page, "Tipo de Cobertura", datos.tipoPoliza);

    // ---------- TAB: INFORMACION DE LA COTIZACION ----------
    const infoCotizacionTab = page.getByText("Información de la Cotización", { exact: true });
    await infoCotizacionTab.waitFor({ state: "visible", timeout: 30000 });
    await infoCotizacionTab.click();
    await page.waitForTimeout(500);
    await selectByLabel(page, "Conducto de Cobro", datos.conductoCobro || "Tarjeta de Crédito");

    // ---------- LEER EL TOTAL CALCULADO ----------
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);
    const panelTexto = await page.locator("body").innerText();

    // Capturamos el folio de ESTA cotización específica (aparece en el panel
    // derecho, ej. "Cotización: 226095"), para más adelante ubicar exactamente
    // esta fila en la lista y no una cotización anterior por error
    let folioActual = null;
    const matchFolio = panelTexto.match(/Cotizaci[oó]n:\s*\n?\s*(\d{4,})/);
    if (matchFolio) folioActual = matchFolio[1];

    const extraerMonto = (etiqueta, texto) => {
      const match = texto.match(new RegExp(etiqueta + "[:\\s]*\\$?([\\d,]+\\.\\d{2})"));
      return match ? match[1] : null;
    };

    const resultado = {
      importeBase: extraerMonto("Importe Base", panelTexto),
      extras: extraerMonto("Extras", panelTexto),
      descuento: extraerMonto("Descuento", panelTexto),
      anual: extraerMonto("Anual", panelTexto),
      textoCompleto: panelTexto,
    };

    await page.getByText("Guardar", { exact: true }).click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(4000);

    // ---------- CAPTURAR EL PDF (botón de imprimir de la cotización recién guardada) ----------
    let pdfUrl = null;
    ultimoDiagnostico = { paso: "iniciando captura de PDF", folioActual };
    try {
      // Primero navegamos a la ruta correcta, y luego forzamos una recarga real
      // (goto solo no basta en una SPA si ya habíamos visitado esa misma URL antes)
      await page.goto(MAPS_URL_QUOTES, { waitUntil: "networkidle" });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("text=Cotizaciones", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      ultimoDiagnostico.paso = "lista recargada, buscando fila";

      // La cotización recién creada aparece hasta arriba de la lista
      // Aprovechamos que ya estamos en la lista para confirmar el total definitivo
      // que realmente quedó guardado (la fuente más confiable)
      const filaObjetivo = folioActual
        ? page.locator("tr").filter({ hasText: folioActual }).first()
        : page.locator("tr").filter({ has: page.locator("button:has(.glyphicon-print)") }).first();

      const cuentaFilasConFolio = folioActual
        ? await page.locator("tr").filter({ hasText: folioActual }).count()
        : null;
      ultimoDiagnostico.cuentaFilasConFolio = cuentaFilasConFolio;

      try {
        const filaTexto = await filaObjetivo.innerText();
        ultimoDiagnostico.filaTexto = filaTexto;
        const matchTotalGuardado = filaTexto.match(/\$([\d,]+\.\d{2})/);
        if (matchTotalGuardado) {
          resultado.anual = matchTotalGuardado[1];
        }
      } catch (e) {
        ultimoDiagnostico.errorFila = e.message;
        console.error("No se pudo confirmar el total desde la lista:", e.message);
      }

      ultimoDiagnostico.paso = "buscando boton de imprimir";
      const botonImprimir = filaObjetivo.locator("button:has(.glyphicon-print)").first();
      await botonImprimir.waitFor({ state: "visible", timeout: 15000 });

      const fs = require("fs");
      if (!fs.existsSync("public/pdfs")) fs.mkdirSync("public/pdfs", { recursive: true });
      const nombreArchivo = `cotizacion_${Date.now()}.pdf`;
      const rutaLocal = `public/pdfs/${nombreArchivo}`;

      // El botón puede abrir una pestaña nueva o disparar una descarga; probamos ambas
      const [eventoOPopupODescarga] = await Promise.all([
        Promise.race([
          page.waitForEvent("popup", { timeout: 15000 }).then((p) => ({ tipo: "popup", valor: p })),
          page.waitForEvent("download", { timeout: 15000 }).then((d) => ({ tipo: "download", valor: d })),
        ]),
        botonImprimir.click(),
      ]);

      if (eventoOPopupODescarga.tipo === "download") {
        await eventoOPopupODescarga.valor.saveAs(rutaLocal);
        pdfUrl = `/pdfs/${nombreArchivo}`;
        ultimoDiagnostico.paso = "PDF capturado via download";
      } else {
        const popup = eventoOPopupODescarga.valor;
        await popup.waitForLoadState("networkidle").catch(() => {});
        const respuesta = await page.context().request.get(popup.url());
        const buffer = await respuesta.body();
        fs.writeFileSync(rutaLocal, buffer);
        await popup.close();
        pdfUrl = `/pdfs/${nombreArchivo}`;
        ultimoDiagnostico.paso = "PDF capturado via popup";
        ultimoDiagnostico.popupUrl = popup.url();
      }
    } catch (e) {
      ultimoDiagnostico.paso = "ERROR capturando PDF";
      ultimoDiagnostico.errorPdf = e.message;
      console.error("No se pudo capturar el PDF (la cotización sí se guardó bien):", e.message);
    }

    ultimoDiagnostico.resultadoFinal = { ok: true, pdfUrl, folioActual, anual: resultado.anual };
    await browser.close();

    return res.json({ ok: true, datosEnviados: datos, resultado: { ...resultado, pdfUrl, folioActual } });
  } catch (err) {
    let screenshotGuardado = false;
    if (page) {
      try {
        await page.screenshot({ path: "public/debug.png", fullPage: true });
        screenshotGuardado = true;
      } catch (e) {
        console.error("No se pudo guardar la captura de depuración:", e.message);
      }
    }
    if (browser) await browser.close();
    console.error("Error cotizando:", err);
    ultimoDiagnostico = { paso: "ERROR general", error: err.message };
    return res.status(500).json({
      ok: false,
      error: err.message,
      captura: screenshotGuardado ? "/debug.png" : null,
    });
  }
});

// Ventanilla simple: abre esta URL en el navegador para ver en texto plano
// qué pasó en el último intento de cotización, sin depender de Easypanel
app.get("/diagnostico", (req, res) => {
  res.json(ultimoDiagnostico);
});

app.get("/config", (req, res) => {
  res.json({ webhookUrl: process.env.N8N_WEBHOOK_URL || "" });
});

// El formulario le habla a ESTE endpoint (mismo dominio, sin problema de CORS),
// y aquí, servidor a servidor, se reenvía a n8n
app.post("/enviar-cotizacion", async (req, res) => {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(500).json({ ok: false, error: "N8N_WEBHOOK_URL no está configurada" });
  }
  try {
    const respuestaN8n = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const texto = await respuestaN8n.text();
    let datos;
    try {
      datos = JSON.parse(texto);
    } catch {
      datos = { textoCompleto: texto };
    }
    return res.status(respuestaN8n.status).json({ ok: respuestaN8n.ok, ...datos });
  } catch (err) {
    console.error("Error reenviando a n8n:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quoter service escuchando en puerto ${PORT}`));
