require('dotenv').config();
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL
});
async function main() {
  await client.connect();
  
  try {
    await client.query("ALTER TABLE buyer_requests ADD COLUMN auto_accept_mode text NOT NULL DEFAULT 'NONE'");
    console.log("auto_accept_mode added");
  } catch (e) {
    console.error("error auto:", e.message);
  }

  try {
    await client.query("ALTER TABLE buyer_requests ADD COLUMN counter_offer_rounds int NOT NULL DEFAULT 0");
    console.log("counter_offer_rounds added");
  } catch(e) {
    console.error("error counter:", e.message);
  }

  await client.end();
}
main();
