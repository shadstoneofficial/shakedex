const { NodeClient, WalletClient } = require('hsd/lib/client');
const Network = require('hsd/lib/protocol/network.js');
const passwordPrompt = require('password-prompt');
const fetch = require('node-fetch');

class Context {
  constructor(
    networkName,
    walletId,
    apiKey,
    passphraseGetter = noopPassphraseGetter,
    host = '127.0.0.1',
    nodeApiKey,
    chainDataHost,
  ) {
    this.networkName = networkName;
    this.network = Network.get(networkName);
    this.walletId = walletId;
    this.nodeClient = new NodeClient({
      port: this.network.rpcPort,
      host,
      apiKey: nodeApiKey || apiKey,
    });
    this.walletClient = new WalletClient({
      port: this.network.walletPort,
      host,
      apiKey: apiKey,
    });
    this.wallet = this.walletClient.wallet(walletId);
    this.passphraseGetter = passphraseGetter;
    this.chainDataHost = chainDataHost ? chainDataHost.replace(/\/+$/, '') : null;
    this.installChainDataFallbacks();
  }

  installChainDataFallbacks() {
    if (!this.chainDataHost) {
      return;
    }

    const getTX = this.nodeClient.getTX.bind(this.nodeClient);
    this.nodeClient.getTX = async (hash) => {
      try {
        return await getTX(hash);
      } catch (err) {
        if (!isSPVDataError(err)) {
          throw err;
        }

        const body = await this.fetchChainData(`/api/v2/tx/${hash}/status`);
        return body.tx;
      }
    };

    const getCoin = this.nodeClient.getCoin.bind(this.nodeClient);
    this.nodeClient.getCoin = async (hash, index) => {
      try {
        return await getCoin(hash, index);
      } catch (err) {
        if (!isSPVDataError(err)) {
          throw err;
        }

        const body = await this.fetchChainData(`/api/v2/coin/${hash}/${index}`);
        return body.coin;
      }
    };
  }

  async fetchChainData(path) {
    const res = await fetch(`${this.chainDataHost}${path}`);
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = {error: text};
    }

    if (!res.ok) {
      throw new Error(body.error || `Chain data request failed with ${res.status}`);
    }

    return body;
  }

  getPassphrase = () => {
    return this.passphraseGetter();
  };

  execNode = (method, ...args) => {
    return this.nodeClient.execute(method, args);
  };

  execWallet = async (method, ...args) => {
    await this.walletClient.execute('selectwallet', [this.walletId]);
    return this.walletClient.execute(method, args);
  };

  unlockWallet = async () => {
    const pass = await this.getPassphrase();
    if (pass === null) {
      return;
    }
    await this.wallet.unlock(pass, 60);
  };

  getMTP = async () => {
    const info = await this.execNode('getblockchaininfo');
    return info.mediantime;
  };

  getHeight = async () => {
    const info = await this.execNode('getblockchaininfo');
    return info.blocks;
  };
}

exports.Context = Context;

exports.staticPassphraseGetter = function (passphrase) {
  return () => new Promise((resolve) => resolve(passphrase));
};

function noopPassphraseGetter() {
  return new Promise((resolve) => resolve(null));
}

function isSPVDataError(err) {
  return err && /SPV mode|Cannot get TX|Cannot get coin/i.test(err.message || '');
}

exports.promptPassphraseGetter = function (
  prefix = '>> Please enter your passphrase: '
) {
  return () => new Promise((resolve) => resolve(passwordPrompt(prefix)));
};
