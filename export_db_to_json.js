const fs = require('fs');
const path = require('path');
const db = require('./db');

const exportDir = path.join(__dirname, 'db_export');

const tables = [
  'users',
  'accounts',
  'success_accounts',
  'no_cod_accounts',
  'past_order',
  'delivery_issue',
  'purchase_limit'
];

async function exportDatabase() {
  console.log('🚀 Starting database export to JSON...');
  
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir);
  }

  try {
    for (const tbl of tables) {
      console.log(`📋 Exporting table "${tbl}"...`);
      const res = await db.pool.query(`SELECT * FROM ${tbl}`);
      const rows = res.rows;
      
      const filePath = path.join(exportDir, `${tbl}.json`);
      fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
      console.log(`  -> Saved ${rows.length} rows to ${filePath}`);
    }
    console.log('\n🎉 Export complete! You can now commit and push this to Git.');
  } catch (err) {
    console.error('❌ Error during export:', err.message);
  } finally {
    await db.pool.end();
  }
}

exportDatabase();
