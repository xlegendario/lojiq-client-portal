// admin/sellerAgreement.js
//
// The Seller Registration Agreement: the record of what a new seller agreed to
// when he signed up in the Kickz Caviar portal. Eledo made it through Make
// (scenario 13.1) until 11-11-2026; the portal now asks for it here once the
// seller has linked Discord, and it is kept in the private bucket
// "seller-agreements" and put in "Agreement PDF" on his Sellers Database row.
//
// It states only what the seller saw on the sign-up page: the version of the
// Terms & Conditions behind the link, and the VAT declaration printed above
// the "I agree" tick (VAT_DECLARATIONS - keep in step with
// kickz-caviar-portal public/signup.html).

import crypto from "crypto";
import express from "express";

import { Page, buildPdf } from "../partner/saleDocumentPdf.js";
import { wrap } from "./selfBillingPdf.js";

export const BUCKET = "seller-agreements";
export const TERMS_URL = "https://bit.ly/kickzcaviar-terms";

export const TERMS_VERSIONS = {
  "v1.0": "02-12-2025",
  "v1.1": "16-10-2026"
};

export const VAT_DECLARATIONS = {
  v1: "For every deal you choose the VAT type yourself (Margin, VAT0 or VAT21). That choice is your own declaration. If you choose Margin, you declare that you did not deduct VAT on the goods, and, if you are a business, that you apply the margin scheme yourself. Tell us straight away if your VAT status changes."
};

const SELLER_FIELDS = ["Seller ID", "Full Name", "Company Name", "VAT ID", "Email", "Address", "Zipcode", "City", "Country", "Payout Info", "T&C Version", "Agreement Text"];

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const GREY = [0.38, 0.38, 0.38];

export class AgreementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const stamp = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} (Amsterdam time)`;
};

/*
 * input: { seller: Sellers Database fields, acceptedAt, method, discordId,
 *          discordTag, tcVersion, vatDeclarationVersion }
 */
export function sellerAgreementPdf(input) {
  const f = input.seller || {};
  const page = new Page();
  const left = 50;
  const width = 595.28 - 100;
  let y = 841.89 - 56;

  const line = (value, opts = {}) => {
    for (const part of wrap(text(value), opts.size || 9.5, width - (opts.indent || 0), opts.bold)) {
      page.write(part, left + (opts.indent || 0), y, { size: opts.size || 9.5, bold: opts.bold, color: opts.color });
      y -= (opts.size || 9.5) + 4;
    }
  };
  const gap = (n = 8) => { y -= n; };
  const heading = (value) => { gap(6); line(value, { size: 11, bold: true }); gap(2); };

  line("SELLER REGISTRATION AGREEMENT", { size: 15, bold: true });
  line("Payout by Kickz Caviar B.V.", { size: 10, color: GREY });
  gap(10);

  heading("1. Seller Information");
  const rows = [
    ["Seller ID", f["Seller ID"]],
    ["Full Name", f["Full Name"]],
    ["Company Name", f["Company Name"]],
    ["VAT ID", f["VAT ID"]],
    ["Email", f.Email],
    ["Address", f.Address],
    ["Zipcode", f.Zipcode],
    ["City", f.City],
    ["Country", f.Country],
    ["Payout Information", f["Payout Info"]],
    ["Discord ID", input.discordId],
    ["Discord Username", input.discordTag]
  ];
  for (const [label, value] of rows) {
    page.write(`${label}:`, left, y, { size: 9.5, bold: true });
    page.write(text(value) || "-", left + 130, y, { size: 9.5 });
    y -= 13.5;
  }

  const version = text(input.tcVersion) || "v1.1";
  heading("2. Agreement Confirmation");
  line("By completing the seller registration in the Kickz Caviar portal and ticking \"I agree to the Terms & Conditions\", the seller above has confirmed:");
  for (const item of [
    "that all provided information is accurate and truthful;",
    `that they agree to be a seller for Payout by Kickz Caviar B.V. under the Kickz Caviar Terms & Conditions, version ${version.replace(/^v/, "")}${TERMS_VERSIONS[version] ? ` (last updated ${TERMS_VERSIONS[version]})` : ""};`,
    "that Kickz Caviar may use this information for operational, payout, invoicing and identity-verification purposes;",
    "that Payout by Kickz Caviar B.V. may issue self-billing invoices in their name and on their behalf, as set out in the Terms & Conditions;",
    "that they consent to electronic acceptance and digital record-keeping of this agreement."
  ]) line(`- ${item}`, { indent: 10 });

  heading("3. VAT Declaration");
  const declaration = VAT_DECLARATIONS[text(input.vatDeclarationVersion)] || "";
  if (declaration) {
    line("Shown to the seller directly above the \"I agree\" tick, and accepted with it:");
    line(`"${declaration}"`, { indent: 10 });
  } else {
    line("No separate VAT declaration was shown at this registration; the VAT provisions of the Terms & Conditions (4.4 - 4.10) apply.");
  }
  gap(2);
  line(`VAT status given at registration: ${text(f["VAT ID"]) ? `VAT ID ${text(f["VAT ID"])}` : "no VAT ID provided"}${text(f["Company Name"]) ? `, company name "${text(f["Company Name"])}"` : ""}.`);

  heading("4. Terms & Conditions Reference");
  line(`The Terms & Conditions accepted are available at ${TERMS_URL}. Earlier versions are kept as evidence. When the terms are updated, the seller is informed by email or Discord.`);

  heading("5. Electronic Acceptance");
  line(`Method: ${text(input.method) || "Kickz Caviar portal registration, \"I agree to the Terms & Conditions\" tick"}`);
  line(`Accepted at: ${stamp(input.acceptedAt) || "-"}`);
  line(`Discord account linked: ${text(input.discordTag) || "-"} (${text(input.discordId) || "-"})`);
  gap(4);
  line("This record was generated automatically by Payout by Kickz Caviar B.V. from the registration data and is stored with a SHA-256 hash of this file, so any later change to it can be detected.", { size: 8.5, color: GREY });

  return buildPdf([page], null);
}

/*
 * deps:
 *   airtable   the admin's reader: byIds, update
 *   db         createSupabaseRest (seller_agreements)
 *   storage    { upload(name, buffer), signedUrl(name) } on BUCKET
 */
export function createSellerAgreements({ airtable, db, storage, now = () => new Date() }) {
  async function make(input = {}) {
    const id = text(input.airtable_record_id);
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new AgreementError("That is not a seller record id.");

    const sellers = await airtable.byIds("Sellers Database", [id], SELLER_FIELDS);
    const seller = sellers.get(id);
    if (!seller) throw new AgreementError("That seller does not exist.", 404);

    const tcVersion = text(input.tc_version) || text(seller["T&C Version"]) || "v1.1";
    const vatDeclarationVersion = text(input.vat_declaration_version);
    const acceptedAt = text(input.accepted_at) || now().toISOString();

    const pdf = sellerAgreementPdf({
      seller,
      acceptedAt,
      method: input.method,
      discordId: input.discord_id,
      discordTag: input.discord_tag,
      tcVersion,
      vatDeclarationVersion
    });
    const hash = crypto.createHash("sha256").update(pdf).digest("hex");
    const sellerId = text(seller["Seller ID"]);
    const name = `${sellerId || id}-${acceptedAt.slice(0, 10)}-${hash.slice(0, 8)}.pdf`;

    const path = await storage.upload(name, pdf);
    await db.insert("seller_agreements", [{
      seller_record_id: id,
      seller_id: sellerId,
      tc_version: tcVersion,
      vat_declaration_version: vatDeclarationVersion || null,
      method: text(input.method) || null,
      accepted_at: acceptedAt,
      discord_id: text(input.discord_id) || null,
      discord_tag: text(input.discord_tag) || null,
      storage_path: path,
      pdf_hash: hash
    }]);

    // Airtable copies the file from the address it is given, so a short-lived
    // signed address is enough and the file itself stays private.
    const url = await storage.signedUrl(name, 3600);
    await airtable.update("Sellers Database", id, { "Agreement PDF": [{ url, filename: `${sellerId || "Seller"} Registration Agreement.pdf` }] });

    return { seller_id: sellerId, file: name, hash };
  }

  return { make };
}

export function mountSellerAgreements(router, { store, internalSecret = "" }) {
  router.post("/api/internal/seller-agreement", express.json({ limit: "5kb" }), async (req, res) => {
    if (!text(internalSecret) || text(req.headers["x-kc-secret"]) !== text(internalSecret)) return res.status(401).json({ error: "Unauthorized" });

    try {
      const made = await store.make(req.body || {});
      console.log(`[seller agreement] made for ${made.seller_id}: ${made.file}`);
      res.json({ ok: true, ...made });
    } catch (err) {
      const status = err instanceof AgreementError ? err.status : 500;
      if (status >= 500) console.error("[seller agreement]", err.message);
      res.status(status).json({ error: err.message });
    }
  });
}
