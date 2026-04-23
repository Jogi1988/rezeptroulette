/**
 * RezeptRoulette – Cloudflare Worker (Rezept-Import-API + Sync)
 * 
 * Endpunkte:
 *   GET  /api/fetch-recipe?url=...   – Rezept von URL importieren
 *   GET  /api/sync                    – Daten vom Server holen
 *   POST /api/sync                    – Daten zum Server pushen & mergen
 * 
 * Benötigt:
 *   - KV Namespace Binding: RECIPES_KV
 *   - Environment Variable: SYNC_TOKEN
 */

const ALLOWED_ORIGINS = ['https://jo-gis.de', 'https://www.jo-gis.de', 'http://jo-gis.de', 'http://www.jo-gis.de', 'https://jogi1988.github.io', 'https://Jogi1988.github.io', 'http://localhost:8080', 'http://localhost:3000'];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
    }

    const url = new URL(request.url);

    // ── Sync endpoints ──
    if (url.pathname === '/api/sync') {
      return handleSync(request, env, cors);
    }

    if (url.pathname !== '/api/fetch-recipe') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const recipeUrl = url.searchParams.get('url');
    if (!recipeUrl) {
      return jsonResp(400, { error: "Parameter 'url' fehlt" }, cors);
    }

    // SSRF protection
    try {
      const parsed = new URL(recipeUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return jsonResp(400, { error: 'Nur HTTP/HTTPS-URLs erlaubt' }, cors);
      }
      const host = parsed.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' ||
          host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.16.') ||
          host.endsWith('.local')) {
        return jsonResp(400, { error: 'Lokale URLs nicht erlaubt' }, cors);
      }
    } catch {
      return jsonResp(400, { error: 'Ungültige URL' }, cors);
    }

    try {
      const resp = await fetch(recipeUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        },
      });
      const html = await resp.text();
      const hostname = new URL(recipeUrl).hostname.toLowerCase();

      let data;
      if (hostname.includes('hellofresh')) {
        data = parseHellofresh(html);
      } else {
        data = parseGeneric(html);
      }

      return jsonResp(200, data, cors);
    } catch (e) {
      return jsonResp(502, { error: `Seite konnte nicht geladen werden: ${e.message}` }, cors);
    }
  }
};

function jsonResp(status, data, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ═══════════════════════════════════════════════════════════════
//  Sync (Cloudflare KV)
// ═══════════════════════════════════════════════════════════════

function checkAuth(request, env) {
  const token = env.SYNC_TOKEN;
  if (!token) return false;
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${token}`;
}

function mergeArrays(local, remote) {
  const map = new Map();
  for (const item of remote) map.set(String(item.id), item);
  for (const item of local) {
    const key = String(item.id);
    const existing = map.get(key);
    if (!existing || (item.modifiedAt || 0) > (existing.modifiedAt || 0)) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

async function handleSync(request, env, cors) {
  if (!checkAuth(request, env)) {
    return jsonResp(401, { error: 'Ungültiger Sync-Token' }, cors);
  }
  if (!env.RECIPES_KV) {
    return jsonResp(500, { error: 'KV nicht konfiguriert' }, cors);
  }

  if (request.method === 'GET') {
    const data = await env.RECIPES_KV.get('sync_data', { type: 'json' });
    return jsonResp(200, data || { recipes: [], planned_meals: [] }, cors);
  }

  if (request.method === 'POST') {
    const incoming = await request.json();
    const stored = await env.RECIPES_KV.get('sync_data', { type: 'json' }) || { recipes: [], planned_meals: [] };

    const merged = {
      recipes: mergeArrays(incoming.recipes || [], stored.recipes || []),
      planned_meals: mergeArrays(incoming.planned_meals || [], stored.planned_meals || []),
    };

    await env.RECIPES_KV.put('sync_data', JSON.stringify(merged));
    return jsonResp(200, merged, cors);
  }

  return jsonResp(405, { error: 'Method not allowed' }, cors);
}

// ═══════════════════════════════════════════════════════════════
//  HelloFresh Parser (via __NEXT_DATA__)
// ═══════════════════════════════════════════════════════════════

function parseHellofresh(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return parseGeneric(html);

  let nextData;
  try { nextData = JSON.parse(m[1]); } catch { return parseGeneric(html); }

  const recipe = nextData?.props?.pageProps?.ssrPayload?.recipe;
  if (!recipe) return parseGeneric(html);

  // Title
  let title = recipe.name || '';
  if (recipe.headline && !title.includes(recipe.headline)) {
    title = `${title} – ${recipe.headline}`;
  }

  // Image
  let imageUrl = '';
  if (recipe.imagePath) {
    imageUrl = `https://img.hellofresh.com/f_auto,fl_lossy,h_640,q_auto,w_1200/hellofresh_s3${recipe.imagePath}`;
  }

  // Prep time
  const prepTime = isoDurationToText(recipe.prepTime || recipe.totalTime || '');

  // Calories
  let calories = '';
  for (const n of (recipe.nutrition || [])) {
    if ((n.unit || '').includes('kcal')) { calories = `${n.amount} ${n.unit}`; break; }
  }

  // Tags
  const tags = [];
  for (const t of (recipe.tags || [])) { if (t.name && !tags.includes(t.name)) tags.push(t.name); }
  for (const c of (recipe.cuisines || [])) { if (c.name && !tags.includes(c.name)) tags.push(c.name); }

  // Ingredients with quantities for 2/3/4 persons via yields[]
  const ingMap = {};
  for (const ing of (recipe.ingredients || [])) { ingMap[ing.id] = ing.name || 'Unbekannt'; }

  const yields = (recipe.yields || []).sort((a, b) => (a.yields || 0) - (b.yields || 0));
  const qtyMap = {};

  for (const y of yields) {
    const servings = y.yields || 0;
    if (![2, 3, 4].includes(servings)) continue;
    for (const yi of (y.ingredients || [])) {
      const id = yi.id || '';
      let amount = yi.amount;
      const unit = yi.unit || '';
      let qtyStr = '';
      if (amount != null) {
        if (typeof amount === 'number' && amount === Math.floor(amount)) amount = Math.floor(amount);
        qtyStr = `${amount} ${unit}`.trim();
      }
      if (!qtyMap[id]) qtyMap[id] = { qty2p: '', qty3p: '', qty4p: '' };
      qtyMap[id][`qty${servings}p`] = qtyStr;
    }
  }

  const ingredients = (recipe.ingredients || []).map(ing => ({
    name: ing.name || 'Unbekannt',
    qty2p: qtyMap[ing.id]?.qty2p || '',
    qty3p: qtyMap[ing.id]?.qty3p || '',
    qty4p: qtyMap[ing.id]?.qty4p || '',
  }));

  // Steps
  const steps = (recipe.steps || []).map((step, i) => {
    let titleText = '';
    if (step.images?.[0]?.caption) titleText = step.images[0].caption.trim();
    if (!titleText) {
      const sentences = (step.instructions || '').split(/(?<=[.!?])\s+/);
      titleText = sentences[0]?.slice(0, 60) || `Schritt ${step.index || i + 1}`;
    }
    return {
      number: step.index || i + 1,
      title: titleText,
      body: cleanMarkdown(step.instructions || ''),
    };
  });

  return { title, imageUrl, prepTime, calories, tags, ingredients, steps };
}

// ═══════════════════════════════════════════════════════════════
//  Generic Parser (JSON-LD schema.org/Recipe)
// ═══════════════════════════════════════════════════════════════

function parseGeneric(html) {
  const result = { title: '', imageUrl: '', prepTime: '', calories: '', tags: [], ingredients: [], steps: [] };

  // Find JSON-LD
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>(.*?)<\/script>/gs)];
  let ld = null;
  for (const block of ldBlocks) {
    try {
      const data = JSON.parse(block[1]);
      ld = findRecipeInLd(data);
      if (ld) break;
    } catch {}
  }

  if (ld) {
    result.title = ld.name || '';
    const img = ld.image;
    if (Array.isArray(img) && img.length) result.imageUrl = typeof img[0] === 'string' ? img[0] : img[0]?.url || '';
    else if (typeof img === 'string') result.imageUrl = img;

    result.prepTime = isoDurationToText(ld.totalTime || ld.prepTime || '');
    if (ld.nutrition?.calories) result.calories = ld.nutrition.calories;

    for (const field of ['recipeCategory', 'recipeCuisine', 'keywords']) {
      const val = ld[field];
      if (Array.isArray(val)) result.tags.push(...val);
      else if (typeof val === 'string') result.tags.push(...val.split(',').map(t => t.trim()).filter(Boolean));
    }
    result.tags = [...new Set(result.tags)];

    for (const text of (ld.recipeIngredient || [])) {
      result.ingredients.push(parseIngredientText(text.trim()));
    }

    (ld.recipeInstructions || []).forEach((inst, i) => {
      if (typeof inst === 'object') {
        result.steps.push({ number: i + 1, title: inst.name || `Schritt ${i + 1}`, body: cleanMarkdown(inst.text || '') });
      } else if (typeof inst === 'string') {
        result.steps.push({ number: i + 1, title: `Schritt ${i + 1}`, body: cleanMarkdown(inst) });
      }
    });
  }

  if (!result.title) result.title = extractMeta(html, 'og:title') || extractTitle(html);
  if (!result.imageUrl) result.imageUrl = extractMeta(html, 'og:image') || '';

  return result;
}

function findRecipeInLd(data) {
  if (!data) return null;
  if (typeof data === 'object' && !Array.isArray(data)) {
    if (data['@type'] === 'Recipe') return data;
    for (const item of (data['@graph'] || [])) { const r = findRecipeInLd(item); if (r) return r; }
  }
  if (Array.isArray(data)) { for (const item of data) { const r = findRecipeInLd(item); if (r) return r; } }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════

function isoDurationToText(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return iso;
  const h = parseInt(m[1] || 0), min = parseInt(m[2] || 0);
  if (!h && !min) return '';
  const parts = [];
  if (h) parts.push(`${h} Std`);
  if (min) parts.push(`${min} Min`);
  return parts.join(' ');
}

function cleanMarkdown(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIngredientText(text) {
  const m = text.match(/^(\d+(?:[.,/½⅓¼¾⅔]\d*)?)\s*(g|kg|ml|l|cl|dl|EL|TL|Stk|Stück|Prise|Bund|Packung|Dose|Scheiben?|Zehen?|Esslöffel|Teelöffel)?\s*(.+)$/u);
  if (m) {
    const qty = `${m[1]} ${m[2] || ''}`.trim();
    return { name: m[3].trim(), qty2p: qty, qty3p: '', qty4p: '' };
  }
  return { name: text, qty2p: '', qty3p: '', qty4p: '' };
}

function extractMeta(html, prop) {
  for (const pat of [
    new RegExp(`<meta[^>]*property="${prop}"[^>]*content="([^"]*)"`, 'i'),
    new RegExp(`<meta[^>]*content="([^"]*)"[^>]*property="${prop}"`, 'i'),
  ]) { const m = html.match(pat); if (m) return m[1]; }
  return '';
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}
