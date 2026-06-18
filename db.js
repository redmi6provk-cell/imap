const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'db_config.json');

// Try loading db configuration from db_config.json if it exists
let dbConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'amazoneauto',
  password: 'your_password_here',
  port: 5432,
};

if (fs.existsSync(configPath)) {
  try {
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    dbConfig = { ...dbConfig, ...configData };
  } catch(e) {
    console.warn("Failed to parse db_config.json, using defaults.");
  }
} else {
  // Create default db_config.json for the user
  fs.writeFileSync(configPath, JSON.stringify(dbConfig, null, 2), 'utf8');
}

const pool = new Pool(dbConfig);

// Handle unexpected errors on idle clients to prevent process crashes (like ECONNRESET)
pool.on('error', (err, client) => {
  console.error('⚠️ Unexpected database pool error:', err.message);
});

// ==================== INIT ====================
async function initDB() {
  const maxRetries = 5;
  let attempt = 0;
  let client;

  while (attempt < maxRetries) {
    try {
      client = await pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          imap_host VARCHAR(255),
          imap_port INTEGER DEFAULT 993,
          imap_secure BOOLEAN DEFAULT true,
          imap_user VARCHAR(255),
          imap_password VARCHAR(255),
          amazon_password VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS amazon_password VARCHAR(255);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          cookies JSONB,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, email)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS no_cod_accounts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          cookies JSONB,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, email)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS success_accounts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          cookies JSONB,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, email)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS past_order (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          cookies JSONB,
          order_id VARCHAR(100),
          reason_text TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, email)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS delivery_issue (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          cookies JSONB,
          order_id VARCHAR(100),
          reason_text TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, email)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS purchase_limit (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          cookies JSONB,
          order_id VARCHAR(100),
          reason_text TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, email)
        );
      `);
      console.log("✅ Database tables initialized successfully.");
      return;
    } catch (e) {
      attempt++;
      console.warn(`⚠️ Database connection attempt ${attempt}/${maxRetries} failed: ${e.message}`);
      if (attempt >= maxRetries) {
        console.error("❌ Failed to initialize database after maximum retries.");
        throw e;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally {
      if (client) {
        client.release();
      }
    }
  }
}

// ==================== USER FUNCTIONS ====================

// Add a new user with IMAP config and optional Amazon password
async function addUser(email, imapConfig = {}, amazonPassword = null) {
  const result = await pool.query(
    `INSERT INTO users (email, imap_host, imap_port, imap_secure, imap_user, imap_password, amazon_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (email) DO UPDATE SET
       imap_host = COALESCE($2, users.imap_host),
       imap_port = COALESCE($3, users.imap_port),
       imap_secure = COALESCE($4, users.imap_secure),
       imap_user = COALESCE($5, users.imap_user),
       imap_password = COALESCE($6, users.imap_password),
       amazon_password = COALESCE($7, users.amazon_password)
     RETURNING id`,
    [
      email,
      imapConfig.host || null,
      imapConfig.port || 993,
      imapConfig.secure !== undefined ? imapConfig.secure : true,
      imapConfig.user || email,
      imapConfig.password || null,
      amazonPassword
    ]
  );
  return result.rows[0].id;
}

// Get user by ID (with IMAP config)
async function getUser(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (result.rows.length > 0) {
    const user = result.rows[0];
    return {
      id: user.id,
      email: user.email,
      imapConfig: {
        host: user.imap_host,
        port: user.imap_port,
        secure: user.imap_secure,
        user: user.imap_user,
        password: user.imap_password
      },
      amazonPassword: user.amazon_password,
      created_at: user.created_at
    };
  }
  return null;
}

// Get user by email
async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (result.rows.length > 0) {
    const user = result.rows[0];
    return {
      id: user.id,
      email: user.email,
      imapConfig: {
        host: user.imap_host,
        port: user.imap_port,
        secure: user.imap_secure,
        user: user.imap_user,
        password: user.imap_password
      },
      amazonPassword: user.amazon_password,
      created_at: user.created_at
    };
  }
  return null;
}

// Get user by email or account email (resolves parent user)
async function getUserByEmailOrAccountEmail(email) {
  // Try direct user lookup first
  const userDirect = await getUserByEmail(email);
  if (userDirect) return userDirect;

  // Fallback: lookup as an account to find the parent user record
  const result = await pool.query(
    `SELECT u.* 
     FROM users u
     JOIN accounts a ON a.user_id = u.id
     WHERE a.email = $1
     LIMIT 1`,
    [email]
  );
  if (result.rows.length > 0) {
    const user = result.rows[0];
    return {
      id: user.id,
      email: user.email,
      imapConfig: {
        host: user.imap_host,
        port: user.imap_port,
        secure: user.imap_secure,
        user: user.imap_user,
        password: user.imap_password
      },
      amazonPassword: user.amazon_password,
      created_at: user.created_at
    };
  }
  return null;
}

// Get all users
async function getAllUsers() {
  const result = await pool.query('SELECT id, email, imap_host FROM users ORDER BY id');
  return result.rows;
}

// ==================== ACCOUNT FUNCTIONS ====================

// Add Amazon account under a user
async function addAccount(userId, email) {
  await pool.query(
    'INSERT INTO accounts (user_id, email) VALUES ($1, $2) ON CONFLICT (user_id, email) DO NOTHING',
    [userId, email]
  );
}

// Remove account from all tables
async function removeAccount(userId, email) {
  const tables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
  for (const tbl of tables) {
    await pool.query(`DELETE FROM ${tbl} WHERE user_id = $1 AND email = $2`, [tbl, userId, email].slice(1));
  }
}

// Get all accounts for a user
async function getAccountsByUser(userId) {
  const result = await pool.query('SELECT email FROM accounts WHERE user_id = $1 ORDER BY id ASC', [userId]);
  return result.rows.map(r => r.email);
}

// Get all accounts (with user info)
async function getAllAccounts() {
  const result = await pool.query(`
    SELECT a.id, a.user_id, a.email, u.email as user_email
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    ORDER BY a.user_id, a.id
  `);
  return result.rows;
}

// Get cookies for an account (scans all 6 tables)
async function getCookies(userId, email) {
  const tables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
  for (const tbl of tables) {
    const result = await pool.query(
      `SELECT cookies FROM ${tbl} WHERE user_id = $1 AND email = $2`,
      [userId, email]
    );
    if (result.rows.length > 0 && result.rows[0].cookies) {
      return result.rows[0].cookies;
    }
  }
  return [];
}

// Save/update cookies for an account (updates the table where the account currently resides)
async function updateCookies(userId, email, cookies) {
  const tables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
  let currentTable = null;
  for (const tbl of tables) {
    const res = await pool.query(
      `SELECT 1 FROM ${tbl} WHERE user_id = $1 AND email = $2 LIMIT 1`,
      [userId, email]
    );
    if (res.rows.length > 0) {
      currentTable = tbl;
      break;
    }
  }

  const targetTable = currentTable || 'accounts';
  await pool.query(
    `INSERT INTO ${targetTable} (user_id, email, cookies, updated_at) 
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, email) 
     DO UPDATE SET cookies = $3, updated_at = CURRENT_TIMESTAMP`,
    [userId, email, JSON.stringify(cookies)]
  );
}

// Generic function to move an account between tables, preserving cookies
async function moveAccount(email, userId, fromTable, toTable, extraData = {}) {
  const allowedTables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
  if (!allowedTables.includes(fromTable) || !allowedTables.includes(toTable)) {
    throw new Error(`Invalid table names: ${fromTable} -> ${toTable}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve user_id from source table if not provided
    let resolvedUserId = userId;
    if (!resolvedUserId) {
      const userRes = await client.query(`SELECT user_id FROM ${fromTable} WHERE email = $1 LIMIT 1`, [email]);
      if (userRes.rows.length > 0) {
        resolvedUserId = userRes.rows[0].user_id;
      }
    }

    if (!resolvedUserId) {
      // Check other tables
      for (const tbl of allowedTables) {
        if (tbl === fromTable) continue;
        const userRes = await client.query(`SELECT user_id FROM ${tbl} WHERE email = $1 LIMIT 1`, [email]);
        if (userRes.rows.length > 0) {
          resolvedUserId = userRes.rows[0].user_id;
          break;
        }
      }
    }

    if (resolvedUserId) {
      // 2. Get cookies & updated_at from fromTable
      const accRes = await client.query(
        `SELECT cookies, updated_at FROM ${fromTable} WHERE user_id = $1 AND email = $2`,
        [resolvedUserId, email]
      );

      let cookies = null;
      let updatedAt = new Date();
      if (accRes.rows.length > 0) {
        cookies = accRes.rows[0].cookies;
        updatedAt = accRes.rows[0].updated_at || updatedAt;
      }

      // If cookies weren't found in fromTable, try searching other tables before moving
      if (!cookies) {
        for (const tbl of allowedTables) {
          if (tbl === fromTable) continue;
          const searchRes = await client.query(
            `SELECT cookies, updated_at FROM ${tbl} WHERE user_id = $1 AND email = $2`,
            [resolvedUserId, email]
          );
          if (searchRes.rows.length > 0 && searchRes.rows[0].cookies) {
            cookies = searchRes.rows[0].cookies;
            updatedAt = searchRes.rows[0].updated_at || updatedAt;
            break;
          }
        }
      }

      // 3. Prepare extra columns if destination supports them
      const orderId = extraData.order_id || null;
      const reasonText = extraData.reason_text || null;

      // 4. Insert into target table
      if (['past_order', 'delivery_issue', 'purchase_limit'].includes(toTable)) {
        await client.query(
          `INSERT INTO ${toTable} (user_id, email, cookies, order_id, reason_text, updated_at, added_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, email) DO UPDATE SET
             cookies = COALESCE($3, ${toTable}.cookies),
             order_id = COALESCE($4, ${toTable}.order_id),
             reason_text = COALESCE($5, ${toTable}.reason_text),
             updated_at = COALESCE($6, ${toTable}.updated_at),
             added_at = CURRENT_TIMESTAMP`,
          [resolvedUserId, email, cookies ? JSON.stringify(cookies) : null, orderId, reasonText, updatedAt]
        );
      } else {
        // accounts, success_accounts, no_cod_accounts
        const hasAddedAt = (toTable !== 'accounts');
        const query = hasAddedAt
          ? `INSERT INTO ${toTable} (user_id, email, cookies, updated_at, added_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, email) DO UPDATE SET
               cookies = COALESCE($3, ${toTable}.cookies),
               updated_at = COALESCE($4, ${toTable}.updated_at),
               added_at = CURRENT_TIMESTAMP`
          : `INSERT INTO ${toTable} (user_id, email, cookies, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, email) DO UPDATE SET
               cookies = COALESCE($3, ${toTable}.cookies),
               updated_at = COALESCE($4, ${toTable}.updated_at)`;

        await client.query(query, [resolvedUserId, email, cookies ? JSON.stringify(cookies) : null, updatedAt]);
      }

      // 5. Delete from source table
      await client.query(`DELETE FROM ${fromTable} WHERE user_id = $1 AND email = $2`, [resolvedUserId, email]);
      console.log(`✅ Moved ${email} from ${fromTable} to ${toTable}`);
    } else {
      console.warn(`⚠️ Could not resolve user_id for email ${email}. Skipping move.`);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Move Amazon account to NO COD table (re-implemented to use moveAccount)
async function moveAccountToNoCod(email, userId = null) {
  await moveAccount(email, userId, 'accounts', 'no_cod_accounts');
}

// Get all accounts from a specific table
async function getAccountsFromTable(userId, tableName) {
  const allowedTables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
  if (!allowedTables.includes(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  const hasAddedAt = (tableName !== 'accounts');
  const orderBy = hasAddedAt ? 'added_at DESC' : 'id ASC';

  const query = `SELECT * FROM ${tableName} WHERE user_id = $1 ORDER BY ${orderBy}`;
  const result = await pool.query(query, [userId]);
  return result.rows;
}

// Get all no-cod accounts for a user
async function getNoCodAccounts(userId) {
  return getAccountsFromTable(userId, 'no_cod_accounts');
}

module.exports = {
  pool,
  initDB,
  addUser,
  getUser,
  getUserByEmail,
  getUserByEmailOrAccountEmail,
  getAllUsers,
  addAccount,
  removeAccount,
  getAccountsByUser,
  getAllAccounts,
  getCookies,
  updateCookies,
  moveAccount,
  moveAccountToNoCod,
  getAccountsFromTable,
  getNoCodAccounts
};
