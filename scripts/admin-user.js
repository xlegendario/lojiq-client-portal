// scripts/admin-user.js
//
// Makes one admin account entry for LOJIQ_ADMIN_USERS.
//
//   node scripts/admin-user.js you@example.com "Your Name"
//
// Asks for the password without showing it, then prints the JSON entry. Put
// all entries in one list in the Render environment:
//
//   LOJIQ_ADMIN_USERS=[{...first...},{...second...}]
//
// The password itself is never printed or stored; running this again with a
// new password and replacing the entry signs that account out everywhere.

import readline from "readline";

import { hashPassword } from "../admin/adminAuth.js";

const [email, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ").trim();

if (!email || !email.includes("@") || !name) {
  console.error('Usage: node scripts/admin-user.js you@example.com "Your Name"');
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

const password = await ask("Password (at least 12 characters): ");

if (password.length < 12) {
  console.error("Too short. Use at least 12 characters.");
  process.exit(1);
}

const again = await ask("Same password again: ");

if (again !== password) {
  console.error("The two passwords are not the same.");
  process.exit(1);
}

console.log(JSON.stringify({ email: email.trim().toLowerCase(), name, hash: hashPassword(password) }));
