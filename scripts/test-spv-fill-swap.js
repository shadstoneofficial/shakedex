#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { NodeClient, WalletClient } = require('hsd/lib/client');
const Network = require('hsd/lib/protocol/network.js');
const { Context, staticPassphraseGetter } = require('../src/context.js');
const {
  fillSwap,
  finalizeNameLock,
  finalizeSwap,
  proposeSwap,
  transferNameLock,
} = require('../src/swapService.js');

const network = Network.get('regtest');
const hsdPath = path.join(require.resolve('hsd'), '..', '..', 'bin', 'hsd');
const apiKey = 'test';
const passphrase = 'password';
const zeroAddr = 'rs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqn6kda';
const logLevel = process.env.SILENCE_HSD ? 'error' : 'debug';

const fullPorts = {
  node: 15037,
  wallet: 15039,
  p2p: 15038,
  ns: 15049,
  rs: 15050,
};

const spvPorts = {
  node: 15137,
  wallet: 15139,
  p2p: 15138,
  ns: 15149,
  rs: 15150,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeClientContext(walletId, ports) {
  const nodeClient = new NodeClient({
    port: ports.node,
    host: '127.0.0.1',
    apiKey,
  });
  const walletClient = new WalletClient({
    port: ports.wallet,
    host: '127.0.0.1',
    apiKey,
  });
  const context = new Context(
    'regtest',
    walletId,
    apiKey,
    staticPassphraseGetter(passphrase),
    '127.0.0.1',
  );
  context.nodeClient = nodeClient;
  context.walletClient = walletClient;
  context.wallet = walletClient.wallet(walletId);
  context.execNode = (method, ...args) => nodeClient.execute(method, args);
  context.execWallet = async (method, ...args) => {
    await walletClient.execute('selectwallet', [walletId]);
    return walletClient.execute(method, args);
  };
  return context;
}

function spawnHsd(label, args) {
  const child = spawn(hsdPath, args);
  child.stdout.on('data', (data) => {
    if (!process.env.SILENCE_HSD) {
      process.stdout.write(`[${label}] ${data}`);
    }
  });
  child.stderr.on('data', (data) => {
    if (!process.env.SILENCE_HSD) {
      process.stderr.write(`[${label} ERR] ${data}`);
    }
  });
  child.on('error', (err) => {
    console.error(`[${label} PROCESS ERROR] ${err.stack || err.message}`);
  });
  child.on('close', (code, signal) => {
    if (code !== 0 && code !== 143 && signal !== 'SIGTERM') {
      console.error(`[${label} CLOSED] code=${code} signal=${signal}`);
    }
  });
  return child;
}

async function waitForNode(client, label) {
  for (let i = 0; i < 20; i++) {
    try {
      await client.getInfo();
      console.log(`${label} RPC is ready.`);
      return;
    } catch (e) {
      if (i === 19) {
        throw new Error(`Timed out waiting for ${label}: ${e.message}`);
      }
      await sleep(500);
    }
  }
}

async function stop(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    child.once('close', resolve);
    child.kill('SIGTERM');
  });
}

async function createWallet(walletClient, id) {
  try {
    await walletClient.createWallet(id, { passphrase });
  } catch (e) {
    if (!/exists/i.test(e.message)) throw e;
  }
}

async function selectWallet(walletClient, id) {
  await walletClient.execute('selectwallet', [id]);
}

async function mine(nodeClient, blocks, address = zeroAddr) {
  await nodeClient.execute('generatetoaddress', [blocks, address]);
}

async function waitForHeight(nodeClient, height, label) {
  for (let i = 0; i < 60; i++) {
    const info = await nodeClient.execute('getblockchaininfo', []);
    if (info.blocks >= height) return info.blocks;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label} height ${height}`);
}

async function waitForConnections(nodeClient, label) {
  for (let i = 0; i < 30; i++) {
    const count = await nodeClient.execute('getconnectioncount', []);
    if (count > 0) {
      console.log(`${label} has ${count} peer connection(s).`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label} peer connection`);
}

async function main() {
  console.log(`Using hsd binary: ${hsdPath}`);
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'learnhns-spv-fill-'));
  console.log(`Using temp prefix: ${prefix}`);
  const fullPrefix = path.join(prefix, 'full');
  const spvPrefix = path.join(prefix, 'spv');

  let full;
  let spv;

  const fullNode = new NodeClient({ port: fullPorts.node, host: '127.0.0.1', apiKey });
  const fullWallet = new WalletClient({ port: fullPorts.wallet, host: '127.0.0.1', apiKey });
  const spvNode = new NodeClient({ port: spvPorts.node, host: '127.0.0.1', apiKey });
  const spvWallet = new WalletClient({ port: spvPorts.wallet, host: '127.0.0.1', apiKey });

  try {
    console.log('Starting full regtest HSD peer.');
    full = spawnHsd('FULL', [
      '--network=regtest',
      `--prefix=${fullPrefix}`,
      `--api-key=${apiKey}`,
      `--http-port=${fullPorts.node}`,
      `--wallet-http-port=${fullPorts.wallet}`,
      `--port=${fullPorts.p2p}`,
      `--ns-port=${fullPorts.ns}`,
      `--rs-port=${fullPorts.rs}`,
      '--listen',
      '--bip37',
      '--memory=true',
      '--index-tx',
      '--index-address',
      `--log-level=${logLevel}`,
    ]);
    await waitForNode(fullNode, 'full node');

    console.log('Starting SPV regtest HSD peer.');
    spv = spawnHsd('SPV', [
      '--network=regtest',
      '--spv',
      `--prefix=${spvPrefix}`,
      `--api-key=${apiKey}`,
      `--http-port=${spvPorts.node}`,
      `--wallet-http-port=${spvPorts.wallet}`,
      `--port=${spvPorts.p2p}`,
      `--ns-port=${spvPorts.ns}`,
      `--rs-port=${spvPorts.rs}`,
      `--only=127.0.0.1:${fullPorts.p2p}`,
      '--memory=true',
      `--log-level=${logLevel}`,
    ]);
    await waitForNode(spvNode, 'spv node');
    await spvNode.execute('addnode', [`127.0.0.1:${fullPorts.p2p}`, 'add']);
    await waitForConnections(spvNode, 'spv node');

    const sellerId = `seller-${Date.now()}`;
    const buyerId = `buyer-${Date.now()}`;

    console.log('Creating seller wallet on full node and buyer wallet on SPV node.');
    await createWallet(fullWallet, sellerId);
    await createWallet(spvWallet, buyerId);

    const sellerWallet = fullWallet.wallet(sellerId);
    const buyerWallet = spvWallet.wallet(buyerId);
    const sellerAddr = (await sellerWallet.createAddress('default')).address;
    const buyerFundAddr = (await buyerWallet.createAddress('default')).address;

    console.log('Mining funds to seller and SPV buyer.');
    await mine(fullNode, 20, sellerAddr);
    await mine(fullNode, 20, buyerFundAddr);
    await mine(fullNode, 10);
    await waitForHeight(spvNode, 50, 'spv sync');

    const seller = makeClientContext(sellerId, fullPorts);
    const buyer = makeClientContext(buyerId, spvPorts);

    const name = await fullNode.execute('grindname', [5]);
    console.log(`Registering fake name ${name} on full node.`);
    await selectWallet(fullWallet, sellerId);
    await fullWallet.execute('selectwallet', [sellerId]);
    await fullWallet.execute('sendopen', [name]);
    await mine(fullNode, 8);
    await fullWallet.execute('sendbid', [name, 1, 2]);
    await fullWallet.execute('sendbid', [name, 4, 8]);
    await fullWallet.execute('sendbid', [name, 8, 16]);
    await mine(fullNode, 10);
    await fullWallet.execute('sendreveal', [name]);
    await mine(fullNode, 10);
    await fullWallet.execute('sendupdate', [name, { records: [] }]);
    await mine(fullNode, 1);

    console.log('Creating seller proof on full node.');
    const transferLock = await transferNameLock(seller, name);
    await mine(fullNode, 10);
    const finalizeLock = await finalizeNameLock(seller, transferLock);
    await mine(fullNode, 10);
    const proof = await proposeSwap(seller, finalizeLock, 42 * 1e6);
    await waitForHeight(spvNode, 81, 'spv proof sync');

    console.log('Attempting Shakedex fill from SPV buyer.');
    const fill = await fillSwap(buyer, proof);
    console.log(`SPV fill broadcast succeeded: ${fill.fulfillmentTxHash}`);
    await mine(fullNode, 10);
    await waitForHeight(spvNode, 91, 'spv fulfillment sync');

    console.log('Attempting Shakedex finalize from SPV buyer.');
    const finalize = await finalizeSwap(buyer, fill);
    console.log(`SPV finalize broadcast succeeded: ${finalize.finalizeTxHash}`);

    console.log('\nResult: PASS. Shakedex fill/finalize works from SPV in this regtest setup.');
  } finally {
    console.log('Stopping test nodes.');
    await stop(spv);
    await stop(full);
  }
}

main().catch((err) => {
  console.error('\nResult: FAIL. SPV fill/finalize did not complete.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
