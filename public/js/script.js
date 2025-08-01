// server.js

// 1. Load Environment Variables - Always at the very top
require("dotenv").config();

// 2. Import Required Modules
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const helmet = require("helmet");
const morgan = require("morgan");
const fetch = require("node-fetch");

// Import custom utilities
const APIError = require("./utils/apiError"); // NEW: Import from a separate file
const { normalizePhoneNumber } = require("./utils/validators"); // NEW: Import from a separate file

const app = express();
const PORT = process.env.PORT || 3000;

// --- M-Pesa API Configuration from Environment Variables ---
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_BUSINESS_SHORTCODE = process.env.MPESA_BUSINESS_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;
const MPESA_API_BASE_URL =
  process.env.MPESA_API_BASE_URL || "https://sandbox.safaricom.co.ke";

// --- MongoDB Connection String (from .env) ---
const MONGODB_URI = process.env.MONGODB_URI;

// --- Critical Environment Variable Check ---
const requiredEnvVars = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_BUSINESS_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
  "MONGODB_URI",
];
const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(
    `CRITICAL ERROR: The following required environment variables are missing: ${missingEnvVars.join(
      ", "
    )}`
  );
  process.exit(1);
}

// --- Connect to MongoDB ---
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("[DB] Connected to MongoDB successfully.");
  })
  .catch((err) => {
    console.error("[DB] MongoDB initial connection error:", err.message);
    process.exit(1);
  });

// --- Define Mongoose Schema and Model for Payments ---
const paymentSchema = new mongoose.Schema(
  {
    MerchantRequestID: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    CheckoutRequestID: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    ResultCode: { type: Number, index: true },
    ResultDesc: { type: String },
    Amount: { type: Number },
    MpesaReceiptNumber: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    TransactionDate: { type: Date },
    PhoneNumber: { type: String },
    status: {
      type: String,
      default: "Pending",
      enum: [
        "Pending",
        "Completed",
        "Failed",
        "Cancelled",
        "Processing",
        "Timeout",
      ],
    },
    RawCallbackData: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    strict: true,
  }
);
paymentSchema.pre("save", function (next) {
  if (this.MpesaReceiptNumber === "") {
    this.MpesaReceiptNumber = undefined;
  }
  next();
});
const Payment = mongoose.model("Payment", paymentSchema);

// --- Middleware Configuration ---
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// NEW: Refined CORS Configuration
const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? ["https://hotspot-gved.onrender.com"] // Your production frontend URL
      : [
          "http://localhost:3000",
          "http://localhost:5173",
          "http://127.0.0.1:5173",
        ], // Add all local frontend dev URLs
};
app.use(cors(corsOptions));

// Serve Static Files - Ensure this points to where your index.html is
app.use(express.static(path.join(__dirname, "public")));

// --- API Routes ---

// M-Pesa Payment Initiation API Endpoint
app.post("/api/process_payment", async (req, res, next) => {
  try {
    let { amount, phone, packageDescription } = req.body; // --- Input Validation ---

    if (!amount || !phone || !packageDescription) {
      throw new APIError(
        "Missing required payment details: amount, phone, or package description.",
        400
      );
    }
    amount = parseFloat(amount);
    if (isNaN(amount) || amount <= 0) {
      throw new APIError(
        "Invalid amount provided. Amount must be a positive number.",
        400
      );
    }
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      throw new APIError(
        "Invalid phone number format. Please use a valid Kenyan Safaricom mobile number (e.g., 07XXXXXXXX or 01XXXXXXXX).",
        400
      );
    }
    phone = normalizedPhone;

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const auth = Buffer.from(
      `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    const tokenResponse = await fetch(
      `${MPESA_API_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: "GET",
        headers: { Authorization: `Basic ${auth}` },
      }
    );

    if (!tokenResponse.ok) {
      const tokenError = await tokenResponse
        .json()
        .catch(() => ({ message: "Failed to parse M-Pesa token error" }));
      console.error(
        "Failed to get M-Pesa access token:",
        tokenResponse.status,
        tokenError
      );
      throw new APIError(
        "Failed to authenticate with M-Pesa. Please try again later.",
        tokenResponse.status,
        process.env.NODE_ENV !== "production" ? tokenError : undefined
      );
    }
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error("M-Pesa access token not found in response:", tokenData);
      throw new APIError(
        "M-Pesa authentication failed unexpectedly: No access token received.",
        500
      );
    }

    const password = Buffer.from(
      `${MPESA_BUSINESS_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

    const stkPushPayload = {
      BusinessShortCode: MPESA_BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_BUSINESS_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: packageDescription,
      TransactionDesc: `Payment for ${packageDescription} via Raynger Hotspot Services`,
    };

    console.log("STK Push Payload:", JSON.stringify(stkPushPayload, null, 2));

    const stkPushResponse = await fetch(
      `${MPESA_API_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(stkPushPayload),
      }
    );

    const stkPushData = await stkPushResponse.json();
    console.log("M-Pesa STK Push Response:", stkPushData);

    if (stkPushData.ResponseCode === "0") {
      const newPayment = new Payment({
        MerchantRequestID: stkPushData.MerchantRequestID,
        CheckoutRequestID: stkPushData.CheckoutRequestID,
        status: "Processing",
        Amount: amount,
        PhoneNumber: phone,
      });
      await newPayment.save();
      console.log("Initial payment request saved to MongoDB:", newPayment._id);

      res.status(200).json({
        success: true,
        message:
          "Payment request sent successfully. Please complete the transaction on your phone.",
        customerMessage:
          stkPushData.CustomerMessage || "Awaiting user payment confirmation.",
        checkoutRequestID: stkPushData.CheckoutRequestID,
      });
    } else {
      const errorMessage =
        stkPushData.CustomerMessage ||
        stkPushData.ResponseDescription ||
        stkPushData.errorMessage ||
        "Unknown error from M-Pesa during STK push initiation.";

      console.error("STK Push failed:", errorMessage, stkPushData);

      const failedPayment = new Payment({
        MerchantRequestID:
          stkPushData.MerchantRequestID || `Failed-${Date.now()}`,
        CheckoutRequestID:
          stkPushData.CheckoutRequestID || `Failed-${Date.now()}`,
        status: "Failed",
        Amount: amount,
        PhoneNumber: phone,
        ResultCode: stkPushData.ResponseCode,
        ResultDesc: errorMessage,
        RawCallbackData: stkPushData,
      });
      await failedPayment
        .save()
        .catch((dbErr) =>
          console.error("Failed to save failed payment attempt:", dbErr)
        );

      throw new APIError(
        `Payment initiation failed: ${errorMessage}`,
        400,
        process.env.NODE_ENV !== "production" ? stkPushData : undefined
      );
    }
  } catch (error) {
    next(error);
  }
});

// M-Pesa Callback URL
app.post("/api/mpesa_callback", async (req, res) => {
  const callbackData = req.body;
  console.log(
    "M-Pesa Callback received:",
    JSON.stringify(callbackData, null, 2)
  );

  res.status(200).json({ MpesaResponse: "Callback received" }); // NEW: Wrap processing logic in a function to make it cleaner

  const processCallbackInBackground = async () => {
    try {
      if (!callbackData.Body || !callbackData.Body.stkCallback) {
        console.error(
          "Invalid M-Pesa callback format: Missing Body or stkCallback."
        );
        return;
      }

      const stkCallback = callbackData.Body.stkCallback;
      const merchantRequestID = stkCallback.MerchantRequestID;
      const checkoutRequestID = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;
      const resultDesc =
        stkCallback.ResultDesc ||
        (stkCallback.CallbackMetadata &&
          stkCallback.CallbackMetadata.Item &&
          stkCallback.CallbackMetadata.Item.find(
            (item) => item.Name === "ResultDesc"
          )?.Value) ||
        "No specific description provided.";

      const updateFields = {
        ResultCode: resultCode,
        ResultDesc: resultDesc,
        RawCallbackData: callbackData,
      };

      if (resultCode === 0) {
        updateFields.status = "Completed";
        const callbackMetadata = stkCallback.CallbackMetadata;
        if (callbackMetadata && callbackMetadata.Item) {
          callbackMetadata.Item.forEach((item) => {
            if (item.Name === "Amount") updateFields.Amount = item.Value;
            if (item.Name === "MpesaReceiptNumber")
              updateFields.MpesaReceiptNumber = item.Value;
            if (item.Name === "TransactionDate") {
              const dateString = item.Value;
              if (dateString && dateString.length === 14) {
                const year = dateString.substring(0, 4);
                const month = dateString.substring(4, 6) - 1;
                const day = dateString.substring(6, 8);
                const hour = dateString.substring(8, 10);
                const minute = dateString.substring(10, 12);
                const second = dateString.substring(12, 14);
                updateFields.TransactionDate = new Date(
                  Date.UTC(year, month, day, hour, minute, second)
                );
              }
            }
            if (item.Name === "PhoneNumber")
              updateFields.PhoneNumber = item.Value;
          });
        }
      } else {
        updateFields.status = resultCode === 1032 ? "Cancelled" : "Failed";
      }
      const query = {
        $or: [
          { CheckoutRequestID: checkoutRequestID },
          { MerchantRequestID: merchantRequestID },
        ],
      };
      const updatedPayment = await Payment.findOneAndUpdate(
        query,
        { $set: updateFields },
        { new: true, upsert: true, runValidators: true }
      );
      if (updatedPayment) {
        console.log(
          `Payment record updated/created for CheckoutRequestID ${checkoutRequestID}. Status: ${updatedPayment.status}`
        );
        if (updatedPayment.status === "Completed") {
          console.log(
            `[Service Fulfillment] Payment for ${updatedPayment.MpesaReceiptNumber} completed. Fulfilling service for ${updatedPayment.PhoneNumber}.`
          ); // YOUR SERVICE FULFILLMENT LOGIC GOES HERE
        }
      } else {
        console.warn(
          `[DB Issue] findOneAndUpdate did not return a document for CheckoutRequestID ${checkoutRequestID}.`
        );
      }
    } catch (error) {
      console.error(
        "CRITICAL: Error processing M-Pesa callback (async background job):",
        error
      );
    }
  };
  setImmediate(processCallbackInBackground);
});

// Endpoint to retrieve all payments (for testing/admin purposes)
app.get("/api/payments", async (req, res, next) => {
  // NEW: IMPORTANT - This endpoint is a major security risk if exposed in production.
  // Ensure you have strong authorization logic here.
  // For local testing, you might leave it open, but for deployment, it MUST be locked down.
  if (process.env.NODE_ENV === "production" && !req.headers.authorization) {
    return next(new APIError("Authentication required.", 401));
  } // You can add more robust auth here (e.g., JWT, API Key)
  try {
    const {
      page = 1,
      limit = 10,
      status,
      sort = "createdAt",
      order = -1,
    } = req.query;
    const query = status ? { status } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = parseInt(order);

    const payments = await Payment.find(query)
      .sort({ [sort]: sortOrder })
      .skip(skip)
      .limit(parseInt(limit));

    const totalPayments = await Payment.countDocuments(query);

    res.json({
      success: true,
      data: payments,
      meta: {
        total: totalPayments,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalPayments / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching payments:", error);
    next(error);
  }
});

// Basic comments endpoint
app.post("/api/comments", (req, res, next) => {
  try {
    const { firstName, secondName, phone, email, commentsText } = req.body;
    console.log("Received new comment:", {
      firstName,
      secondName,
      phone,
      email,
      commentsText,
    });
    res
      .status(200)
      .json({ success: true, message: "Comment received successfully!" });
  } catch (error) {
    next(new APIError("Failed to process comment.", 500, error));
  }
});

// --- Centralized Error Handling Middleware (MUST be the last middleware) ---
app.use((err, req, res, next) => {
  const logLevel = err.statusCode && err.statusCode < 500 ? "warn" : "error";
  if (process.env.NODE_ENV !== "production") {
    console[logLevel]("Unhandled Server Error (DEV):", err.stack || err);
  } else {
    console[logLevel]("Unhandled Server Error (PROD):", err.message, {
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
  }
  let statusCode = 500;
  let message = "An internal server error occurred. Please try again later.";
  let errorDetails = undefined;
  if (err instanceof APIError) {
    statusCode = err.statusCode;
    message = err.message;
    if (process.env.NODE_ENV !== "production") {
      errorDetails = err.details;
    }
  } else if (err.name === "ValidationError" && err.errors) {
    statusCode = 400;
    message = "Data validation failed.";
    errorDetails = Object.values(err.errors).map((val) => val.message);
  } else if (err.name === "CastError" && err.path) {
    statusCode = 400;
    message = `Invalid format for ${err.path}.`;
  }
  res.status(statusCode).json({
    success: false,
    message: message,
    error: errorDetails,
  });
});

// --- Start Server ---
const server = app.listen(PORT, () => {
  console.log(`[SERVER] Server is running on http://localhost:${PORT}`);
  console.log(`[SERVER] Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`[SERVER] M-Pesa Callback endpoint: ${MPESA_CALLBACK_URL}`);
  console.log(`[SERVER] M-Pesa API Base URL: ${MPESA_API_BASE_URL}`);
});

// --- Graceful Server Shutdown ---
const shutdown = () => {
  console.log("Server is initiating graceful shutdown...");
  server.close(() => {
    console.log("HTTP server closed.");
    mongoose
      .disconnect()
      .then(() => {
        console.log("MongoDB connection closed.");
        process.exit(0);
      })
      .catch((err) => {
        console.error("Error closing MongoDB connection:", err);
        process.exit(1);
      });
  });
  setTimeout(() => {
    console.error("Forcing server shutdown due to timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Catch unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason.message || reason);
});

// Catch uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
  shutdown();
});

module.exports = app;
// Ensure the API_BASE_URL is correct for your deployment
// This should be the base URL for the M-Pesa API, e.g., "https://sandbox.safaricom.co.ke" for testing
// or "https://api.safaricom.co.ke" for production.
// Ensure the MONGODB_URI is set correctly in your .env file
// This should point to your MongoDB instance, e.g., "mongodb://localhost:27017/yourdbname"
// Ensure the MPESA_CALLBACK_URL is set correctly in your .env file
// This should be the URL where M-Pesa will send payment notifications, e.g., "https://yourdomain.com/api/mpesa_callback"
// Ensure the MPESA_PASSKEY, MPESA_CONSUMER_KEY, and MPESA_CONSUMER_SECRET are set correctly in your .env file
// These should be your M-Pesa API credentials, which you can obtain from Safaricom's developer portal.
