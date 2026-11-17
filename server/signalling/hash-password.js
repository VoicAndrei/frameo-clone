#!/usr/bin/env node
'use strict';

/**
 * Generate a scrypt password hash for an admin account.
 *
 * The password is NEVER taken from argv — that would leak it into `ps`, into the shell history
 * and into the container's process list. It is read from stdin: interactively (with echo off)
 * when stdin is a terminal, otherwise as the first line of whatever is piped in.
 *
 * Usage on the server:
 *
 *   docker exec -it frameo-signalling node hash-password.js --username ion --display "Ion" \
 *       --peer family-ana
 *
 *   # or non-interactively, from a password manager:
 *   printf '%s' "$PASSWORD" | docker exec -i frameo-signalling node hash-password.js -u ana
 *
 * It prints, on stdout:
 *   1. the bare `scrypt$...` string,
 *   2. a ready-to-paste admins.json account object,
 *   3. a ready-to-paste ADMIN_PASSWORD_HASHES line.
 *
 * Diagnostics go to stderr so `... | tail -1` style plumbing keeps working.
 */

const readline = require('node:readline');

const { hashPassword, MIN_PASSWORD_CHARS, MAX_PASSWORD_BYTES } = require('./scrypt');

const USERNAME_RE = /^[a-z0-9_-]{2,32}$/;

function parseArgs(argv) {
  const out = { username: '', display: '', peer: '', json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    switch (arg) {
      case '-u': case '--username': out.username = next().trim().toLowerCase(); break;
      case '-d': case '--display': case '--display-name': out.display = next().trim(); break;
      case '-p': case '--peer': case '--peer-id': out.peer = next().trim(); break;
      case '--json': out.json = true; break;
      case '-q': case '--quiet': out.quiet = true; break;
      case '-h': case '--help':
        process.stdout.write(
          'usage: node hash-password.js [-u username] [-d "Display Name"] [-p roster-peer-id] [--json]\n'
          + '\nReads the password from stdin. Minimum length: ' + MIN_PASSWORD_CHARS + ' characters.\n',
        );
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`unknown option: ${arg}\n`);
          process.exit(2);
        }
    }
  }
  return out;
}

/** Read a line from a TTY without echoing it. Falls back to plain readline on non-TTYs. */
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { data += d; });
      process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      process.stdin.on('error', reject);
      return;
    }
    process.stderr.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const onKeypress = () => {
      // Overwrite the echoed characters with nothing.
      readline.moveCursor(process.stderr, -1000, 0);
      readline.clearLine(process.stderr, 1);
      process.stderr.write(prompt);
    };
    process.stdin.on('data', onKeypress);
    rl.question('', (answer) => {
      process.stdin.removeListener('data', onKeypress);
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.username && !USERNAME_RE.test(args.username)) {
    process.stderr.write(`error: username must match ${USERNAME_RE}\n`);
    process.exit(2);
  }

  const password = await readSecret('Password: ');
  if (!password) {
    process.stderr.write('error: no password was supplied on stdin\n');
    process.exit(2);
  }
  if (password.length < MIN_PASSWORD_CHARS) {
    process.stderr.write(
      `error: password must be at least ${MIN_PASSWORD_CHARS} characters.\n`
      + '       A four-word passphrase ("cafea-verde-luni-7") is easier to type on a phone than\n'
      + '       "Xk9!q" and is far stronger. Put it in a password manager.\n',
    );
    process.exit(2);
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    process.stderr.write(`error: password exceeds ${MAX_PASSWORD_BYTES} bytes\n`);
    process.exit(2);
  }

  if (process.stdin.isTTY) {
    const again = await readSecret('Repeat:   ');
    if (again !== password) {
      process.stderr.write('error: the two passwords do not match\n');
      process.exit(2);
    }
  }

  const started = Date.now();
  const hash = hashPassword(password);
  const elapsed = Date.now() - started;

  const username = args.username || 'CHANGE-ME';
  const displayName = args.display || (args.username ? args.username : 'CHANGE ME');
  const peerId = args.peer || 'family-ana';

  if (args.json) {
    process.stdout.write(JSON.stringify({ username, displayName, peerId, passwordHash: hash, disabled: false }) + '\n');
    return;
  }

  process.stdout.write(hash + '\n');
  if (args.quiet) return;

  process.stdout.write('\n# admins.json entry (add to the "accounts" array):\n');
  process.stdout.write(
    JSON.stringify({ username, displayName, peerId, passwordHash: hash, disabled: false }, null, 2) + '\n',
  );
  process.stdout.write('\n# or, as one ADMIN_PASSWORD_HASHES entry (username|Display Name|peerId|hash):\n');
  process.stdout.write(`${username}|${displayName}|${peerId}|${hash}\n`);
  process.stderr.write(`\nscrypt took ${elapsed} ms on this machine.\n`);
}

main().catch((err) => {
  process.stderr.write('error: ' + String((err && err.message) || err) + '\n');
  process.exit(1);
});
