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

// Navega a la pestaña "Datos de la Unidad" (usado por los endpoints de catálogo,
// que no necesitan pasar por "Datos del Cliente")
async function irADatosDeLaUnidad(page) {
  const tab = page.getByText("Datos de la Unidad", { exact: true });
  await tab.waitFor({ state: "visible", timeout: 30000 });
  await tab.click();
  await page.waitForTimeout(500);
}

// Selecciona una opción de un <select> ubicado justo después de una etiqueta visible
async function selectByLabel(page, labelText, optionLabel) {
  const select = page.locator(
    `xpath=//label[contains(text(),"${labelText}")]/following::select[1]`
  );
  await select.waitFor({ state: "visible", timeout: 10000 });
  try {
    await select.selectOption({ label: optionLabel });
  } catch (e) {
    throw new Error(
      `El valor "${optionLabel}" no existe en el catálogo de "${labelText}" de Maps Seguros. Verifica cómo está escrito exactamente en el cotizador.`
    );
  }
}

// Lee todas las opciones visibles de un <select> ubicado tras una etiqueta
async function getOptionsByLabel(page, labelText) {
  const select = page.locator(
    `xpath=//label[contains(text(),"${labelText}")]/following::select[1]`
  );
  await select.waitFor({ state: "visible", timeout: 15000 });
  const options = await select.locator("option").allTextContents();
  return options
    .map((o) => o.trim())
    .filter((o) => o && !o.toLowerCase().includes("seleccione"));
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
    await selectByLabel(sesion.page, "Submarca", submarca);
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
    await selectByLabel(sesion.page, "Submarca", submarca);
    await selectByLabel(sesion.page, "Modelo", anio);
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
    const clienteInput = page.locator(
      `xpath=//label[contains(text(),"Cliente:")]/following::input[1]`
    );
    await clienteInput.waitFor({ state: "visible", timeout: 15000 });
    await clienteInput.fill("CLIENTE EJEMPLO PARA COTIZAR");
    await page.getByText("CLIENTE EJEMPLO PARA COTIZAR", { exact: false }).first().click();

    // Esperamos a que la app termine de procesar la selección del cliente
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);

    // ---------- TAB: DATOS DE LA UNIDAD ----------
    const datosUnidadTab = page.getByText("Datos de la Unidad", { exact: true });
    await datosUnidadTab.waitFor({ state: "visible", timeout: 40000 });
    await datosUnidadTab.click();
    await page.waitForTimeout(500);

    await selectByLabel(page, "Marca", datos.marca);
    await selectByLabel(page, "Submarca", datos.modelo);
    await selectByLabel(page, "Modelo", String(datos.anio));
    await selectByLabel(page, "Version", datos.version);
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
    await page.waitForTimeout(1000);
    const panelTexto = await page.locator("body").innerText();

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
    await browser.close();

    return res.json({ ok: true, datosEnviados: datos, resultado });
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
    return res.status(500).json({
      ok: false,
      error: err.message,
      captura: screenshotGuardado ? "/debug.png" : null,
    });
  }
});

app.get("/config", (req, res) => {
  res.json({ webhookUrl: process.env.N8N_WEBHOOK_URL || "" });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quoter service escuchando en puerto ${PORT}`));
