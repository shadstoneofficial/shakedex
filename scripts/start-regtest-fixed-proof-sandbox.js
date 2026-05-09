#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {createFixedPriceAuction} = require('../src/auction.js');
const {setupSwap, startRegtest, stopRegtest} = require('../test/hsd.js');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[idx + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

function usage() {
  console.log(`
Start a persistent fake local regtest buyer sandbox.

Usage:
  npm run start-regtest-fixed-proof-sandbox -- --price 42 --out ~/Desktop/learnhns-fixed-proof.json

Options:
  --price <hns>   Fixed buy-now price in HNS. Default: 42
  --out <path>    Output proof JSON path. Default: /tmp/learnhns-fixed-proof.json
  --quiet-hsd     Hide HSD debug logs.
  --help          Show this help text.
`);
}

function expandHome(input) {
  if (!input || input[0] !== '~') {
    return input;
  }
  return path.join(process.env.HOME, input.slice(1));
}

async function waitForExit() {
  console.log('');
  console.log('Sandbox is running. Press Ctrl+C to stop it when you are done.');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    rl.once('close', resolve);
  });

  rl.close();
}

async function main() {
  if (hasArg('--help') || hasArg('-h')) {
    usage();
    return;
  }

  if (hasArg('--quiet-hsd')) {
    process.env.SILENCE_HSD = '1';
  }

  const priceHNS = Number(argValue('--price', '42'));
  if (Number.isNaN(priceHNS) || priceHNS <= 0) {
    throw new Error('--price must be a positive number of HNS.');
  }

  const outPath = path.resolve(
    expandHome(argValue('--out', '/tmp/learnhns-fixed-proof.json'))
  );

  console.log('Starting persistent fake local regtest chain.');
  await startRegtest();

  let stopped = false;
  async function stopOnce() {
    if (stopped) {
      return;
    }
    stopped = true;
    console.log('Stopping fake local regtest chain.');
    await stopRegtest();
  }

  try {
    console.log('Creating fake wallets, mining fake HNS, and registering a fake name.');
    const {alice, bob, name, finalizeLock} = await setupSwap();
    const lockTime = await alice.getMTP();
    const auction = await createFixedPriceAuction({
      context: alice,
      lockFinalize: finalizeLock,
      price: Math.round(priceHNS * 1e6),
      lockTime: lockTime >>> 0,
      feeRate: 0,
      feeAddr: null,
    });

    await fs.promises.mkdir(path.dirname(outPath), {recursive: true});
    await fs.promises.writeFile(
      outPath,
      JSON.stringify(auction.toJSON(alice), null, 2)
    );

    console.log('');
    console.log('Persistent buyer sandbox is ready.');
    console.log('');
    console.log(`Proof path: ${outPath}`);
    console.log(`Name: ${name}`);
    console.log(`Price: ${priceHNS} HNS`);
    console.log(`Seller wallet id: ${alice.walletId}`);
    console.log(`Buyer wallet id: ${bob.walletId}`);
    console.log('');
    console.log('Regtest RPC details:');
    console.log('Node RPC URL: http://127.0.0.1:14037');
    console.log('Wallet RPC URL: http://127.0.0.1:14039');
    console.log('API key: test');
    console.log('Wallet passphrase: password');
    console.log('');
    console.log('Use staging only. Do not use production Bob Wallet.');

    await waitForExit();
  } finally {
    await stopOnce();
  }
}

main().catch(async (err) => {
  console.error(err);
  try {
    await stopRegtest();
  } catch (e) {
    // Ignore cleanup errors; the original error is more useful.
  }
  process.exit(1);
});
