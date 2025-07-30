require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// --- FIX: Import node-fetch for server-side HTTP requests ---
const fetch = require("node-fetch");
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
  .connect(MONGODB_URI) // Modern Mongoose versions don't need the extra options
  .then(() => {
    console.log("[DB] Connected to MongoDB.");
  })
  .catch((err) => {
    console.error("[DB] MongoDB connection error:", err);
    process.exit(1);
  });

// --- Define Mongoose Schema and Model for Payments ---
const paymentSchema = new mongoose.Schema({
  MerchantRequestID: { type: String, required: true, unique: true },
  CheckoutRequestID: { type: String, required: true, unique: true },
  ResultCode: { type: Number },
  ResultDesc: { type: String },
  Amount: { type: Number },
  MpesaReceiptNumber: { type: String, unique: true, sparse: true },
  TransactionDate: { type: String },
  PhoneNumber: { type: String },
  status: { type: String, default: "Pending" },
  Timestamp: { type: Date, default: Date.now },
});

const Payment = mongoose.model("Payment", paymentSchema);

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Serve Static Files ---
// This line should ideally come before any specific route handlers
// if those handlers might conflict or if you want static files to be served first.
// It will serve index.html by default if a request comes for the root '/'.
app.use(express.static(path.join(__dirname, "public")));

// --- Routes ---

// The app.get('/') route is now redundant if index.html is in 'public'
// and you want it to be the default served file for the root.
// express.static will automatically serve 'index.html' when '/' is requested.
// You can remove this specific app.get('/') unless you have a reason to
// override the default behavior of express.static for the root.
// For now, I'll comment it out, you can uncomment if you need specific logic for '/'
/*
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
*/

// Example endpoint to handle STK push request
app.post("/api/process_payment", async (req, res) => {
  const { amount, phone } = req.body;
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  try {
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
          PartyA: phone,
          PartyB: MPESA_BUSINESS_SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: MPESA_CALLBACK_URL,
          AccountReference: "VybzPayments",
          TransactionDesc: "Payment for services",
        }),
      }
    );

    const stkPushData = await stkPushResponse.json();
    console.log("STK Push Response:", stkPushData);

    if (stkPushData.ResponseCode === "0") {
      const newPayment = new Payment({
        MerchantRequestID: stkPushData.MerchantRequestID,
        CheckoutRequestID:
          stkPushData.ResponseCode === "0"
            ? stkPushData.CheckoutRequestID
            : "N/A",
        status: "Pending",
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
    const payments = await Payment.find({});
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
  console.log(`[SERVER] M-Pesa Callback endpoint: ${MPESA_CALLBACK_URL}`);
});
