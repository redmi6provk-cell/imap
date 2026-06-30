const fs = require("fs");
const path = require("path");
const { ImapFlow } = require("imapflow");
const googleSheets = require("./google_sheets");

let db = null;
if (fs.existsSync(path.join(__dirname, "db_config.json"))) {
  try {
    db = require("./db");
  } catch (e) {
    console.warn("⚠️ Could not load database module in imap_search.js:", e.message);
  }
}

// Helper to decode quoted-printable encoding in emails
function decodeQuotedPrintable(str) {
  if (!str) return "";
  return str
    .replace(/=\r?\n/g, '') // Remove soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Extract order ID by checking subject first, then body (avoiding headers)
function extractOrderId(subject, rawEmailBody) {
  // 1. Try matching in the decoded subject first (cleanest and most specific)
  if (subject) {
    const match = subject.match(/\b\d{3}-\d{7}-\d{7}\b/);
    if (match) return match[0];
  }

  // 2. Fallback: search only within the body of the email, avoiding headers
  if (rawEmailBody) {
    let bodyOnly = rawEmailBody;
    const parts = rawEmailBody.split(/\r?\n\r?\n/);
    if (parts.length > 1) {
      bodyOnly = parts.slice(1).join("\n");
    }

    // Decode quoted-printable in the body to handle any soft wraps or hex encoding
    const decodedBody = decodeQuotedPrintable(bodyOnly);
    const match = decodedBody.match(/\b\d{3}-\d{7}-\d{7}\b/);
    if (match) return match[0];
  }

  return "UNKNOWN";
}

// Helper to normalize and get base email (ignoring Gmail plus-addressing aliases)
function getBaseEmail(email) {
  if (!email) return "";
  const parts = email.toLowerCase().trim().split('@');
  if (parts.length !== 2) return email.toLowerCase().trim();
  const local = parts[0].split('+')[0];
  return `${local}@${parts[1]}`;
}

// Extract recipient email addresses from headers/envelope
function getRecipientEmails(msg) {
  const recipients = [];
  
  // 1. Envelope TO
  const envelopeTo = msg.envelope?.to || [];
  for (const addr of envelopeTo) {
    if (addr.address) recipients.push(addr.address.toLowerCase().trim());
  }

  // 2. Envelope CC
  const envelopeCc = msg.envelope?.cc || [];
  for (const addr of envelopeCc) {
    if (addr.address) recipients.push(addr.address.toLowerCase().trim());
  }

  // 3. Headers (Scan for email addresses)
  if (msg.headers) {
    const headersStr = msg.headers.toString();
    const matches = headersStr.match(/[\w.+\-]+@[\w.\-]+\.[a-zA-Z]{2,}/g) || [];
    for (const email of matches) {
      recipients.push(email.toLowerCase().trim());
    }
  }

  // 4. Source (Scan top headers part of raw email source)
  if (msg.source) {
    const rawEmailStr = msg.source.toString();
    const headersEnd = rawEmailStr.indexOf("\r\n\r\n");
    const headers = headersEnd !== -1 ? rawEmailStr.substring(0, headersEnd) : rawEmailStr;
    const matches = headers.match(/[\w.+\-]+@[\w.\-]+\.[a-zA-Z]{2,}/g) || [];
    for (const email of matches) {
      recipients.push(email.toLowerCase().trim());
    }
  }

  return [...new Set(recipients)];
}

// Find which table the account is currently in
async function findAccountTable(email, userId) {
  const tables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
  for (const tbl of tables) {
    const res = await db.pool.query(
      `SELECT 1 FROM ${tbl} WHERE user_id = $1 AND email = $2 LIMIT 1`,
      [userId, email]
    );
    if (res.rows.length > 0) return tbl;
  }
  return null;
}

// Process a single user's IMAP mailbox
async function processUserImap(userId, imapConfig) {
  if (!imapConfig || !imapConfig.host || !imapConfig.user || !imapConfig.password) {
    console.log(`⚠️ User ${userId} missing complete IMAP configuration. Skipping.`);
    return;
  }

  console.log(`\n📬 Connecting to IMAP for user ID ${userId} (${imapConfig.user})...`);
  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port || 993,
    secure: imapConfig.secure !== undefined ? imapConfig.secure : true,
    auth: {
      user: imapConfig.user,
      pass: imapConfig.password
    },
    logger: false
  });

  try {
    await client.connect();
    let lock = await client.getMailboxLock("INBOX");
    try {
      if (client.mailbox.exists === 0) {
        console.log(` Inbox is empty.`);
        return;
      }

      // Search for emails received today
      const todayDate = new Date();
      todayDate.setHours(0, 0, 0, 0); // Start of today (local time)
      
      console.log(` Searching for emails received today...`);
      const searchResult = await client.search({ since: todayDate });
      console.log(` Found ${searchResult.length} email(s) received today in INBOX.`);

      if (searchResult.length === 0) {
        console.log(" Done processing user. No emails today.");
        return;
      }

      // Step 1: Fetch ONLY envelopes first (very fast!)
      console.log(" Fetching envelopes...");
      const envelopes = [];
      for await (let msg of client.fetch(searchResult, { envelope: true })) {
        envelopes.push(msg);
      }

      // Step 2: Filter for emails that are from Amazon and received today
      const targetSeqNums = [];
      for (const msg of envelopes) {
        const from = msg.envelope?.from?.[0]?.address || "";
        const subject = msg.envelope?.subject || "";
        const isAmazon = from.toLowerCase().includes("amazon.in") || 
                         from.toLowerCase().includes("amazon.com") || 
                         subject.toLowerCase().includes("amazon");

        if (isAmazon) {
          targetSeqNums.push(msg.seq);
        }
      }

      console.log(` Found ${targetSeqNums.length} Amazon email(s) today. Fetching full content...`);

      if (targetSeqNums.length === 0) {
        console.log(" Done processing user. No Amazon emails today.");
        return;
      }

      // Step 3: Fetch full body source ONLY for these target Amazon emails
      const messages = [];
      for await (let msg of client.fetch(targetSeqNums, { envelope: true, headers: true, source: true })) {
        messages.push(msg);
      }

      // Sort with newest emails first
      messages.sort((a, b) => b.seq - a.seq);

      // Fetch all database accounts under this user to match recipients
      const tables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
      const dbAccountsList = [];
      for (const tbl of tables) {
        const res = await db.pool.query(`SELECT email FROM ${tbl} WHERE user_id = $1`, [userId]);
        for (const row of res.rows) {
          dbAccountsList.push({ email: row.email, table: tbl });
        }
      }

      let countProcessed = 0;

      for (const msg of messages) {
        const from = msg.envelope?.from?.[0]?.address || "";
        const subject = msg.envelope?.subject || "";
        
        // 1. Check if email is from Amazon
        const isAmazon = from.toLowerCase().includes("amazon.in") || 
                         from.toLowerCase().includes("amazon.com") || 
                         subject.toLowerCase().includes("amazon");
        if (!isAmazon) continue;

        // 2. Identify the target account email among email recipients
        const recipients = getRecipientEmails(msg);
        let matchedDbAccount = null;
        for (const recEmail of recipients) {
          const matched = dbAccountsList.find(acc => acc.email.toLowerCase().trim() === recEmail.toLowerCase().trim());
          if (matched) {
            matchedDbAccount = matched;
            break;
          }
        }

        if (!matchedDbAccount) continue;

        // 3. Inspect body source for cancellation reasons
        const rawEmailBody = msg.source ? msg.source.toString() : "";
        
        let cancellationType = null;
        let matchedReasonText = "";

        // Reason i: Past Order activity
        if (/past\s+order\s+activity/i.test(rawEmailBody) || /actions\s+on\s+Amazon\.in/i.test(rawEmailBody)) {
          cancellationType = "past_order";
          matchedReasonText = "Based on your past order activity and other actions on Amazon.in";
        }
        // Reason ii: Purchase Limit
        else if (/reached\s+the\s+purchase\s+limit/i.test(rawEmailBody) || /purchase\s+limit\s+for\s+this\s+product/i.test(rawEmailBody)) {
          cancellationType = "purchase_limit";
          matchedReasonText = "We cannot complete this order because our records show that you have reached the purchase limit for this product.";
        }
        // Reason iii: Delivery issue
        else if (/issue\s+with\s+your\s+delivery/i.test(rawEmailBody)) {
          cancellationType = "delivery_issue";
          matchedReasonText = "Cancelled We are sorry there was an issue with your delivery.";
        }

        let isDelivered = false;
        // Check for delivered status in subject or body
        if (/delivered/i.test(subject) || /has\s+been\s+delivered/i.test(rawEmailBody) || /delivered\s+to\s+your\s+address/i.test(rawEmailBody) || /delivered\s+on/i.test(rawEmailBody)) {
          if (!cancellationType) {
            isDelivered = true;
          }
        }

        if (cancellationType) {
          // Extract order ID using helper function
          const orderId = extractOrderId(subject, rawEmailBody);

          console.log(` 🔍 Found Cancellation Email for ${matchedDbAccount.email}:`);
          console.log(`   Order ID: ${orderId}`);
          console.log(`   Reason: ${matchedReasonText}`);

          // Update the order status to CANCELLED in the Google Sheet instead of deleting it
          await googleSheets.updateOrderStatus(matchedDbAccount.email, orderId, 'CANCELLED', matchedReasonText);

          const currentTable = await findAccountTable(matchedDbAccount.email, userId);
          if (currentTable) {
            if (currentTable === cancellationType) {
              // Already in correct table, update metadata if needed
              await db.pool.query(
                `UPDATE ${cancellationType} SET order_id = $1, reason_text = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND email = $4`,
                [orderId, matchedReasonText, userId, matchedDbAccount.email]
              );
              console.log(`   ℹ️ Account already in ${cancellationType} table, updated metadata.`);
            } else {
              // Move to new table preserving cookies
              await db.moveAccount(matchedDbAccount.email, userId, currentTable, cancellationType, {
                order_id: orderId,
                reason_text: matchedReasonText
              });
              console.log(`   ✅ Successfully moved account from ${currentTable} to ${cancellationType}.`);
            }
            countProcessed++;
          }
        } else if (isDelivered) {
          const orderId = extractOrderId(subject, rawEmailBody);
          if (orderId && orderId !== 'UNKNOWN') {
            console.log(` 🔍 Found Delivery Confirmation Email for ${matchedDbAccount.email}:`);
            console.log(`   Order ID: ${orderId}`);
            
            // Update Google Sheets to 'DELIVERED'
            await googleSheets.updateOrderStatus(matchedDbAccount.email, orderId, 'DELIVERED', 'Your package has been delivered.');
            countProcessed++;
          }
        }
      }

      console.log(` Done processing user ${userId}. Processed ${countProcessed} cancellation(s).`);

    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(` ❌ IMAP error for user ID ${userId}:`, err.message);
  } finally {
    await client.logout();
  }
}

// Main execution function
async function main() {
  if (!db) {
    console.error("❌ Database module not loaded. Cannot run search.");
    process.exit(1);
  }

  // Parse arguments
  const args = process.argv.slice(2);
  let targetUserId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user-id") {
      targetUserId = parseInt(args[++i], 10) || null;
    }
  }

  try {
    await db.initDB();

    if (targetUserId) {
      const user = await db.getUser(targetUserId);
      if (user) {
        await processUserImap(user.id, user.imapConfig);
      } else {
        console.error(`❌ User ID ${targetUserId} not found in database.`);
      }
    } else {
      // Process all users in database
      const users = await db.getAllUsers();
      if (users.length === 0) {
        console.log("ℹ️ No users found in database.");
      }
      for (const u of users) {
        const userDetails = await db.getUser(u.id);
        if (userDetails && userDetails.imapConfig && userDetails.imapConfig.host) {
          await processUserImap(userDetails.id, userDetails.imapConfig);
        }
      }
    }

  } catch (err) {
    console.error("❌ Main execution failed:", err.message);
    // Do NOT call pool.end() here — pool stays alive for next loop run
  }
}

// ==================== POLLING LOOP ====================
// Interval in milliseconds (default: 30 minutes)
const POLL_INTERVAL_MS = parseInt(process.env.IMAP_POLL_INTERVAL_MS || "") || 30 * 60 * 1000;

async function runLoop() {
  console.log("🚀 IMAP Scanner started (PM2 mode)");
  console.log(`🔁 Will scan every ${POLL_INTERVAL_MS / 60000} minute(s)`);

  // Run immediately on start
  await main();

  // Then repeat on interval
  setInterval(async () => {
    console.log(`\n⏰ [${new Date().toISOString()}] Starting scheduled IMAP scan...`);
    await main();
  }, POLL_INTERVAL_MS);
}

// Run script if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--loop") || process.env.IMAP_LOOP === "true") {
    // LOOP MODE: pool stays open forever, no pool.end()
    runLoop();
  } else {
    // SINGLE RUN MODE: close pool after done
    main().finally(() => {
      db && db.pool.end().catch(() => {});
    });
  }
}
