const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(__dirname, 'google_credentials.json');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

// Get Spreadsheet ID from settings.json
let spreadsheetId = null;
if (fs.existsSync(SETTINGS_PATH)) {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    spreadsheetId = settings.googleSpreadsheetId || null;
  } catch (e) {
    console.warn("⚠️ Failed to parse settings.json in google_sheets.js:", e.message);
  }
}

// Function to initialize sheets client
function getSheetsClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.warn("⚠️ Google Sheets: google_credentials.json not found in root. Sheets logging is disabled.");
    return null;
  }
  if (!spreadsheetId) {
    console.warn("⚠️ Google Sheets: googleSpreadsheetId not set in settings.json. Sheets logging is disabled.");
    return null;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (e) {
    console.error("❌ Failed to initialize Google Sheets client:", e.message);
    return null;
  }
}

// ── Retry helper: handles Google Sheets rate limits (429) from multiple PCs ──
async function withRetry(fn, maxRetries = 5) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isRateLimit = e?.code === 429 || e?.status === 429 ||
                          (e?.message && (e.message.includes('429') || e.message.includes('Quota') || e.message.includes('rate')));
      const isServerErr = e?.code === 503 || e?.status === 503;
      if ((isRateLimit || isServerErr) && attempt < maxRetries) {
        console.warn(`⚠️ Google Sheets rate limit hit. Retrying in ${delay/1000}s... (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000); // exponential backoff, max 30s
      } else {
        throw e;
      }
    }
  }
}

// Helper to get Sheet ID dynamically by name (defaults to 'Sheet1')
async function getSheetId(sheets, sheetName = 'Sheet1') {
  try {
    const metadata = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = metadata.data.sheets.find(s => s.properties.title === sheetName);
    return sheet ? sheet.properties.sheetId : 0;
  } catch (e) {
    return 0;
  }
}

// Local cache for sheet rows and headers check to prevent hitting Google API quotas
let cachedRows = null;
let lastFetchTime = 0;
let headersEnsured = false;

// Helper to get all values of Sheet1 with caching
async function getSheetValues(sheets, forceRefresh = false) {
  const now = Date.now();
  // Cache the sheet rows for 10 seconds to avoid hitting API rate limits in tight loops
  if (cachedRows && (now - lastFetchTime < 10000) && !forceRefresh) {
    return cachedRows;
  }
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sheet1!A:I', // A=Timestamp, B=Email, C=Status, D=Order ID, E=Total Amount, F=Product ASIN/Qty, G=Reason, H=IP, I=Name
  });
  cachedRows = response.data.values || [];
  lastFetchTime = now;
  return cachedRows;
}

// Helper to ensure headers exist on the sheet
async function ensureHeaders(sheets) {
  if (headersEnsured) return;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A1:I1',
    });
    const headerRow = response.data.values || [];
    if (headerRow.length === 0 || !headerRow[0] || headerRow[0].length < 9) {
      const headers = [[
        'Timestamp',
        'Email',
        'Status',
        'Order ID',
        'Total Amount',
        'Product ASIN / Qty',
        'Reason / Error',
        'IP Address',
        'Name'
      ]];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Sheet1!A1:I1',
        valueInputOption: 'USER_ENTERED',
        resource: { values: headers }
      });
      console.log("📊 Google Sheets: Created/Updated header row with Column I.");
    }
    headersEnsured = true;
  } catch (e) {
    console.error("❌ Google Sheets: Failed to ensure headers:", e.message);
  }
}

// 1. Append a new placed order (SUCCESS)
async function appendOrderRow(email, status, orderId, totalAmount, productsStr, reason = '', ipAddress = '', addressName = '') {
  const sheets = getSheetsClient();
  if (!sheets) return;

  await ensureHeaders(sheets);

  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const values = [[
    timestamp,
    email,
    status,
    orderId,
    totalAmount,
    productsStr,
    reason,
    ipAddress,
    addressName
  ]];

  try {
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    }));
    
    // Add to local cache if active
    if (cachedRows) {
      cachedRows.push(values[0]);
    }
    
    console.log(`📊 Google Sheets: Appended row for ${email} with status ${status}`);
  } catch (e) {
    console.error("❌ Google Sheets: Failed to append row after retries:", e.message);
  }
}

// 2. Delete rows matching email OR orderId (used when order is CANCELLED)
async function deleteOrderRow(email, orderId) {
  const sheets = getSheetsClient();
  if (!sheets) return;

  try {
    const rows = await getSheetValues(sheets);
    if (rows.length === 0) return;

    const indicesToDelete = [];
    for (let i = 0; i < rows.length; i++) {
      const rowEmail = rows[i][1] ? rows[i][1].trim().toLowerCase() : '';
      const rowOrderId = rows[i][3] ? rows[i][3].trim() : '';

      const matchOrderId = orderId && orderId !== 'UNKNOWN' && rowOrderId === orderId;
      const matchEmail = email && rowEmail === email.trim().toLowerCase();

      if (matchOrderId || (matchEmail && (!orderId || orderId === 'UNKNOWN'))) {
        indicesToDelete.push(i);
      }
    }

    if (indicesToDelete.length === 0) {
      console.log(`📊 Google Sheets: No matching row found to delete for Email: ${email}, Order ID: ${orderId}`);
      return;
    }

    // Update local cache: remove rows from cache (bottom-up to preserve index mapping during loop)
    const indicesSorted = [...indicesToDelete].sort((a, b) => b - a);
    if (cachedRows) {
      for (const idx of indicesSorted) {
        cachedRows.splice(idx, 1);
      }
    }

    const sheetId = await getSheetId(sheets, 'Sheet1');
    const requests = indicesSorted.map(index => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: index,
          endIndex: index + 1
        }
      }
    }));

    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests }
    }));

    console.log(`📊 Google Sheets: Deleted ${indicesToDelete.length} row(s) for Email: ${email}, Order ID: ${orderId}`);
  } catch (e) {
    console.error("❌ Google Sheets: Failed to delete row:", e.message);
  }
}

// 3. Update or append account status (e.g. login failed, password reset)
async function updateAccountStatus(email, status, reason = '') {
  const sheets = getSheetsClient();
  if (!sheets) return;

  try {
    await ensureHeaders(sheets);
    const rows = await getSheetValues(sheets);
    let matchedIndex = -1;

    for (let i = 0; i < rows.length; i++) {
      const rowEmail = rows[i][1] ? rows[i][1].trim().toLowerCase() : '';
      if (rowEmail === email.trim().toLowerCase()) {
        matchedIndex = i;
        break;
      }
    }

    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    if (matchedIndex !== -1) {
      const range = `Sheet1!A${matchedIndex + 1}:I${matchedIndex + 1}`;
      const values = [[
        timestamp,
        email,
        status,
        rows[matchedIndex][3] || '',
        rows[matchedIndex][4] || '',
        rows[matchedIndex][5] || '',
        reason,
        rows[matchedIndex][7] || '',
        rows[matchedIndex][8] || ''
      ]];

      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: { values }
      }));
      
      // Update cache
      if (cachedRows) {
        cachedRows[matchedIndex] = values[0];
      }
      
      console.log(`📊 Google Sheets: Updated status to ${status} for ${email}`);
    } else {
      await appendOrderRow(email, status, '', '', '', reason, '', '');
    }
  } catch (e) {
    console.error("❌ Google Sheets: Failed to update status:", e.message);
  }
}

// 4. Update order status and reason (used when order is CANCELLED or status changes)
async function updateOrderStatus(email, orderId, status, reason = '') {
  const sheets = getSheetsClient();
  if (!sheets) return;

  try {
    await ensureHeaders(sheets);
    const rows = await getSheetValues(sheets);
    if (rows.length === 0) return;

    let matchedIndex = -1;
    if (orderId && orderId !== 'UNKNOWN') {
      for (let i = rows.length - 1; i >= 0; i--) {
        const rowOrderId = rows[i][3] ? rows[i][3].trim() : '';
        if (rowOrderId === orderId) {
          matchedIndex = i;
          break;
        }
      }
    }
    if (matchedIndex === -1 && email) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const rowEmail = rows[i][1] ? rows[i][1].trim().toLowerCase() : '';
        if (rowEmail === email.trim().toLowerCase()) {
          matchedIndex = i;
          break;
        }
      }
    }

    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    if (matchedIndex !== -1) {
      const range = `Sheet1!A${matchedIndex + 1}:I${matchedIndex + 1}`;
      const values = [[
        timestamp,
        email,
        status,
        (orderId && orderId !== 'UNKNOWN') ? orderId : (rows[matchedIndex][3] || ''),
        rows[matchedIndex][4] || '',
        rows[matchedIndex][5] || '',
        reason,
        rows[matchedIndex][7] || '',
        rows[matchedIndex][8] || ''
      ]];

      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: { values }
      }));
      
      // Update cache
      if (cachedRows) {
        cachedRows[matchedIndex] = values[0];
      }
      
      console.log(`📊 Google Sheets: Updated status to ${status} for Email: ${email}, Order ID: ${orderId}`);
    } else {
      await appendOrderRow(email, status, orderId || '', '', '', reason, '', '');
    }
  } catch (e) {
    console.error("❌ Google Sheets: Failed to update order status:", e.message);
  }
}

module.exports = {
  appendOrderRow,
  deleteOrderRow,
  updateAccountStatus,
  updateOrderStatus
};
