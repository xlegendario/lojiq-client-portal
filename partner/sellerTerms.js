// partner/sellerTerms.js
//
// The terms a partner accepts once before he makes his own sale documents
// (partner/saleDocuments.js): Lojiq only provides the dashboard that writes
// his documents, plus storage and shipping when he wants them. Lojiq does not
// buy or sell his goods, is not named on his documents, and never holds the
// money his buyers pay him.
//
// A new version means a new acceptance: the page asks again whenever the
// version he accepted is not this one.

import crypto from "crypto";

export const TERMS_VERSION = "1.3";
export const TERMS_TITLE = "Seller Document & Fulfillment Services Agreement";

export const PROVIDER = {
  name: 'Payout by Kickz Caviar B.V. (trading as "Lojiq")',
  lines: ["Havenstraat 74D, 1271 AG Huizen, The Netherlands", "Chamber of Commerce (KvK): 94370451", "VAT: NL866752845B01"]
};

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const TERMS_SECTIONS = [
  ["1. Purpose and Scope", [
    "1.1. The Seller sells goods to buyers of the Seller's own choosing. The Seller wishes to use Lojiq's dashboard to prepare the sales documents for these sales, and may use Lojiq's warehousing and fulfillment services.",
    "1.2. Lojiq agrees to provide these services under the terms of this Agreement.",
    "1.3. Lojiq does not buy, sell or resell the Seller's goods, is not a party to the Seller's sales and is not the supplier of the goods.",
    "1.4. Scope. This Agreement applies only to transactions the Seller submits through the Lojiq dashboard. These may concern goods that are not in Lojiq's possession. Sales the Seller makes without using Lojiq's services fall outside this Agreement, and Lojiq has no responsibility for them."
  ]],
  ["2. Ownership of Goods", [
    "2.1. All goods remain the property of the Seller until ownership is transferred directly to the buyer.",
    "2.2. Lojiq does not acquire ownership of the goods by storing, handling or shipping them.",
    "2.3. The Seller confirms that they own the goods or are otherwise legally authorized to sell them."
  ]],
  ["3. The Seller's Sales", [
    "3.1. The Seller finds its own buyers, determines the selling prices and terms, and concludes the sales in its own name.",
    "3.2. The Seller is the legal supplier of the goods and is responsible for all obligations arising from the sale, including complaints, returns and warranty claims from buyers.",
    "3.3. Lojiq does not find buyers, set prices, negotiate or conclude sales for the Seller."
  ]],
  ["4. Sales Documents", [
    "4.1. For each transaction, the Seller enters the buyer, the goods, quantities and prices in the dashboard. Lojiq's system uses this information to generate a sales invoice and purchase declaration in the Seller's name.",
    "4.2. The Seller reviews and signs each document electronically before it is issued. The signature constitutes the Seller's own declaration and the Seller's instruction to issue the document.",
    "4.3. The content of each document, including the purchase declaration, is provided and declared by the Seller. The Seller is responsible for its accuracy. Lojiq does not verify the content and makes no statements of its own in these documents.",
    "4.4. Lojiq releases a document for issue after checking that it is complete. Lojiq may decline to issue a document where it has reason to believe the information is incomplete or inaccurate.",
    "4.5. Documents are issued in the Seller's name. Lojiq is not named as supplier on them."
  ]],
  ["5. Taxes and Compliance", [
    "5.1. The Seller is responsible for the taxes and legal obligations relating to their sales of goods, to the extent required by law.",
    "5.2. Lojiq is responsible for the taxes and legal obligations relating to its own services.",
    "5.3. VAT Registration Status. The Seller has informed Lojiq that the Seller is not registered for VAT. The Seller shall notify Lojiq in writing without delay if this changes, providing the Seller's business name, VAT number and country.",
    "5.4. Indemnity. The Seller shall indemnify Lojiq against any taxes, duties, penalties, interest and reasonable costs imposed on Lojiq as a result of inaccurate or incomplete information provided by the Seller, or the Seller's failure to comply with its own tax or customs obligations."
  ]],
  ["6. Warehousing and Fulfillment", [
    "6.1. Where the Seller uses these services, Lojiq may receive, store, inspect, package and ship goods on behalf of the Seller.",
    "6.2. Goods stored on behalf of the Seller remain identifiable as Seller-owned inventory.",
    "6.3. Fulfillment fees and shipping costs are shown to the Seller in the dashboard. Lojiq shall take reasonable care of goods in its possession; its liability for loss of or damage to goods is limited to the value of the goods as recorded by the Seller, except in case of intent or gross negligence. Lojiq does not insure goods held for the Seller unless agreed in writing.",
    "6.4. Import Documentation. For goods originating from outside the European Union, the Seller shall provide proof of lawful import (such as the customs declaration / MRN) upon Lojiq's request. Lojiq may refuse to receive or ship goods for which such proof is not provided."
  ]],
  ["7. Payments and Service Fees", [
    "7.1. Buyers pay the Seller directly, to the bank account stated on the sales document.",
    "7.2. Lojiq does not receive or hold payments for goods sold by the Seller.",
    "7.3. Lojiq charges the Seller a service fee per transaction, as a percentage or a fixed amount per item. The fee is shown to the Seller in the dashboard when the document is released for issue.",
    "7.4. All fees stated in this Agreement or in the dashboard include VAT where applicable.",
    "7.5. Lojiq invoices its fees to the Seller. Fee invoices are payable within 7 days. Lojiq may set off outstanding fees against any amounts Lojiq owes the Seller, and may suspend its services while fees are overdue."
  ]],
  ["8. Records and Information", [
    "8.1. Lojiq keeps records of the documents, signatures, instructions, fees and shipments processed under this Agreement. These electronic records may serve as evidence of the Seller's instructions and declarations.",
    "8.2. The Seller agrees to provide accurate identification and transaction information when reasonably requested.",
    "8.3. Buyer Data. Lojiq processes buyer personal data on behalf of the Seller, solely for performing the services under this Agreement and in accordance with applicable data protection law."
  ]],
  ["9. Independent Relationship", [
    "9.1. The Parties operate as independent contracting parties.",
    "9.2. Nothing in this Agreement creates an employment relationship, partnership, joint venture or agency to buy or sell goods.",
    "9.3. Relationship to Seller Terms. This Agreement governs only the Seller's own sales processed through the services described here. Goods the Seller sells to Lojiq remain subject to the Payout by Kickz Caviar Seller Terms & Conditions."
  ]],
  ["10. Termination", [
    "10.1. Either Party may terminate this Agreement by providing written notice.",
    "10.2. Outstanding fees and fulfillment obligations shall be settled in accordance with this Agreement.",
    "10.3. Lojiq may suspend its services where reasonably necessary due to inaccurate information, suspected unlawful activity, overdue fees or a material breach of this Agreement.",
    "10.4. Upon termination, the Parties shall arrange the return or transfer of any remaining Seller-owned goods, subject to outstanding obligations."
  ]],
  ["11. Governing Law", [
    "11.1. This Agreement is governed by Dutch law, subject to any mandatory provisions of applicable law.",
    "11.2. Any disputes shall be submitted to the competent courts of the Netherlands, insofar as legally permitted."
  ]],
  ["12. Electronic Acceptance", [
    "By pressing \"I agree\", the Seller confirms that:",
    "- They have read and agree to this Agreement.",
    "- They are the seller of the goods in every transaction they submit, and they find their own buyers and set their own prices.",
    "- Lojiq provides document and fulfillment services only, and is not the buyer, seller or supplier of the goods.",
    "- Every document they sign contains their own declarations, for which they are responsible.",
    "- The VAT registration status stated in Article 5.3 is correct, and they will report any change without delay.",
    "- They accept the applicable service fees."
  ]]
];

/*
 * The agreement as one block of text, with the seller in it: what is shown,
 * and what is hashed when he accepts, so the record says exactly which words
 * he agreed to.
 */
export function termsText(seller = {}) {
  const parties = [
    TERMS_TITLE,
    `Version ${TERMS_VERSION}`,
    "",
    "Service Provider",
    PROVIDER.name,
    ...PROVIDER.lines,
    "",
    "Seller",
    text(seller.name),
    text(seller.address),
    text(seller.country),
    `Seller ID: ${text(seller.seller_id)}`
  ];

  const body = TERMS_SECTIONS.flatMap(([heading, paragraphs]) => ["", heading, ...paragraphs]);
  return [...parties, ...body].join("\n");
}

export const termsHash = (seller) => crypto.createHash("sha256").update(termsText(seller)).digest("hex");

// What the page shows: the same words, in parts it can lay out.
export function termsView(seller = {}) {
  return {
    version: TERMS_VERSION,
    title: TERMS_TITLE,
    provider: PROVIDER,
    seller: {
      name: text(seller.name),
      address: text(seller.address),
      country: text(seller.country),
      seller_id: text(seller.seller_id)
    },
    sections: TERMS_SECTIONS.map(([heading, paragraphs]) => ({ heading, paragraphs }))
  };
}
