// partner/catalogSearch.js
//
// Finding a product in our own catalogue (the SKU Master) for a line on a
// partner's sale document. He types what he knows - an article number, part
// of one, or a few words of the name ("essentials light oatmeal") - and gets
// the products that hold every one of those words, in any order, anywhere in
// the SKU, the name or the brand.
//
// The SKU Master is twelve thousand rows, so Airtable does the filtering:
// one formula, one call. When no product holds every word (a typo, an extra
// word), the products holding most of them come back instead, best first.

const TABLE = "SKU Master";
const FIELDS = ["SKU", "Product Name", "Brand", "Picture URL", "EU Sizes"];
const MAX_RESULTS = 20;
const MAX_WORDS = 6;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

// Lowercase, accents off, anything that is not a letter or digit a space.
export const plainText = (value) =>
  text(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// The words worth looking for: at most six, single letters left out.
export function searchWords(query) {
  return [...new Set(plainText(query).split(" ").filter((word) => word.length > 1))].slice(0, MAX_WORDS);
}

// One field Airtable can search in: SKU, name and brand, lowercase, with the
// SKU also without its dashes so "dd1391100" finds DD1391-100.
const HAYSTACK = "LOWER({SKU} & ' ' & SUBSTITUTE({SKU} & '', '-', '') & ' ' & {Product Name} & ' ' & {Brand})";

export function searchFormula(words, mode = "all") {
  // The words are letters and digits only (plainText), so nothing in them
  // can break out of the quotes.
  const finds = words.map((word) => `FIND('${word}', ${HAYSTACK}) > 0`);
  return finds.length === 1 ? finds[0] : `${mode === "all" ? "AND" : "OR"}(${finds.join(", ")})`;
}

// "36, 37, 37.5" -> ["36", "37", "37.5"].
export const sizeList = (value) => text(value).split(/[,;\n]+/).map((size) => size.trim()).filter(Boolean);

export function productView(fields = {}) {
  return {
    sku: text(fields.SKU).toUpperCase(),
    name: text(fields["Product Name"]),
    brand: text(fields.Brand),
    image: text(fields["Picture URL"]),
    sizes: sizeList(fields["EU Sizes"])
  };
}

/*
 * Best first: the article number he typed, then one that starts with it,
 * then the products holding the most words, then the shortest name - the
 * plain product before its variants.
 */
export function rankProducts(products, words) {
  const query = words.join("");

  const score = (product) => {
    const sku = plainText(product.sku).replace(/ /g, "");
    const hay = plainText(`${product.sku} ${product.name} ${product.brand}`);
    return {
      exact: sku === query ? 1 : 0,
      starts: query && sku.startsWith(query) ? 1 : 0,
      hits: words.filter((word) => hay.includes(word) || sku.includes(word)).length,
      length: product.name.length
    };
  };

  return products
    .map((product) => ({ product, s: score(product) }))
    .sort((a, b) => b.s.exact - a.s.exact || b.s.starts - a.s.starts || b.s.hits - a.s.hits || a.s.length - b.s.length)
    .map((entry) => entry.product);
}

/*
 * deps:
 *   select(table, { filterByFormula, fields, maxRecords }) -> records
 *     (the Airtable base, wrapped; see createCatalogSearch below)
 */
export function createCatalogSearch({ select }) {
  async function search(query) {
    const words = searchWords(query);
    if (!words.length) return { products: [], words };

    const read = async (mode, max) => {
      const records = await select(TABLE, { filterByFormula: searchFormula(words, mode), fields: FIELDS, maxRecords: max });
      return (records || []).map((record) => productView(record.fields)).filter((product) => product.sku || product.name);
    };

    let products = await read("all", 100);
    let partial = false;

    if (!products.length && words.length > 1) {
      products = await read("any", 100);
      partial = products.length > 0;
    }

    // One article number can sit in the SKU Master twice; it is one product.
    const seen = new Set();
    const unique = products.filter((product) => {
      const key = product.sku || product.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { products: rankProducts(unique, words).slice(0, MAX_RESULTS), words, partial };
  }

  return { search };
}

// The Airtable base from index.js, in the shape above.
export const airtableSelect = (base) => (table, options) => base(table).select(options).firstPage();
