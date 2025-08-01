// 1. Load Environment Variables - Always at the very top
require("dotenv").config();

// 2. Import Required Modules
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const helmet = require("helmet"); // Security headers
const morgan = require("morgan"); // Request logging
const fetch = require("node-fetch"); // For server-side HTTP requests
const nodemailer = require("nodemailer"); // Email sending library

const app = express();
const PORT = process.env.PORT || 3000;

// --- Custom Error Class and Handler ---
class APIError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

// --- M-Pesa API Configuration from Environment Variables ---
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_BUSINESS_SHORTCODE = process.env.MPESA_BUSINESS_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;
const MPESA_API_BASE_URL =
  process.env.MPESA_API_BASE_URL || "https://sandbox.safaricom.co.ke";

// --- Hotspot Service Configuration (MikroTik API) ---
const HOTSPOT_GATEWAY_URL = process.env.HOTSPOT_GATEWAY_URL;
const HOTSPOT_API_KEY = process.env.HOTSPOT_API_KEY;

// --- Email Service Configuration from Environment Variables ---
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT;

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
  "EMAIL_USER",
  "EMAIL_PASS",
  "EMAIL_RECIPIENT",
  "HOTSPOT_GATEWAY_URL", // Added hotspot config
  "HOTSPOT_API_KEY", // Added hotspot config
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

// Pre-save hook: Handle empty string for MpesaReceiptNumber
paymentSchema.pre("save", function (next) {
  if (this.MpesaReceiptNumber === "") {
    this.MpesaReceiptNumber = undefined;
  }
  next();
});

const Payment = mongoose.model("Payment", paymentSchema);

// --- Middleware Configuration ---
app.use(helmet());

const allowedOrigins =
  process.env.NODE_ENV === "production"
    ? ["https://hotspot-gved.onrender.com"]
    : ["http://localhost:3000", "http://localhost:5500"];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}.`;
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// --- Helper for Phone Number Normalization and Validation (IMPROVED) ---
/**
 * Normalizes and validates a Kenyan phone number.
 * Accepts numbers starting with 07, 01, 2547, or 2541.
 * @param {string} phone - The phone number to normalize.
 * @returns {string|null} The normalized phone number in 254 format, or null if invalid.
 */
function normalizePhoneNumber(phone) {
  phone = String(phone).trim();
  const kenyanPhoneRegex = /^(0(1|7)\d{8})$/;

  if (!kenyanPhoneRegex.test(phone)) {
    return null; // Invalid format
  }

  if (phone.startsWith("0")) {
    return "254" + phone.substring(1);
  }
  return phone;
}

// --- NEW: Helper for activating hotspot service via API call ---
/**
 * Simulates an API call to a hotspot gateway to activate a user.
 * You must replace this with your actual API integration for MikroTik or other systems.
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} plan - The plan description (e.g., "1 Day Pass").
 */
async function activateHotspotService(phoneNumber, plan) {
  try {
    const activationPayload = {
      // These are examples; refer to your router's API documentation
      // For MikroTik, this might be a JSON payload for a user login
      user_mac: "00:00:00:00:00:00", // You would need to get the user's MAC address from the hotspot login page
      username: phoneNumber,
      profile: plan, // Match this with a user profile configured on MikroTik
      api_key: HOTSPOT_API_KEY,
    };

    console.log(
      `[Hotspot] Attempting to activate service for ${phoneNumber} with plan '${plan}'...`
    );

    const response = await fetch(HOTSPOT_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activationPayload),
    });

    const result = await response.json();

    if (response.ok) {
      console.log(
        `[Hotspot] Service activated successfully for ${phoneNumber}.`
      );
      // Log the success response from the hotspot API
      console.log("Hotspot API Response:", result);
    } else {
      console.error(`[Hotspot] Failed to activate service for ${phoneNumber}.`);
      // Log the error response from the hotspot API
      console.error("Hotspot API Error:", result);
    }
  } catch (error) {
    console.error(
      `[Hotspot] Critical error calling hotspot API for ${phoneNumber}:`,
      error
    );
  }
}

// --- Nodemailer transporter setup ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// --- API Routes ---

// M-Pesa Payment Initiation API Endpoint
app.post("/api/process_payment", async (req, res, next) => {
  try {
    let { amount, phone, packageDescription } = req.body;

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
        "Invalid phone number format. Please use a valid Kenyan mobile number (e.g., 07XXXXXXXX or 01XXXXXXXX).",
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

    if (stkPushData.ResponseCode === "0") {
      const newPayment = new Payment({
        MerchantRequestID: stkPushData.MerchantRequestID,
        CheckoutRequestID: stkPushData.CheckoutRequestID,
        status: "Processing",
        Amount: amount,
        PhoneNumber: phone,
      });
      await newPayment.save();

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

// M-Pesa Callback URL (Confirmation and Validation URLs go here)
app.post("/api/mpesa_callback", async (req, res) => {
  const callbackData = req.body;
  res.status(200).json({ MpesaResponse: "Callback received" });

  setImmediate(async () => {
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

      const updateFields = {
        ResultCode: resultCode,
        ResultDesc:
          stkCallback.ResultDesc || "No specific description provided.",
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

        // --- YOUR SERVICE FULFILLMENT LOGIC GOES HERE ---
        // This is the CRITICAL part. If the payment is successful,
        // you must now call the MikroTik API to activate the user's hotspot.
        // The `activateHotspotService` helper function I added above is designed for this.
        if (updatedPayment.status === "Completed") {
          console.log(
            `[Service Fulfillment] Payment for ${updatedPayment.MpesaReceiptNumber} completed. Fulfilling service for ${updatedPayment.PhoneNumber}.`
          );

          // Call the helper function to activate the hotspot
          // You will need to pass the correct plan and, if possible, the user's MAC address.
          const plan = updatedPayment.AccountReference; // Assuming this field is populated from the STK push
          await activateHotspotService(updatedPayment.PhoneNumber, plan);
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
  });
});

// Endpoint to retrieve all payments (SECURE THIS!)
app.get("/api/payments", async (req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    (!req.headers.authorization ||
      !req.headers.authorization.startsWith("Bearer "))
  ) {
    return next(new APIError("Authentication required.", 401));
  }
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

// Endpoint to receive comments and send an email
app.post("/api/submit_comment", async (req, res, next) => {
  try {
    const { firstName, secondName, phone, email, commentsText } = req.body;

    if (!commentsText) {
      return next(new APIError("Comment text is required.", 400));
    }

    const mailOptions = {
      from: EMAIL_USER,
      to: EMAIL_RECIPIENT,
      subject: `New Comment from ${firstName || "Anonymous"} ${
        secondName || ""
      }`,
      html: `
        <h2>New Comment Submission</h2>
        <p><strong>First Name:</strong> ${firstName || "N/A"}</p>
        <p><strong>Second Name:</strong> ${secondName || "N/A"}</p>
        <p><strong>Phone:</strong> ${phone || "N/A"}</p>
        <p><strong>E-mail:</strong> ${email || "N/A"}</p>
        <p><strong>Comments:</strong><br>${
          commentsText || "No comments provided."
        }</p>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: %s", info.messageId);

    // Consider saving comments to a database for a persistent record.
    // E.g., const newComment = new Comment({ ... }); await newComment.save();

    res
      .status(200)
      .json({ success: true, message: "Comment submitted successfully!" });
  } catch (error) {
    console.error("Error sending email:", error);
    next(
      new APIError(
        "Failed to send comment. Please try again later.",
        500,
        error
      )
    );
  }
});

// --- Centralized Error Handling Middleware ---
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
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
  shutdown();
});

module.exports = app;
// Export the app for testing purposes
if (require.main === module) {
  // Only start the server if this file is run directly, not imported
  server.listen(PORT, () => {
    console.log(`[SERVER] Server is running on http://localhost:${PORT}`);
    console.log(
      `[SERVER] Environment: ${process.env.NODE_ENV || "development"}`
    );
    console.log(`[SERVER] M-Pesa Callback endpoint: ${MPESA_CALLBACK_URL}`);
    console.log(`[SERVER] M-Pesa API Base URL: ${MPESA_API_BASE_URL}`);
  });
} else {
  console.log("[SERVER] Server module loaded for testing.");
}
// This allows the server to be imported in tests without starting it immediately.
// You can use `require('./server')` in your test files to access the app instance.
