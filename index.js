const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// RPC Configuration
const rpcUser = 'YOURRPCUSERNAME';
const rpcPassword = 'YOURRPCPASSWORD';
const rpcPort = 7200;
const rpcHost = '127.0.0.1';

const MAX_BLOCK_HEIGHT = 387; // limit to block 387

// SQLite DB initialization
const db = new sqlite3.Database('utxos.db');

function initDB() {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS utxos (
        address TEXT PRIMARY KEY,
        balance INTEGER NOT NULL
      )
    `, (err) => {
      if (err) return reject(err);
      resolve();
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

function updateBalance(address, amountBtc) {
  return new Promise((resolve, reject) => {
    const sats = Math.round(amountBtc * 1e8);
    db.get("SELECT balance FROM utxos WHERE address = ?", [address], (err, row) => {
      if (err) return reject(err);

      if (row) {
        const newBalance = row.balance + sats;
        if (newBalance === 0) {
          db.run("DELETE FROM utxos WHERE address = ?", [address], (err2) => {
            if (err2) return reject(err2);
            resolve();
          });
        } else {
          db.run("UPDATE utxos SET balance = ? WHERE address = ?", [newBalance, address], (err2) => {
            if (err2) return reject(err2);
            resolve();
          });
        }
      } else {
        if (sats > 0) {
          db.run("INSERT INTO utxos (address, balance) VALUES (?, ?)", [address, sats], (err2) => {
            if (err2) return reject(err2);
            resolve();
          });
        } else {
          // Negative or zero for non-existent address, do nothing
          resolve();
        }
      }
    });
  });
}

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

const utxoMap = new Map(); // key: "txid:vout", value: {address, sats}

async function processBlock(blockHash) {
  // Use boolean `true` for getblock as tested
  const block = await rpcCall('getblock', [blockHash, true]);
  const txids = block.tx;

  for (const txid of txids) {
    let tx;
    try {
      // Using 1 instead of true for verbosity in getrawtransaction
      tx = await rpcCall('getrawtransaction', [txid, 1]);
    } catch (err) {
      console.error(`Failed to get raw transaction for ${txid}: ${err.message}`);
      // If this is the genesis coinbase (likely), just skip it.
      continue;
    }

    const isCoinbase = (tx.vin.length > 0 && tx.vin[0].coinbase !== undefined);

    if (isCoinbase) {
      // Coinbase: add outputs
      for (let voutIndex = 0; voutIndex < tx.vout.length; voutIndex++) {
        const o = tx.vout[voutIndex];
        const addrs = getAddressesFromVout(o);
        const amount = o.value;
        for (const address of addrs) {
          await updateBalance(address, amount);
        }
        if (addrs.length > 0) {
          utxoMap.set(`${tx.txid}:${voutIndex}`, { address: addrs[0], sats: Math.round(amount * 1e8) });
        }
      }
    } else {
      // Normal transaction
      let inputUtxos = [];
      for (const vin of tx.vin) {
        if (vin.txid !== undefined) {
          const key = `${vin.txid}:${vin.vout}`;
          const utxo = utxoMap.get(key);
          if (utxo) {
            inputUtxos.push(utxo);
            utxoMap.delete(key);
          } else {
            // If we don't find it in our map, it might be from before our start or not standard.
            // Normally, starting from genesis ensures all UTXOs are tracked.
          }
        }
      }

      // Deduct spent amounts
      for (const spent of inputUtxos) {
        await updateBalance(spent.address, -spent.sats / 1e8);
      }

      // Add outputs
      for (let voutIndex = 0; voutIndex < tx.vout.length; voutIndex++) {
        const o = tx.vout[voutIndex];
        const addrs = getAddressesFromVout(o);
        const amount = o.value;
        for (const address of addrs) {
          await updateBalance(address, amount);
        }
        if (addrs.length > 0) {
          utxoMap.set(`${tx.txid}:${voutIndex}`, { address: addrs[0], sats: Math.round(amount * 1e8) });
        }
      }
    }
  }
}

(async () => {
  try {
    await initDB();

    const blockCount = await rpcCall('getblockcount');
    console.log("Current blockchain height:", blockCount);

    const heightToProcess = Math.min(blockCount, MAX_BLOCK_HEIGHT);
    console.log("Processing up to height:", heightToProcess);

    for (let height = 0; height <= heightToProcess; height++) {
      console.log(`Processing block at height: ${height}`);
      const blockHash = await rpcCall('getblockhash', [height]);
      await processBlock(blockHash);
    }

    console.log("UTXO set built successfully up to height:", heightToProcess);

  } catch (e) {
    console.error("Error:", e);
    db.close();
  }
})();
