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

// Helper to get all values of Sheet1
async function getSheetValues(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sheet1!A:H', // A=Timestamp, B=Email, C=Status, D=Order ID, E=Total Amount, F=Product ASIN/Qty, G=Reason, H=IP
  });
  return response.data.values || [];
}

// 1. Append a new placed order (SUCCESS)
async function appendOrderRow(email, status, orderId, totalAmount, productsStr, reason = '', ipAddress = '') {
  const sheets = getSheetsClient();
  if (!sheets) return;

  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const values = [[
    timestamp,
    email,
    status,
    orderId,
    totalAmount,
    productsStr,
    reason,
    ipAddress
  ]];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });
    console.log(`📊 Google Sheets: Appended row for ${email} with status ${status}`);
  } catch (e) {
    console.error("❌ Google Sheets: Failed to append row:", e.message);
  }
}

// 2. Delete rows matching email OR orderId (used when order is CANCELLED)
async function deleteOrderRow(email, orderId) {
  const sheets = getSheetsClient();
  if (!sheets) return;

  try {
    const rows = await getSheetValues(sheets);
    if (rows.length === 0) return;

    // We will collect 0-indexed row indices that match either orderId (if valid) or email
    const indicesToDelete = [];
    
    // Start scanning from row index 0 (even if row 0 is header, it won't match real data)
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

    // Sort indices in descending order so that deleting from bottom-up doesn't affect the indices of preceding rows
    indicesToDelete.sort((a, b) => b - a);

    const sheetId = await getSheetId(sheets, 'Sheet1');

    const requests = indicesToDelete.map(index => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: index,
          endIndex: index + 1
        }
      }
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests }
    });

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
    const rows = await getSheetValues(sheets);
    let matchedIndex = -1;

    // Scan for an existing row for this email to update its status
    for (let i = 0; i < rows.length; i++) {
      const rowEmail = rows[i][1] ? rows[i][1].trim().toLowerCase() : '';
      if (rowEmail === email.trim().toLowerCase()) {
        matchedIndex = i;
        break;
      }
    }

    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    if (matchedIndex !== -1) {
      // Update existing row
      const range = `Sheet1!A${matchedIndex + 1}:H${matchedIndex + 1}`;
      const values = [[
        timestamp,
        email,
        status,
        rows[matchedIndex][3] || '', // keep orderId
        rows[matchedIndex][4] || '', // keep totalAmount
        rows[matchedIndex][5] || '', // keep products
        reason,
        rows[matchedIndex][7] || ''  // keep IP
      ]];

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: { values }
      });
      console.log(`📊 Google Sheets: Updated status to ${status} for ${email}`);
    } else {
      // Append a new row if not found
      await appendOrderRow(email, status, '', '', '', reason, '');
    }
  } catch (e) {
    console.error("❌ Google Sheets: Failed to update status:", e.message);
  }
}

module.exports = {
  appendOrderRow,
  deleteOrderRow,
  updateAccountStatus
};
