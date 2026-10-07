// admin/xlsxWriter.js
//
// A real Excel file, and a zip of CSV files, without a dependency.
//
// An .xlsx is a zip of a handful of XML files. Writing it by hand keeps the
// portal free of a spreadsheet library for the one thing it needs: a sheet
// with a bold header, euro amounts that stay numbers, a frozen top row and
// Excel's filter arrows on it. A semicolon CSV opens as one column in an
// English Excel and a comma one as one column in a Dutch Excel, so Excel is
// the default and CSV is there for whoever loads it into something else.

import zlib from "zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data: Buffer | string }]
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const packed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);          // names are UTF-8
    local.writeUInt16LE(8, 8);               // deflate
    local.writeUInt32LE(0, 10);              // time and date: none
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const xml = (value) => String(value ?? "")
  // Characters XML 1.0 does not allow at all, which Excel then refuses.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// Excel allows 31 characters and none of : \ / ? * [ ]
export function sheetName(value, taken = new Set()) {
  const base = String(value || "Sheet").replace(/[:\\/?*[\]]/g, " ").slice(0, 31).trim() || "Sheet";
  let name = base;

  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 27)} (${n})`;
  taken.add(name.toLowerCase());

  return name;
}

/*
 * sheets: [{ name, columns: [{ label, type?: "text" | "number" | "money", width? }], rows: [[...]] }]
 *
 * Styles: 0 plain, 1 bold header, 2 euro amount, 3 whole number.
 */
function sheetXml({ columns, rows }) {
  const style = { money: 2, number: 3 };

  const cell = (value, column, ref) => {
    if (value === null || value === undefined || value === "") return "";

    if ((column.type === "money" || column.type === "number") && Number.isFinite(Number(value))) {
      return `<c r="${ref}" s="${style[column.type]}"><v>${Number(value)}</v></c>`;
    }

    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  };

  const header = columns
    .map((column, i) => `<c r="${columnName(i)}1" s="1" t="inlineStr"><is><t>${xml(column.label)}</t></is></c>`)
    .join("");

  const body = rows.map((row, r) => {
    const line = r + 2;
    return `<row r="${line}">${columns.map((column, i) => cell(row[i], column, `${columnName(i)}${line}`)).join("")}</row>`;
  }).join("");

  const widths = columns
    .map((column, i) => `<col min="${i + 1}" max="${i + 1}" width="${column.width || (column.type === "money" ? 12 : 16)}" customWidth="1"/>`)
    .join("");

  const last = `${columnName(Math.max(columns.length - 1, 0))}${rows.length + 1}`;

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths}</cols>` +
    `<sheetData><row r="1">${header}</row>${body}</sheetData>` +
    `<autoFilter ref="A1:${last}"/>` +
    "</worksheet>";
}

export function xlsx(sheets) {
  const taken = new Set();
  const named = sheets.map((sheet) => ({ ...sheet, name: sheetName(sheet.name, taken) }));

  const files = [
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        "</Types>"
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>"
    },
    {
      name: "xl/workbook.xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${named.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
        "<definedNames>" +
        named.map((sheet, i) =>
          `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(sheet.name.replace(/'/g, "''"))}'!$A$1:$${columnName(Math.max(sheet.columns.length - 1, 0))}$${sheet.rows.length + 1}</definedName>`
        ).join("") +
        "</definedNames>" +
        "</workbook>"
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>"
    },
    {
      name: "xl/styles.xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;€&quot; #,##0.00"/></numFmts>' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="4">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        "</cellXfs>" +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>"
    },
    ...named.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) }))
  ];

  return zip(files);
}

// Comma-separated with a byte-order mark, so accents survive the trip.
export function csv({ columns, rows }) {
  const field = (value) => {
    const plain = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(plain) ? `"${plain.replace(/"/g, '""')}"` : plain;
  };

  const lines = [columns.map((column) => field(column.label)).join(",")];
  for (const row of rows) lines.push(row.map(field).join(","));

  return "﻿" + lines.join("\r\n") + "\r\n";
}
