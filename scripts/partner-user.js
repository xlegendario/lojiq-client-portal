// scripts/partner-user.js
//
// Makes (or resets) one partner dashboard login.
//
//   node scripts/partner-user.js jimmy@example.com "Jimmy" SE-00781 recXXXXXXXXXXXXXX
//
// The last argument is the partner's record id in the Sellers Database. Asks
// for the password without showing it, then prints one SQL statement to run
// in the Supabase SQL editor. Running it again for the same e-mail sets a new
// password and signs that login out everywhere.

import readline from "readline";

import { hashPassword } from "../admin/adminAuth.js";

const [email, name, sellerId, sellerRecordId] = process.argv.slice(2).map((value) => String(value || "").trim());

if (!email || !email.includes("@") || !name || !/^SE-\d+$/.test(sellerId) || !/^rec[A-Za-z0-9]{14}$/.test(sellerRecordId)) {
  console.error('Usage: node scripts/partner-user.js partner@example.com "Name" SE-00000 recXXXXXXXXXXXXXX');
  process.exit(1);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    // Echo nothing while the password is typed.
    rl._writeToOutput = (chunk) => {
      if (chunk.includes(question)) rl.output.write(chunk);
    };

    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const password = await ask("Password (at least 10 characters): ");

if (password.length < 10) {
  console.error("Too short. Use at least 10 characters.");
  process.exit(1);
}

const again = await ask("Same password again: ");

if (again !== password) {
  console.error("The two passwords are not the same.");
  process.exit(1);
}

const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

console.log(
  "insert into public.partner_users (email, name, seller_id, seller_record_id, password_hash, active)\n" +
    `values (${sql(email.toLowerCase())}, ${sql(name)}, ${sql(sellerId)}, ${sql(sellerRecordId)}, ${sql(hashPassword(password))}, true)\n` +
    "on conflict (email) do update set name = excluded.name, seller_id = excluded.seller_id,\n" +
    "  seller_record_id = excluded.seller_record_id, password_hash = excluded.password_hash, active = true;"
);
