#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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
Create a fixed-price Shakedex proof on a fake local regtest chain.

Usage:
  node scripts/create-regtest-fixed-proof.js --price 42 --out /tmp/learnhns-fixed-proof.json

Options:
  --price <hns>   Fixed buy-now price in HNS. Default: 42
  --out <path>    Output proof JSON path. Default: /tmp/learnhns-fixed-proof.json
  --help          Show this help text.
`);
}

async function main() {
  if (hasArg('--help') || hasArg('-h')) {
    usage();
    return;
  }

  const priceHNS = Number(argValue('--price', '42'));
  if (Number.isNaN(priceHNS) || priceHNS <= 0) {
    throw new Error('--price must be a positive number of HNS.');
  }

  const outPath = path.resolve(
    argValue('--out', '/tmp/learnhns-fixed-proof.json')
  );

  console.log('Starting fake local regtest chain.');
  await startRegtest();

  try {
    console.log('Creating fake wallets, mining fake HNS, and registering a fake name.');
    const {alice, name, finalizeLock} = await setupSwap();
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
    console.log('Created fixed-price regtest proof:');
    console.log(outPath);
    console.log('');
    console.log(`Name: ${name}`);
    console.log(`Price: ${priceHNS} HNS`);
    console.log('');
    console.log('This proof is regtest-only. Do not use it with production Bob Wallet.');
  } finally {
    console.log('Stopping fake local regtest chain.');
    await stopRegtest();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
