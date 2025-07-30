require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// --- FIX: Import node-fetch for server-side HTTP requests ---
// For Node.js versions < 18, this is essential.
// For Node.js versions >= 18, while global fetch exists, explicitly importing is robust.
const fetch = require("node-fetch"); // Ensure you have 'node-fetch' installed (npm install node-fetch@2)
// --- END FIX ---

// --- M-Pesa API Credentials ---
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_BUSINESS_SHORTCODE = process.env.MPESA_BUSINESS_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL; // This should be your public URL

// --- MongoDB Connection String (from .env) ---
const MONGODB_URI = process.env.MONGODB_URI;

// --- Connect to MongoDB ---
mongoose
  .connect(MONGODB_URI, {
    // useNewUrlParser: true, // Deprecated in recent Mongoose versions, might not be needed
    // useUnifiedTopology: true, // Deprecated in recent Mongoose versions, might not be needed
    // useCreateIndex: true, // Deprecated
    // useFindAndModify: false // Deprecated
  })
  .then(() => {
    console.log("[DB] Connected to MongoDB.");
    // If you had any schema/model creation, it would typically go here
  })
  .catch((err) => {
    console.error("[DB] MongoDB connection error:", err);
    process.exit(1); // Exit process if database connection fails
  });

// --- Define Mongoose Schema and Model for Payments ---
// This defines the structure of your 'payments' collection in MongoDB
const paymentSchema = new mongoose.Schema({
  MerchantRequestID: { type: String, required: true, unique: true },
  CheckoutRequestID: { type: String, required: true, unique: true },
  ResultCode: { type: Number },
  ResultDesc: { type: String },
  Amount: { type: Number },
  MpesaReceiptNumber: { type: String, unique: true, sparse: true }, // sparse allows multiple nulls
  TransactionDate: { type: String }, // Or Date if you parse it
  PhoneNumber: { type: String },
  status: { type: String, default: "Pending" }, // Custom status field
  Timestamp: { type: Date, default: Date.now }, // When the record was created
});

const Payment = mongoose.model("Payment", paymentSchema); // 'Payment' will become 'payments' collection

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// IMPORTANT: If you want *only* your single index.html to be served for the root,
// and it contains all CSS/JS, then you remove or comment out the general static serve for '/'
// If you still have other static assets (e.g., images for API, or different routes) in 'public'
// then keep the line below, but ensure your main HTML is handled by app.get('/') directly.
// For this specific request (single HTML file), we'll assume other static assets aren't
// needed for the root page, or are also embedded.

// If you want to serve other static files for *other* routes (e.g., /admin/dashboard.html, /images/logo.png)
// from a 'public' directory, you could keep this line, but it wouldn't affect the root '/'
// if your app.get('/') comes *before* this `express.static` middleware.
// app.use(express.static("public")); // <--- This line is often before routes for static content

// --- Routes ---

// Route to serve your single HTML file with embedded CSS and JS
// This MUST come before any other generic static file serving if you want
// to ensure the root path explicitly serves your index.html.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Example endpoint to handle STK push request
// REMOVED: import fetch from "node-fetch"; // This line was causing the error
app.post("/api/process_payment", async (req, res) => {
  const { amount, phone } = req.body; // Extract data from request body
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  try {
    // Get M-Pesa OAuth token
    const auth = Buffer.from(
      `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
    ).toString("base64");
    const tokenResponse = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error("Failed to get M-Pesa access token:", tokenData);
      return res.status(500).json({
        success: false,
        message: "Failed to authenticate with M-Pesa.",
      });
    }

    const password = Buffer.from(
      `${MPESA_BUSINESS_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

    const stkPushResponse = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          BusinessShortCode: MPESA_BUSINESS_SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: amount,
          PartyA: phone, // Customer's phone number
          PartyB: MPESA_BUSINESS_SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: MPESA_CALLBACK_URL,
          AccountReference: "VybzPayments", // Replace with a unique ref if needed
          TransactionDesc: "Payment for services",
        }),
      }
    );

    const stkPushData = await stkPushResponse.json();
    console.log("STK Push Response:", stkPushData);

    if (stkPushData.ResponseCode === "0") {
      // Store initial STK Push request data in MongoDB
      const newPayment = new Payment({
        MerchantRequestID: stkPushData.MerchantRequestID,
        CheckoutRequestID:
          stkPushData.ResponseCode === "0"
            ? stkPushData.CheckoutRequestID
            : "N/A", // Only store if successful
        status: "Pending", // Initial status
      });
      await newPayment.save();
      console.log("Initial payment request saved to MongoDB.");

      res.json({
        success: true,
        message: "STK push initiated successfully.",
        data: stkPushData,
      });
    } else {
      console.error(
        "STK Push failed:",
        stkPushData.ResponseDescription || stkPushData.errorMessage
      );
      res.status(400).json({
        success: false,
        message: "STK push failed.",
        error: stkPushData,
      });
    }
  } catch (error) {
    console.error("Error initiating M-Pesa STK push:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during STK push.",
    });
  }
});

// M-Pesa Callback URL
app.post("/api/mpesa_callback/", async (req, res) => {
  const callbackData = req.body;
  console.log(
    "M-Pesa Callback received:",
    JSON.stringify(callbackData, null, 2)
  );

  if (!callbackData.Body || !callbackData.Body.stkCallback) {
    console.error("Invalid M-Pesa callback format.");
    return res.status(400).json({ message: "Invalid callback data." });
  }

  const stkCallback = callbackData.Body.stkCallback;
  const merchantRequestID = stkCallback.MerchantRequestID;
  const checkoutRequestID = stkCallback.CheckoutRequestID;
  const resultCode = stkCallback.ResultCode;
  const resultDesc = stkCallback.ResultDesc;

  try {
    // Find the payment record by CheckoutRequestID or MerchantRequestID
    const payment = await Payment.findOne({
      $or: [
        { CheckoutRequestID: checkoutRequestID },
        { MerchantRequestID: merchantRequestID },
      ],
    });

    if (payment) {
      payment.ResultCode = resultCode;
      payment.ResultDesc = resultDesc;

      if (resultCode === 0) {
        payment.status = "Completed";
        const callbackMetadata = stkCallback.CallbackMetadata;
        if (callbackMetadata && callbackMetadata.Item) {
          callbackMetadata.Item.forEach((item) => {
            if (item.Name === "Amount") payment.Amount = item.Value;
            if (item.Name === "MpesaReceiptNumber")
              payment.MpesaReceiptNumber = item.Value;
            if (item.Name === "TransactionDate")
              payment.TransactionDate = item.Value;
            if (item.Name === "PhoneNumber") payment.PhoneNumber = item.Value;
          });
        }
      } else {
        payment.status = "Failed";
      }

      await payment.save();
      console.log(
        `Payment record for ${merchantRequestID} updated in MongoDB.`
      );
    } else {
      console.warn(
        `Payment record for ${merchantRequestID} not found. Creating new entry.`
      );
      // If not found, create a new record (less ideal but handles missed initial saves)
      const newPayment = new Payment({
        MerchantRequestID: merchantRequestID,
        CheckoutRequestID: checkoutRequestID,
        ResultCode: resultCode,
        ResultDesc: resultDesc,
        status: resultCode === 0 ? "Completed" : "Failed",
      });

      if (resultCode === 0) {
        const callbackMetadata = stkCallback.CallbackMetadata;
        if (callbackMetadata && callbackMetadata.Item) {
          callbackMetadata.Item.forEach((item) => {
            if (item.Name === "Amount") newPayment.Amount = item.Value;
            if (item.Name === "MpesaReceiptNumber")
              newPayment.MpesaReceiptNumber = item.Value;
            if (item.Name === "TransactionDate")
              newPayment.TransactionDate = item.Value;
            if (item.Name === "PhoneNumber")
              newPayment.PhoneNumber = item.Value;
          });
        }
      }
      await newPayment.save();
      console.log(
        `New payment record created for ${merchantRequestID} in MongoDB (from callback).`
      );
    }

    res.status(200).json({ message: "Callback received successfully." });
  } catch (error) {
    console.error("Error processing M-Pesa callback:", error);
    res
      .status(500)
      .json({ message: "Internal server error during callback processing." });
  }
});

// Endpoint to retrieve all payments (for testing/admin purposes)
app.get("/api/payments", async (req, res) => {
  try {
    const payments = await Payment.find({}); // Retrieve all payments
    res.json(payments);
  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({ message: "Error fetching payments." });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`[SERVER] Server is running on http://localhost:${PORT}`);
  console.log(
    `[SERVER] M-Pesa STK Push endpoint: http://localhost:${PORT}/api/process_payment`
  );
  console.log(`[SERVER] M-Pesa Callback endpoint: ${MPESA_CALLBACK_URL}`); // Use the dynamic URL
});
// Note: Ensure your MPESA_CALLBACK_URL is set correctly in your .env file
// and is publicly accessible for M-Pesa to reach it.
// If you're using a service like ngrok for local development, set MPESA_CALLBACK_URL to the ngrok URL.
// If you're deploying to a production server, ensure the URL is accessible by M-Pesa.
