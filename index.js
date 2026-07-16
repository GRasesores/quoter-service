const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const MAPS_URL_LOGIN = "https://maps-sistemas.com/login#/";
const MAPS_URL_QUOTES = "https://maps-sistemas.com/#/quotes";

// -----------------------------------------------------------------------
// POST /cotizar
// Body esperado (viene del formulario n8n):
// {
//   marca, modelo, version, anio,
//   uso: "particular" | "plataforma",
//   subtipoPlataforma: "una" | "multi" | null,
//   periodicidad: "mensual" | "trimestral" | "semestral" | "anual",
//   tipoPoliza: "RC" | "limitada" | "amplia",
//   nombreCompleto, codigoPostal, telefono, correo
// }
// -----------------------------------------------------------------------
app.post("/cotizar", async (req, res) => {
  const datos = req.body;
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // ---------- 1. LOGIN ----------
    // Confirmado con devtools: input#email, input#password, botón "INGRESAR"
    await page.goto(MAPS_URL_LOGIN, { waitUntil: "networkidle" });

    await page.fill("#email", process.env.MAPS_SEGUROS_USER);
    await page.fill("#password", process.env.MAPS_SEGUROS_PASS);
    await page.click('button:has-text("INGRESAR")');

    // Tras el login, la SPA redirige fuera de /login
    await page.waitForFunction(() => !window.location.href.includes("/login"), {
      timeout: 15000,
    });

    // ---------- 2. IR A COTIZACIONES ----------
    await page.goto(MAPS_URL_QUOTES, { waitUntil: "networkidle" });

    // Helper: selecciona una opción de un <select> nativo ubicado justo
    // después de una etiqueta de texto visible (ej. "Marca:", "Uso:")
    async function selectByLabel(labelText, optionLabel) {
      const select = page.locator(
        `xpath=//label[contains(text(),"${labelText}")]/following::select[1]`
      );
      await select.waitFor({ state: "visible", timeout: 10000 });
      await select.selectOption({ label: optionLabel });
    }

    // ---------- 3. TAB: DATOS DEL CLIENTE ----------
    // Esperamos a que la app termine de renderizar por completo antes de interactuar
    await page.waitForSelector("text=Cotizaciones", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const datosClienteTab = page.getByText("Datos del Cliente", { exact: true });
    await datosClienteTab.waitFor({ state: "visible", timeout: 30000 });
    await datosClienteTab.click();
    const clienteInput = page.locator("input").first(); // campo autocomplete "Cliente"
    await clienteInput.fill("CLIENTE EJEMPLO PARA COTIZAR");
    await page.getByText("CLIENTE EJEMPLO PARA COTIZAR", { exact: false }).first().click();

    // ---------- 4. TAB: DATOS DE LA UNIDAD ----------
    const datosUnidadTab = page.getByText("Datos de la Unidad", { exact: true });
    await datosUnidadTab.waitFor({ state: "visible", timeout: 20000 });
    await datosUnidadTab.click();
    await page.waitForTimeout(500);

    // Tipo de Transporte se deja en "Automóvil" (default)
    await selectByLabel("Marca", datos.marca);
    await selectByLabel("Submarca", datos.modelo); // "modelo" del form = submarca real
    await selectByLabel("Modelo", String(datos.anio)); // "Modelo" en Maps = año real
    await selectByLabel("Version", datos.version);

    // "Uso" ahora viene directo del dropdown del form de n8n, que replica
    // 1:1 las opciones reales de Maps Seguros (ver lista completa en README).
    // "CONDUCTOR APP" = multiplataforma (confirmado por Luis Miguel).
    await selectByLabel("Uso", datos.uso);

    // "Servicio" se deriva de "Uso" según regla de negocio confirmada
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
      return "PARTICULAR"; // default para el resto de opciones
    }
    await selectByLabel("Servicio", derivarServicio(datos.uso));

    // Flotilla: SIEMPRE este valor, confirmado por Luis Miguel (mejor precio)
    await selectByLabel("Flotilla", "Descuento Flotilla AA 11 A 20");

    // ---------- 5. TAB: DETALLES DE COBERTURA ----------
    const coberturaTab = page.getByText("Detalles de Cobertura", { exact: true });
    await coberturaTab.waitFor({ state: "visible", timeout: 20000 });
    await coberturaTab.click();
    await page.waitForTimeout(500);
    // tipoPoliza del form: "RC" | "LIMITADA" | "AMPLIA"
    await selectByLabel("Tipo de Cobertura", datos.tipoPoliza);
    // El resto de la tabla (deducibles, sumas aseguradas) se deja en sus
    // valores por defecto — confirmado, no se toca celda por celda.

    // ---------- 6. TAB: INFORMACION DE LA COTIZACION ----------
    const infoCotizacionTab = page.getByText("Información de la Cotización", { exact: true });
    await infoCotizacionTab.waitFor({ state: "visible", timeout: 20000 });
    await infoCotizacionTab.click();
    await page.waitForTimeout(500);
    // Inicio de Vigencia queda en la fecha por defecto (hoy)
    // TODO: confirmar si "Conducto de Cobro" siempre debe ser un valor fijo
    await selectByLabel("Conducto de Cobro", datos.conductoCobro || "Tarjeta de Crédito");

    // ---------- 7. LEER EL TOTAL CALCULADO (panel derecho, en vivo) ----------
    await page.waitForTimeout(1000); // pequeño margen para que recalcule
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

    // Guardar la cotización dentro de Maps Seguros
    await page.getByText("Guardar", { exact: true }).click();

    await browser.close();

    return res.json({
      ok: true,
      datosEnviados: datos,
      resultado,
    });
  } catch (err) {
    if (browser) await browser.close();
    console.error("Error cotizando:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quoter service escuchando en puerto ${PORT}`));
