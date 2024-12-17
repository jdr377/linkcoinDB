const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// RPC Configuration
const rpcUser = 'YOURRPCUSERNAME';
const rpcPassword = 'YOURRPCPASSWORD';
const rpcPort = 7200;
const rpcHost = '127.0.0.1';

const MAX_BLOCK_HEIGHT = 387;

const db = new sqlite3.Database('blockchain.db');

async function initDB() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY,
        block_hash TEXT UNIQUE,
        timestamp INTEGER
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS transactions (
        txid TEXT PRIMARY KEY,
        block_height INTEGER,
        is_coinbase INTEGER
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS vins (
        txid TEXT,
        vin_index INTEGER,
        prev_txid TEXT,
        prev_vout INTEGER
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS vouts (
        txid TEXT,
        vout_index INTEGER,
        address TEXT,
        amount_sats INTEGER
      )`, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

async function rpcCall(method, params = []) {
  const data = {
    jsonrpc: '1.0',
    id: 'curltest',
    method: method,
    params: params
  };

  const auth = {
    username: rpcUser,
    password: rpcPassword
  };

  const url = `http://${rpcHost}:${rpcPort}`;
  const response = await axios.post(url, data, { auth: auth });
  return response.data.result;
}

// Insert block record
function insertBlock(height, blockHash, timestamp) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO blocks (height, block_hash, timestamp) VALUES (?, ?, ?)", [height, blockHash, timestamp], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Insert transaction record
function insertTransaction(txid, blockHeight, isCoinbase) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO transactions (txid, block_height, is_coinbase) VALUES (?, ?, ?)", [txid, blockHeight, isCoinbase ? 1 : 0], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Insert vin record
function insertVin(txid, vinIndex, prevTxid, prevVout) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO vins (txid, vin_index, prev_txid, prev_vout) VALUES (?, ?, ?, ?)", [txid, vinIndex, prevTxid, prevVout], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Insert vout record
function insertVout(txid, voutIndex, address, amountSats) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO vouts (txid, vout_index, address, amount_sats) VALUES (?, ?, ?, ?)", [txid, voutIndex, address, amountSats], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Extract addresses from vout
function getAddressesFromVout(vout) {
  const addrs = [];
  if (vout.scriptPubKey) {
    if (Array.isArray(vout.scriptPubKey.addresses)) {
      addrs.push(...vout.scriptPubKey.addresses);
    } else if (vout.scriptPubKey.address) {
      addrs.push(vout.scriptPubKey.address);
    }
  }
  return addrs;
}

async function processBlock(height) {
  const blockHash = await rpcCall('getblockhash', [height]);
  const block = await rpcCall('getblock', [blockHash, true]); // use boolean true for old client
  
  // Insert block record
  await insertBlock(height, blockHash, block.time);

  // block.tx is an array of txids
  for (const txid of block.tx) {
    let txData;
    try {
      txData = await rpcCall('getrawtransaction', [txid, 1]);
    } catch (err) {
      console.error(`Failed to get raw transaction for ${txid}: ${err.message}`);
      continue;
    }

    const isCoinbase = (txData.vin.length > 0 && txData.vin[0].coinbase !== undefined);
    await insertTransaction(txData.txid, height, isCoinbase);

    // Process vins
    // For coinbase, vin has no prev_txid, just skip or record them as special case with null prevTxid
    for (let i = 0; i < txData.vin.length; i++) {
      const vin = txData.vin[i];
      if (vin.txid !== undefined) {
        // Normal input
        await insertVin(txData.txid, i, vin.txid, vin.vout);
      } else {
        // Coinbase input (no prev tx)
        await insertVin(txData.txid, i, null, -1);
      }
    }

    // Process vouts
    for (let voutIndex = 0; voutIndex < txData.vout.length; voutIndex++) {
      const o = txData.vout[voutIndex];
      const addrs = getAddressesFromVout(o);
      const amountSats = Math.round(o.value * 1e8);
      if (addrs.length > 0) {
        // Usually one address per standard output
        for (const address of addrs) {
          await insertVout(txData.txid, voutIndex, address, amountSats);
        }
      } else {
        // No address (e.g., non-standard outputs)
        await insertVout(txData.txid, voutIndex, null, amountSats);
      }
    }
  }

  console.log(`Processed block ${height} (${blockHash})`);
}

(async () => {
  try {
    await initDB();
    const blockCount = await rpcCall('getblockcount');
    console.log("Current blockchain height:", blockCount);

    const heightToProcess = Math.min(blockCount, MAX_BLOCK_HEIGHT);
    console.log("Processing up to height:", heightToProcess);

    for (let height = 0; height <= heightToProcess; height++) {
      await processBlock(height);
    }

    console.log("Blockchain database built successfully up to height:", heightToProcess);
    db.close();

  } catch (e) {
    console.error("Error:", e);
    db.close();
  }
})();
