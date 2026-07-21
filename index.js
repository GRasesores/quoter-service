const express = require("express");
const { chromium } = require("playwright");
const multer = require("multer");
const fs = require("fs");

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = "public/documentos";
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const id = req.body.idCotizacion || Date.now();
      cb(null, `${id}-${file.fieldname}${require("path").extname(file.originalname) || ".jpg"}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB por archivo
  fileFilter: (req, file, cb) => {
    const permitido = file.mimetype.startsWith("image/") || file.mimetype === "application/pdf";
    if (!permitido) {
      return cb(new Error(`Archivo "${file.originalname}" no es una imagen ni un PDF`));
    }
    cb(null, true);
  },
});

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
// CONFIGURACIÓN DE COBERTURAS: valores exactos de Suma Asegurada/Deducible
// por Tipo de Transporte + Tipo de Póliza. Se va ampliando conforme el
// negocio define los valores correctos para cada combinación.
// -----------------------------------------------------------------------
const CONFIG_COBERTURAS = {
  Motocicleta: {
    AMPLIA: {
      "Daños Materiales": { deducible: "10%" },
      "Robo Total": { deducible: "20%" },
      "Responsabilidad Civil Daños a Terceros": { suma: "1500000", deducible: "50 uma" },
      "Responsabilidad Civil Pasajero": { suma: "500000", deducible: "No Aplica" },
      "Asistencia Legal": { deducible: "No Aplica" },
      "Asistencia Vial Moto": { deducible: "No Aplica" },
    },
  },
  Automóvil: {
    AMPLIA: {
      "Daños Materiales": { deducible: "5%" },
      "Robo Total": { deducible: "10%" },
      "Responsabilidad Civil Daños a Terceros": { suma: "3000000", deducible: "0 uma" },
      "Gastos Médicos": { suma: "150000" },
      "Muerte Conductor X Accidente": { suma: "50000" },
      "Cristales y Espejos": { deducible: "20%" },
      "Asistencia Legal": { deducible: "No Aplica" },
      "Asistencia Vial Autos": { deducible: "No Aplica" },
    },
  },
};
// LIMITADA y RC de Automóvil usan la misma base que AMPLIA — el código
// se salta en silencio cualquier fila que no exista en esa cobertura,
// así que no hay riesgo de forzar algo que no aplique
CONFIG_COBERTURAS.Automóvil.LIMITADA = { ...CONFIG_COBERTURAS.Automóvil.AMPLIA };
CONFIG_COBERTURAS.Automóvil.RC = { ...CONFIG_COBERTURAS.Automóvil.AMPLIA };

CONFIG_COBERTURAS.Camión = {
  AMPLIA: {
    "Daños Materiales": { deducible: "5%" },
    "Robo Total": { deducible: "10%" },
    "Responsabilidad Civil Daños a Terceros": { suma: "3000000", deducible: "25 uma" },
    "Responsabilidad Civil Pasajero": { suma: "1000000", deducible: "No Aplica" },
    "Gastos Médicos": { suma: "100000" },
    "Muerte Conductor X Accidente": { suma: "50000" },
    "Cristales y Espejos": { deducible: "20%" },
    "Asistencia Legal": { deducible: "No Aplica" },
    "Asistencia Vial Camiones": { deducible: "No Aplica" },
  },
};
CONFIG_COBERTURAS.Camión.LIMITADA = { ...CONFIG_COBERTURAS.Camión.AMPLIA };
CONFIG_COBERTURAS.Camión.RC = { ...CONFIG_COBERTURAS.Camión.AMPLIA };

// -----------------------------------------------------------------------
// COBERTURAS ESPECIALES POR USO (plataforma/taxi/reparto): estos usos
// tienen tarifario propio de flotilla — cuando el Uso cae en uno de estos
// grupos, esta configuración tiene prioridad sobre CONFIG_COBERTURAS de
// arriba (que es genérica por Tipo de Transporte + Tipo de Póliza).
// El deducible de RC Daños a Terceros usa el nivel medio: 25 UMA.
// -----------------------------------------------------------------------
const USOS_PLATAFORMA_AUTO = [
  "EXCLUSIVO UBER", "EXCLUSIVO DIDI", "INDRIVER", "BOLT",
  "CONDUCTOR APP", "EXTENSION APP", "MIXTO", "TAXI",
];
const USOS_REPARTO_MOTO = ["REPARTO", "REPARTO APP"];

const COBERTURA_PLATAFORMA_AUTO = {
  "Daños Materiales": { deducible: "10%" },
  "Robo Total": { deducible: "20%" },
  "Responsabilidad Civil Daños a Terceros": { suma: "3000000", deducible: "25 uma" },
  "Responsabilidad Civil Pasajero": { suma: "1000000", deducible: "No Aplica" },
  "Gastos Médicos": { suma: "250000" },
  "Muerte Conductor X Accidente": { suma: "50000" },
  "Cristales y Espejos": { deducible: "20%" },
  "Asistencia Legal": { deducible: "No Aplica" },
  "Asistencia Vial Autos": { deducible: "No Aplica" },
};

const COBERTURA_REPARTO_MOTO = {
  "Daños Materiales": { deducible: "10%" },
  "Robo Total": { deducible: "20%" },
  "Responsabilidad Civil Daños a Terceros": { suma: "3000000", deducible: "0 uma" },
  "Gastos Médicos": { suma: "100000" },
  "Muerte Conductor X Accidente": { suma: "50000" },
  "Asistencia Legal": { deducible: "No Aplica" },
  "Asistencia Vial Moto": { deducible: "No Aplica" },
};

// Devuelve la configuración de coberturas correcta: primero revisa si el
// Uso cae en un grupo especial (plataforma/reparto), si no, usa la tabla
// genérica por Tipo de Transporte + Tipo de Póliza
function obtenerConfigCobertura(tipoTransporte, tipoPoliza, uso) {
  if (tipoTransporte === "Automóvil" && USOS_PLATAFORMA_AUTO.includes(uso)) {
    return COBERTURA_PLATAFORMA_AUTO;
  }
  if (tipoTransporte === "Motocicleta" && USOS_REPARTO_MOTO.includes(uso)) {
    return COBERTURA_REPARTO_MOTO;
  }
  return (CONFIG_COBERTURAS[tipoTransporte] && CONFIG_COBERTURAS[tipoTransporte][tipoPoliza]) || null;
}

// -----------------------------------------------------------------------
// COLA: todas las tareas que abren una sesión en Maps Seguros pasan por aquí,
// UNA A LA VEZ. Como todas usan la misma cuenta, dos sesiones simultáneas
// pueden mezclar sus datos entre sí (una ve el estado de la otra) — esto lo evita.
// -----------------------------------------------------------------------
let colaProcesamiento = Promise.resolve();
function encolar(tarea) {
  const resultado = colaProcesamiento.then(tarea, tarea);
  colaProcesamiento = resultado.catch(() => {});
  return resultado;
}

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

  // Por si aparece alguna ventana de confirmación nativa (confirm/alert) que
  // pudiera estar bloqueando el guardado en silencio, la aceptamos automático
  page.on("dialog", async (dialog) => {
    console.log("Dialogo detectado:", dialog.type(), dialog.message());
    await dialog.accept().catch(() => {});
  });

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

  // Diagnóstico: confirmamos si el formulario realmente inició en blanco
  // ("Nueva") o si por alguna razón retomó un borrador anterior (mostraría
  // un número de folio en vez de la palabra "Nueva")
  try {
    const textoInicial = await page.locator("body").innerText();
    const matchEstadoInicial = textoInicial.match(/Cotizaci[oó]n:\s*\n?\s*(\S+)/);
    global.ultimoEstadoAlAbrirNuevo = matchEstadoInicial ? matchEstadoInicial[1] : "no encontrado";
  } catch (e) {
    global.ultimoEstadoAlAbrirNuevo = "error leyendo: " + e.message;
  }

  return { browser, page };
}

// Navega a la pestaña "Datos de la Unidad" y selecciona el Tipo de Transporte
// indicado (Automóvil, Camión o Motocicleta) — de esto depende qué catálogo
// de Marca se muestra
async function irADatosDeLaUnidad(page, tipoTransporte = "Automóvil") {
  const tab = page.getByText("Datos de la Unidad", { exact: true });
  await tab.waitFor({ state: "visible", timeout: 30000 });
  await tab.click();
  await page.waitForTimeout(500);
  await selectByLabel(page, "Tipo de Transporte", tipoTransporte);
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

// Asigna Suma Asegurada y/o Deducible a una fila específica de la tabla de
// coberturas (ej. "Daños Materiales", "Responsabilidad Civil Pasajero").
// Detecta si el campo es un <input> (texto/número) o un <select> (dropdown
// de porcentajes), y actúa según corresponda. Nunca truena el flujo completo
// si algo no se encuentra — solo lo reporta en el diagnóstico.
async function establecerCoberturaFila(page, nombreFila, opciones = {}) {
  const { suma, deducible } = opciones;
  const resultado = { fila: nombreFila };
  try {
    const filaLabel = page.getByText(nombreFila, { exact: false }).first();
    const visible = await filaLabel.isVisible({ timeout: 3000 }).catch(() => false);
    resultado.encontrada = visible;
    if (!visible) return resultado;

    const fila = filaLabel.locator("xpath=ancestor::tr[1]");

    if (suma !== undefined) {
      const camposFila = fila.locator("input, select");
      const total = await camposFila.count();
      for (let i = 0; i < total; i++) {
        const campo = camposFila.nth(i);
        if (!(await campo.isVisible().catch(() => false))) continue;
        const tag = await campo.evaluate((el) => el.tagName.toLowerCase());
        if (tag === "input") {
          await campo.fill(String(suma));
          resultado.sumaAsignada = true;
          break;
        }
      }
    }

    if (deducible !== undefined) {
      const camposFila = fila.locator("select");
      const total = await camposFila.count();
      for (let i = 0; i < total; i++) {
        const campo = camposFila.nth(i);
        if (!(await campo.isVisible().catch(() => false))) continue;
        const opcionesSelect = await campo.locator("option").allTextContents();
        const match = opcionesSelect.find(
          (o) => o.replace(/\s+/g, " ").trim().toUpperCase() === deducible.replace(/\s+/g, " ").trim().toUpperCase()
        );
        if (match) {
          await campo.selectOption({ label: match });
          resultado.deducibleAsignado = true;
          break;
        } else {
          resultado.deducibleNoEncontrado = deducible;
          resultado.deducibleOpcionesDisponibles = opcionesSelect;
        }
      }
    }
  } catch (e) {
    resultado.error = e.message;
  }
  return resultado;
}

// -----------------------------------------------------------------------
// GET /catalogo/marcas?tipoTransporte=Automóvil
// -----------------------------------------------------------------------
app.get("/catalogo/marcas", async (req, res) => {
  const tipoTransporte = req.query.tipoTransporte || "Automóvil";
  const cached = cacheGet(`marcas:${tipoTransporte}`);
  if (cached) return res.json({ ok: true, marcas: cached, cache: true });

  let browser;
  await encolar(async () => {
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page, tipoTransporte);
    const marcas = await getOptionsByLabel(sesion.page, "Marca");
    await browser.close();
    cacheSet(`marcas:${tipoTransporte}`, marcas);
    res.json({ ok: true, marcas, cache: false });
  } catch (e) {
    if (browser) await browser.close();
    console.error("Error catálogo marcas:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
  });
});

// -----------------------------------------------------------------------
// GET /catalogo/submarcas?marca=GEELY&tipoTransporte=Automóvil
// -----------------------------------------------------------------------
app.get("/catalogo/submarcas", async (req, res) => {
  const marca = normalizar(req.query.marca);
  const tipoTransporte = req.query.tipoTransporte || "Automóvil";
  if (!marca) return res.status(400).json({ ok: false, error: "Falta el parámetro marca" });

  const key = `submarcas:${tipoTransporte}:${marca}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, submarcas: cached, cache: true });

  let browser;
  await encolar(async () => {
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page, tipoTransporte);
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
});

// -----------------------------------------------------------------------
// GET /catalogo/anios?marca=GEELY&submarca=EX2&tipoTransporte=Automóvil
// (En Maps Seguros, el selector que dice "Modelo" en realidad contiene el AÑO)
// -----------------------------------------------------------------------
app.get("/catalogo/anios", async (req, res) => {
  const marca = normalizar(req.query.marca);
  const submarca = normalizar(req.query.submarca);
  const tipoTransporte = req.query.tipoTransporte || "Automóvil";
  if (!marca || !submarca)
    return res.status(400).json({ ok: false, error: "Faltan parámetros marca/submarca" });

  const key = `anios:${tipoTransporte}:${marca}:${submarca}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, anios: cached, cache: true });

  let browser;
  await encolar(async () => {
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page, tipoTransporte);
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
});

// -----------------------------------------------------------------------
// GET /catalogo/versiones?marca=GEELY&submarca=EX2&anio=2026&tipoTransporte=Automóvil
// -----------------------------------------------------------------------
app.get("/catalogo/versiones", async (req, res) => {
  const marca = normalizar(req.query.marca);
  const submarca = normalizar(req.query.submarca);
  const anio = normalizar(req.query.anio);
  const tipoTransporte = req.query.tipoTransporte || "Automóvil";
  if (!marca || !submarca || !anio)
    return res.status(400).json({ ok: false, error: "Faltan parámetros marca/submarca/anio" });

  const key = `versiones:${tipoTransporte}:${marca}:${submarca}:${anio}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, versiones: cached, cache: true });

  let browser;
  await encolar(async () => {
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page, tipoTransporte);
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
});

// -----------------------------------------------------------------------
// GET /catalogo/servicios?tipoTransporte=Automóvil&uso=PARTICULAR
// (El catálogo de Servicio depende de que "Uso" ya esté seleccionado)
// -----------------------------------------------------------------------
app.get("/catalogo/servicios", async (req, res) => {
  const tipoTransporte = req.query.tipoTransporte || "Automóvil";
  const uso = normalizar(req.query.uso);
  if (!uso) return res.status(400).json({ ok: false, error: "Falta el parámetro uso" });

  const key = `servicios:${tipoTransporte}:${uso}`;
  const cached = cacheGet(key);
  if (cached && cached.length > 0) return res.json({ ok: true, servicios: cached, cache: true });

  let browser;
  await encolar(async () => {
  try {
    const sesion = await abrirCotizadorLogueado();
    browser = sesion.browser;
    await irADatosDeLaUnidad(sesion.page, tipoTransporte);
    await selectByLabel(sesion.page, "Uso", uso);
    await esperarOpcionesCargadas(sesion.page, "Servicio");
    const servicios = await getOptionsByLabel(sesion.page, "Servicio");
    await browser.close();
    if (servicios.length > 0) cacheSet(key, servicios);
    res.json({ ok: true, servicios, cache: false });
  } catch (e) {
    if (browser) await browser.close();
    console.error("Error catálogo servicios:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
  });
});

// -----------------------------------------------------------------------
// POST /cotizar
// -----------------------------------------------------------------------
app.post("/cotizar", async (req, res) => {
  const datos = req.body;

  await encolar(async () => {
  let browser;
  let page;
  ultimoDiagnostico = { paso: "iniciando cotización", datosRecibidos: datos };

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
    await selectByLabel(page, "Tipo de Transporte", datos.tipoTransporte || "Automóvil");
    await page.waitForTimeout(500);

    await selectByLabel(page, "Marca", datos.marca);
    await esperarOpcionesCargadas(page, "Submarca");
    await selectByLabel(page, "Submarca", datos.modelo);
    await esperarOpcionesCargadas(page, "Modelo");
    await selectByLabel(page, "Modelo", String(datos.anio));
    await esperarOpcionesCargadas(page, "Version");
    if (datos.version) {
      await selectByLabel(page, "Version", datos.version);
    }
    await page.waitForTimeout(500);
    await selectByLabel(page, "Uso", datos.uso);
    await esperarOpcionesCargadas(page, "Servicio");

    // El "Servicio" ahora viene directo del dropdown del formulario (alimentado
    // en vivo desde el catálogo real), ya no lo derivamos internamente
    const serviciosDisponibles = await getOptionsByLabel(page, "Servicio");
    const servicioFinal = serviciosDisponibles.some(
      (s) => normalizar(s) === normalizar(datos.servicio)
    )
      ? datos.servicio
      : serviciosDisponibles[0];
    ultimoDiagnostico.serviciosDisponibles = serviciosDisponibles;
    ultimoDiagnostico.servicioElegido = servicioFinal;
    await selectByLabel(page, "Servicio", servicioFinal);
    await selectByLabel(page, "Flotilla", "Descuento Flotilla AA 11 A 20");

    // ---------- TAB: DETALLES DE COBERTURA ----------
    const coberturaTab = page.getByText("Detalles de Cobertura", { exact: true });
    await coberturaTab.waitFor({ state: "visible", timeout: 30000 });
    await coberturaTab.click();
    await page.waitForTimeout(500);

    // El formulario usa "RC" (corto y claro para el usuario), pero en Maps
    // Seguros el nombre real de esa opción es "RESPONSABILIDAD CIVIL"
    const mapaTipoCobertura = {
      RC: "RESPONSABILIDAD CIVIL",
      LIMITADA: "LIMITADA",
      AMPLIA: "AMPLIA",
    };
    const tipoCoberturaReal = mapaTipoCobertura[datos.tipoPoliza] || datos.tipoPoliza;
    await selectByLabel(page, "Tipo de Cobertura", tipoCoberturaReal);
    // Damos tiempo a que el sistema termine de recalcular/validar los detalles
    // de la cobertura antes de seguir — si avanzamos muy rápido, el guardado
    // final falla con "Cobertura inválida, revise la selección de coberturas"
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500);

    // Con usos tipo plataforma (Conductor App, Uber, Didi, InDriver, etc.)
    // aparece la fila "Responsabilidad Civil Pasajero" que necesita una Suma
    // Asegurada asignada, si no el guardado falla con "cobertura inválida"
    try {
      const rcPasajeroLabel = page.getByText("Responsabilidad Civil Pasajero", { exact: false }).first();
      const apareceRcPasajero = await rcPasajeroLabel.isVisible({ timeout: 3000 }).catch(() => false);
      ultimoDiagnostico.apareceRcPasajero = apareceRcPasajero;
      if (apareceRcPasajero) {
        const fila = rcPasajeroLabel.locator("xpath=ancestor::tr[1]");
        const campoMonto = fila.locator("input, select").first();
        await campoMonto.waitFor({ state: "visible", timeout: 5000 });
        const tagName = await campoMonto.evaluate((el) => el.tagName.toLowerCase());
        if (tagName === "select") {
          const opciones = await campoMonto.locator("option").allTextContents();
          const opcion500k = opciones.find((o) => o.replace(/\D/g, "") === "500000");
          if (opcion500k) await campoMonto.selectOption({ label: opcion500k });
        } else {
          await campoMonto.fill("500000");
        }
        await page.waitForTimeout(500);
        ultimoDiagnostico.rcPasajeroAsignado = true;
      }
    } catch (e) {
      ultimoDiagnostico.errorRcPasajero = e.message;
      console.error("No se pudo asignar Responsabilidad Civil Pasajero:", e.message);
    }

    // Aplicamos los valores configurados de Suma Asegurada/Deducible: primero
    // revisa si el Uso cae en un grupo especial (plataforma/reparto), si no,
    // usa la tabla genérica por Tipo de Transporte + Tipo de Póliza
    const configAplicable = obtenerConfigCobertura(datos.tipoTransporte, datos.tipoPoliza, datos.uso);
    if (configAplicable) {
      const resultadosCobertura = [];
      for (const [nombreFila, valores] of Object.entries(configAplicable)) {
        const r = await establecerCoberturaFila(page, nombreFila, valores);
        resultadosCobertura.push(r);
      }
      ultimoDiagnostico.coberturasAplicadas = resultadosCobertura;
      await page.waitForTimeout(1000);
    }

    // "Tocamos" cada dropdown de la tabla de coberturas (re-seleccionando su
    // propio valor actual) — algunas apps Angular no registran internamente
    // los valores por default hasta que hay una interacción real, aunque se
    // vean bien en pantalla, y eso puede causar "cobertura inválida" al guardar
    try {
      const todosLosSelects = page.locator("select");
      const totalSelects = await todosLosSelects.count();
      let tocados = 0;
      for (let i = 0; i < totalSelects; i++) {
        const sel = todosLosSelects.nth(i);
        const esVisible = await sel.isVisible().catch(() => false);
        if (!esVisible) continue;
        const valorActual = await sel.evaluate((el) => el.value).catch(() => null);
        if (valorActual) {
          await sel.selectOption(valorActual).catch(() => {});
          tocados++;
        }
      }
      ultimoDiagnostico.selectsTocados = tocados;
      await page.waitForTimeout(1000);
    } catch (e) {
      ultimoDiagnostico.errorTocandoSelects = e.message;
    }

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

    // Diagnóstico: confirmamos qué folio quedó asignado justo después de guardar,
    // ANTES de navegar a ningún otro lado
    try {
      const textoTrasGuardar = await page.locator("body").innerText();
      const matchTrasGuardar = textoTrasGuardar.match(/Cotizaci[oó]n:\s*\n?\s*(\S+)/);
      ultimoDiagnostico.folioTrasGuardar = matchTrasGuardar ? matchTrasGuardar[1] : "no encontrado";
      const matchTotalTrasGuardar = textoTrasGuardar.match(/Anual[:\s]*\$?([\d,]+\.\d{2})/);
      ultimoDiagnostico.totalTrasGuardar = matchTotalTrasGuardar ? matchTotalTrasGuardar[1] : null;
      ultimoDiagnostico.urlTrasGuardar = page.url();
      // Detectamos automáticamente si apareció algún mensaje de error de
      // validación (ej. "Cobertura inválida, revise la selección...")
      const matchErrorValidacion = textoTrasGuardar.match(/(inv[aá]lid[oa][^\n.]{0,120})/i);
      ultimoDiagnostico.errorValidacionTrasGuardar = matchErrorValidacion ? matchErrorValidacion[1] : null;
      const fs = require("fs");
      await page.screenshot({ path: "public/debug-guardar.png", fullPage: true });
      ultimoDiagnostico.capturaTrasGuardar = "/debug-guardar.png";
    } catch (e) {
      ultimoDiagnostico.folioTrasGuardar = "error: " + e.message;
    }

    // ---------- CAPTURAR EL PDF (botón de imprimir de la cotización recién guardada) ----------
    let pdfUrl = null;
    ultimoDiagnostico.paso = "iniciando captura de PDF";
    ultimoDiagnostico.folioActual = folioActual;
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
      let filaObjetivo;
      if (folioActual) {
        filaObjetivo = page.locator("tr").filter({ hasText: folioActual }).first();
      } else {
        // No teníamos el folio de antemano: leemos TODAS las filas, extraemos
        // su número de folio, y tomamos la más reciente (el número más alto)
        const todasLasFilas = page.locator("tr");
        const totalFilas = await todasLasFilas.count();
        let mejorFolio = -1;
        let mejorIndice = 0;
        for (let i = 0; i < Math.min(totalFilas, 15); i++) {
          const texto = await todasLasFilas.nth(i).innerText().catch(() => "");
          const m = texto.match(/^\s*(\d{4,})/);
          if (m) {
            const num = parseInt(m[1], 10);
            if (num > mejorFolio) {
              mejorFolio = num;
              mejorIndice = i;
            }
          }
        }
        ultimoDiagnostico.folioMasAltoEncontrado = mejorFolio;
        filaObjetivo = todasLasFilas.nth(mejorIndice);
      }

      const cuentaFilasConFolio = folioActual
        ? await page.locator("tr").filter({ hasText: folioActual }).count()
        : null;
      ultimoDiagnostico.cuentaFilasConFolio = cuentaFilasConFolio;

      try {
        const filaTexto = await filaObjetivo.innerText();
        ultimoDiagnostico.filaTexto = filaTexto;
        // NOTA: ya NO sobrescribimos resultado.anual aquí — el "Guardar" no
        // siempre persiste un registro nuevo todavía, así que esta fila puede
        // ser una cotización vieja. El monto correcto ya se capturó antes,
        // directo de la pantalla de cotización (más confiable por ahora).
      } catch (e) {
        ultimoDiagnostico.errorFila = e.message;
        console.error("No se pudo leer la fila de la lista:", e.message);
      }

      ultimoDiagnostico.paso = "seleccionando la fila antes de buscar el boton";
      // El botón de imprimir usa ng-show="showPrint": solo aparece en la fila
      // que está "seleccionada" (activada con un clic), no en todas a la vez
      await filaObjetivo.click();
      await page.waitForTimeout(1000);

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

    // Te mandamos el PDF por Telegram automáticamente en cuanto se genera
    if (pdfUrl && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        const rutaLocalPdf = `public${pdfUrl}`;
        const bufferPdf = fs.readFileSync(rutaLocalPdf);
        const blobPdf = new Blob([bufferPdf]);
        const formPdf = new FormData();
        formPdf.append("chat_id", process.env.TELEGRAM_CHAT_ID);
        formPdf.append(
          "caption",
          `🚗 Nueva cotización\n${datos.nombreCompleto || "-"} (${datos.telefono || "-"})\n` +
          `${datos.marca} ${datos.modelo} ${datos.anio} — ${datos.tipoPoliza}\n` +
          `Total anual: $${resultado.anual || "-"}`
        );
        formPdf.append("document", blobPdf, "cotizacion.pdf");
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
          method: "POST",
          body: formPdf,
        });
      } catch (e) {
        console.error("No se pudo mandar el PDF por Telegram:", e.message);
      }
    }

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
  }); // fin de encolar()
});

// Ventanilla simple: abre esta URL en el navegador para ver en texto plano
// qué pasó en el último intento de cotización, sin depender de Easypanel
app.get("/diagnostico", (req, res) => {
  res.json({ ...ultimoDiagnostico, estadoAlAbrirNuevo: global.ultimoEstadoAlAbrirNuevo || null });
});

app.get("/config", (req, res) => {
  res.json({ webhookUrl: process.env.N8N_WEBHOOK_URL || "" });
});

// Recibe INE, Tarjeta de Circulación y (opcional) Constancia de Situación
// Fiscal, y te los manda por Telegram junto con los datos del cliente
app.post(
  "/subir-documentos",
  (req, res, next) => {
    upload.fields([
      { name: "ine", maxCount: 1 },
      { name: "tarjetaCirculacion", maxCount: 1 },
      { name: "constanciaFiscal", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const { idCotizacion, nombreCompleto, telefono, canal, marca, modelo, anio } = req.body;

    if (!token || !chatId) {
      return res.status(500).json({ ok: false, error: "Faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID" });
    }
    if (!req.files || (!req.files.ine && !req.files.tarjetaCirculacion)) {
      return res.status(400).json({ ok: false, error: "Faltan los archivos INE y/o Tarjeta de Circulación" });
    }

    try {
      const mensajeTexto =
        `📎 Documentos recibidos\n` +
        `ID cotización: ${idCotizacion || "-"}\n` +
        `Nombre: ${nombreCompleto || "-"}\n` +
        `Tel: ${telefono || "-"}\n` +
        `Auto: ${marca || "-"} ${modelo || "-"} ${anio || "-"}\n` +
        `Canal: ${canal || "-"}\n` +
        `Constancia fiscal: ${req.files.constanciaFiscal ? "Sí, adjunta" : "No adjuntó (se usará RFC genérico)"}`;

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: mensajeTexto }),
      });

      // Mandamos cada archivo como documento aparte (FormData/Blob nativos,
      // compatibles con fetch — la librería "form-data" no lo era)
      for (const campo of ["ine", "tarjetaCirculacion", "constanciaFiscal"]) {
        const archivo = req.files[campo] && req.files[campo][0];
        if (!archivo) continue;
        const buffer = fs.readFileSync(archivo.path);
        const blob = new Blob([buffer]);
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("caption", campo);
        form.append("document", blob, archivo.originalname);
        const respTg = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
          method: "POST",
          body: form,
        });
        const resultadoTg = await respTg.json();
        if (!resultadoTg.ok) {
          console.error(`Error mandando ${campo} a Telegram:`, resultadoTg);
        }
      }

      res.json({ ok: true });

      // Reenviamos a n8n (en segundo plano, sin bloquear la respuesta al
      // cliente) para que cree la carpeta en Drive y suba los documentos ahí
      const webhookDocumentos = process.env.N8N_WEBHOOK_URL_DOCUMENTOS;
      if (webhookDocumentos) {
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const archivosUrls = {};
        for (const campo of ["ine", "tarjetaCirculacion", "constanciaFiscal"]) {
          const archivo = req.files[campo] && req.files[campo][0];
          if (archivo) archivosUrls[campo] = `${baseUrl}/documentos/${archivo.filename}`;
        }
        fetch(webhookDocumentos, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idCotizacion, nombreCompleto, telefono, marca, modelo, anio, archivos: archivosUrls,
          }),
        }).catch((e) => console.error("Error avisando a n8n para Drive:", e.message));
      }
    } catch (e) {
      console.error("Error subiendo documentos:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// Notifica por Telegram cuando el cliente descarga su PDF (señal de interés real)
app.post("/notificar-descarga", async (req, res) => {
  const { nombreCompleto, telefono, marca, modelo, anio } = req.body || {};
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(500).json({ ok: false, error: "Faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID" });
  }

  const mensaje =
    `🔥 Interés real — descargó su PDF\n` +
    `Nombre: ${nombreCompleto || "-"}\n` +
    `Tel: ${telefono || "-"}\n` +
    `Vehiculo: ${marca || ""} ${modelo || ""} ${anio || ""}`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: mensaje }),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Error notificando descarga:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reenvía la decisión del cliente (¿continuar? ¿qué canal?) al Webhook de
// interés en n8n — mismo patrón que /enviar-cotizacion, evita problemas de CORS
app.post("/enviar-interes", async (req, res) => {
  const webhookUrl = process.env.N8N_WEBHOOK_URL_INTERES;
  if (!webhookUrl) {
    return res.status(500).json({ ok: false, error: "N8N_WEBHOOK_URL_INTERES no está configurada" });
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
    console.error("Error reenviando interés:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
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
