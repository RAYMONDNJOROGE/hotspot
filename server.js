const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const fetch = require("node-fetch");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors"); // Make sure CORS is handled if your frontend is on a different domain/port
const path = require("path");
const { Buffer } = require("buffer"); // For Base64 encoding

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000; // Use port from environment or default to 3000

// --- Middleware ---
app.use(cors()); // Enable CORS for all routes (adjust as needed for security)
app.use(bodyParser.json()); // To parse JSON bodies from incoming requests

// --- Database Setup ---
const db = new sqlite3.Database("./vybz_payments.db", (err) => {
  if (err) {
    console.error(`[DB ERROR] Error opening database: ${err.message}`);
  } else {
    console.log("[DB] Connected to the SQLite database.");
    // Create payments table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phoneNumber TEXT NOT NULL,
            amount REAL NOT NULL,
            packageDescription TEXT NOT NULL,
            macAddress TEXT,
            merchantRequestID TEXT,
            checkoutRequestID TEXT,
            status TEXT NOT NULL,        -- e.g., 'Initiated', 'Completed', 'Failed', 'Pending'
            resultCode TEXT,             -- M-Pesa ResultCode (e.g., 0, 1032)
            resultDesc TEXT,             -- M-Pesa ResultDesc
            mpesaReceiptNumber TEXT,     -- For completed transactions
            transactionDate TEXT,        -- For completed transactions
            createdAt TEXT               -- When the record was inserted
        )`);
    console.log("[DB] Payments table checked/created.");
  }
});

// --- Serve Static Files (Frontend) ---
// This line serves your HTML, CSS, and JS files from the 'public' directory
// e.g., http://localhost:3000/ will serve public/index.html
// http://localhost:3000/css/style.css will serve public/css/style.css
app.use(express.static(path.join(__dirname, "public")));
console.log(
  `[SERVER] Serving static files from: ${path.join(__dirname, "public")}`
);

// --- M-Pesa Helper Function (Get Access Token) ---
async function getMpesaToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error("M-Pesa Consumer Key or Secret not found in .env");
  }

  const authString = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
    "base64"
  );
  const authUrl =
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"; // Use sandbox for testing

  try {
    console.log("[MPESA] Requesting access token...");
    const response = await fetch(authUrl, {
      headers: { Authorization: `Basic ${authString}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `M-Pesa token generation failed with status ${response.status}: ${errorText}`
      );
    }
    const data = await response.json();
    console.log("[MPESA] Access token obtained successfully.");
    return data.access_token;
  } catch (error) {
    console.error(`[MPESA ERROR] Failed to get M-Pesa token: ${error.message}`);
    throw error; // Re-throw to be caught by the calling function's try-catch
  }
}

// --- API Endpoint for Initiating STK Push (From Frontend) ---
app.post("/api/process_payment", async (req, res) => {
  console.log("[API] Received /api/process_payment request:", req.body);
  try {
    const { phoneNumber, amount, packageDescription } = req.body;
    // NOTE: MAC Address is a client-side concept not directly available server-side for web apps.
    // req.headers['x-mac-address'] is a custom header, ensure your frontend sets it if needed.
    const macAddress = req.headers["x-mac-address"] || null;

    // Input Validation
    if (!phoneNumber || !amount || !packageDescription) {
      console.warn(
        "[API] Missing required fields in /api/process_payment request."
      );
      return res.status(400).json({
        error: "Missing required fields (phone number, amount, or package).",
      });
    }
    if (isNaN(amount) || parseFloat(amount) <= 0) {
      // Use parseFloat for robustness
      console.warn(`[API] Invalid amount received: ${amount}`);
      return res
        .status(400)
        .json({ error: "Invalid amount provided. Must be a positive number." });
    }

    const accessToken = await getMpesaToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:.]/g, "")
      .slice(0, 14);
    const password = Buffer.from(
      `${process.env.MPESA_BUSINESS_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString("base64");
    const stkPushUrl =
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

    // Ensure these are set in your .env
    const businessShortCode = process.env.MPESA_BUSINESS_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = process.env.MPESA_CALLBACK_URL; // This should point to your /api/mpesa_callback endpoint

    if (!businessShortCode || !passkey || !callbackUrl) {
      console.error(
        "[MPESA ERROR] M-Pesa B Shortcode, Passkey, or Callback URL not set in .env"
      );
      return res.status(500).json({
        error: "Server configuration error: M-Pesa credentials incomplete.",
      });
    }

    const stkPayload = {
      BusinessShortCode: businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: parseInt(amount), // Amount must be an integer for M-Pesa STK Push
      PartyA: phoneNumber,
      PartyB: businessShortCode,
      PhoneNumber: phoneNumber,
      CallBackURL: callbackUrl,
      AccountReference: packageDescription,
      TransactionDesc: `Vybz Subscription: ${packageDescription}`,
    };

    console.log(
      "[MPESA] Sending STK Push request for phone:",
      phoneNumber,
      "Amount:",
      amount
    );
    const stkResponse = await fetch(stkPushUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(stkPayload),
    });
    const stkData = await stkResponse.json();
    console.log("[MPESA] STK Push Response:", stkData);

    // Record the initiation in the database
    const initialStatus =
      stkData.ResponseCode === "0" || stkData.ResponseCode === "17"
        ? "Initiated"
        : "Failed"; // 17 can also mean successful
    const merchantRequestID = stkData.MerchantRequestID || null;
    const checkoutRequestID = stkData.CheckoutRequestID || null;
    const resultCode = stkData.ResponseCode || null;
    const resultDesc =
      stkData.ResponseDescription || stkData.CustomerMessage || null;

    db.run(
      `INSERT INTO payments (phoneNumber, amount, packageDescription, macAddress, merchantRequestID, checkoutRequestID, status, resultCode, resultDesc, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        phoneNumber,
        amount,
        packageDescription,
        macAddress,
        merchantRequestID,
        checkoutRequestID,
        initialStatus,
        resultCode,
        resultDesc,
        new Date().toISOString(),
      ],
      function (err) {
        if (err) {
          console.error(
            `[DB ERROR] Failed to save initial payment record: ${err.message}`
          );
        } else {
          console.log(
            `[DB] Initial payment record saved for ${phoneNumber}, ID: ${this.lastID}`
          );
        }
      }
    );

    if (stkData.ResponseCode === "0" || stkData.ResponseCode === "17") {
      return res.status(200).json({
        message:
          "Payment initiated successfully. Please check your phone for M-Pesa prompt.",
        checkoutRequestID: checkoutRequestID,
        merchantRequestID: merchantRequestID,
      });
    } else {
      console.error(
        `[MPESA ERROR] STK Push failed for ${phoneNumber}: ${resultDesc}`
      );
      return res.status(400).json({ error: resultDesc });
    }
  } catch (error) {
    console.error(
      `[SERVER ERROR] An unhandled error occurred in /api/process_payment: ${error.message}`
    );
    return res
      .status(500)
      .json({ error: "An internal server error occurred." });
  }
});

// --- M-Pesa Callback Endpoint (for Safaricom to send results) ---
// IMPORTANT: This endpoint MUST be publicly accessible from Safaricom's network.
// For local testing, you'll need tools like ngrok to expose your localhost.
app.post("/api/mpesa_callback", (req, res) => {
  console.log(
    "[MPESA CALLBACK] Received M-Pesa callback:",
    JSON.stringify(req.body, null, 2)
  );

  const callbackData = req.body;
  const Body = callbackData.Body;
  const stkCallback = Body.stkCallback; // For STK Push
  const c2bCallback = Body.stkCallback; // For C2B (Paybill/Till)

  if (stkCallback) {
    // STK Push Callback
    const merchantRequestID = stkCallback.MerchantRequestID;
    const checkoutRequestID = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;
    const mpesaReceiptNumber =
      stkCallback.CallbackMetadata?.Item.find(
        (item) => item.Name === "MpesaReceiptNumber"
      )?.Value || null;
    const transactionDate =
      stkCallback.CallbackMetadata?.Item.find(
        (item) => item.Name === "TransactionDate"
      )?.Value || null;
    const amount =
      stkCallback.CallbackMetadata?.Item.find((item) => item.Name === "Amount")
        ?.Value || null;
    const phoneNumber =
      stkCallback.CallbackMetadata?.Item.find(
        (item) => item.Name === "PhoneNumber"
      )?.Value || null;

    let status = "Failed";
    if (resultCode === 0) {
      status = "Completed";
      console.log(
        `[MPESA CALLBACK] STK Push Completed for CheckoutRequestID: ${checkoutRequestID}, Receipt: ${mpesaReceiptNumber}`
      );
    } else if (resultCode === 1032) {
      status = "Cancelled";
      console.warn(
        `[MPESA CALLBACK] STK Push Cancelled by user for CheckoutRequestID: ${checkoutRequestID}`
      );
    } else {
      console.error(
        `[MPESA CALLBACK] STK Push Failed for CheckoutRequestID: ${checkoutRequestID}, ResultCode: ${resultCode}, Desc: ${resultDesc}`
      );
    }

    // Update the payment record in your database
    db.run(
      `UPDATE payments 
             SET status = ?, resultCode = ?, resultDesc = ?, mpesaReceiptNumber = ?, transactionDate = ?
             WHERE checkoutRequestID = ?`,
      [
        status,
        resultCode,
        resultDesc,
        mpesaReceiptNumber,
        transactionDate,
        checkoutRequestID,
      ],
      function (err) {
        if (err) {
          console.error(
            `[DB ERROR] Failed to update payment record for ${checkoutRequestID}: ${err.message}`
          );
        } else if (this.changes === 0) {
          console.warn(
            `[DB WARNING] No record found to update for CheckoutRequestID: ${checkoutRequestID}`
          );
        } else {
          console.log(
            `[DB] Payment record updated for CheckoutRequestID: ${checkoutRequestID}, New Status: ${status}`
          );
        }
      }
    );
  } else {
    console.warn(
      "[MPESA CALLBACK] Unknown or unsupported M-Pesa callback type received."
    );
  }

  // Acknowledge receipt of the callback from Safaricom
  res.status(200).json({ message: "Callback received successfully" });
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`[SERVER] Server is running on http://localhost:${PORT}`);
  console.log(
    `[SERVER] M-Pesa STK Push endpoint: http://localhost:${PORT}/api/process_payment`
  );
  console.log(
    `[SERVER] M-Pesa Callback endpoint: ${
      process.env.MPESA_CALLBACK_URL || "Not set in .env"
    }`
  );
});

// --- Graceful Shutdown (Optional but Recommended for Production) ---
process.on("SIGINT", () => {
  console.log("[SERVER] Shutting down server...");
  db.close((err) => {
    if (err) {
      console.error(`[DB ERROR] Error closing database: ${err.message}`);
    } else {
      console.log("[DB] Database closed.");
    }
    process.exit(0);
  });
});
