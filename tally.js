const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('utxos.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }
});

db.all("SELECT address, balance FROM utxos ORDER BY balance DESC", (err, rows) => {
  if (err) {
    console.error('Error querying addresses:', err);
    db.close();
    process.exit(1);
  }

  // Print header
  console.log("address,balance_sats,balance_coins");

  // For each address, print the balance in satoshis and in coins
  for (const row of rows) {
    const coins = (row.balance / 1e8).toFixed(8);
    console.log(`${row.address},${row.balance},${coins}`);
  }

  db.close();
});
